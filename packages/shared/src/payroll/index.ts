/**
 * Payroll run aggregation — composes the PIN/POUT component functions
 * (`./components`) and, when enabled, the D-18 statutory layer (`./statutory`)
 * into a full payslip. This is the pure core of what M15's
 * `POST /payroll/periods/:id/calculate` calls per employee; the module
 * fetches attendance/loan/opname rows and passes them in as plain data.
 */
import { PayrollComponentCode, PayrollComponentType } from '../enums';
import { addMoney, clampMoneyToZero, isZeroMoney, subMoney, sumMoney, ZERO_MONEY } from '../money';
import type { ISODate, Money, Qty } from '../types';
import {
  attendanceAllowance,
  baseSalary,
  dailyRateFromMonthlySalary,
  deductionAbsence,
  deductionCashVariance,
  deductionLate,
  deductionLeaveExcess,
  deductionPermission,
  deductionSick,
  deductionStockShortfall,
  loanInstallment,
  otherDeductions,
  otherEarnings,
  overtimePay,
  performanceIncentive,
  positionAllowance,
  tenureAllowance,
  type TenureTier,
} from './components';
import {
  calculateStatutoryLines,
  type StatutoryCalculationInputs,
  type StatutoryLineResult,
} from './statutory';

export interface PayslipLine {
  componentCode: PayrollComponentCode;
  type: PayrollComponentType;
  isStatutory: boolean;
  qty: Qty | null;
  rate: Money | null;
  amount: Money;
  sourceRefType: string | null;
}

export interface BasePayrollInputs {
  employee: { joinDate: ISODate };
  periodEndDate: ISODate;
  daysInMonth: number;
  baseSalary: Money;

  overtimeMinutesTotal: number;
  overtimeRatePerHour: Money;

  attendance: {
    sickDays: number;
    permissionDays: number;
    absentDays: number;
    lateMinutesTotal: number;
    hasPerfectAttendance: boolean;
  };
  sickPaid: boolean;
  permissionPaid: boolean;
  perLateMinuteRate: Money;
  attendanceAllowanceAmount: Money;

  leave: { daysTakenThisYear: number; quotaDays: number };

  tenureTiers: readonly TenureTier[];
  performanceIncentiveAmount: Money | null;
  positionAllowanceAmount: Money | null;
  otherEarningAmounts: readonly Money[];

  /** Already-apportioned per-employee shares of approved opname shortfalls (POUT-05). */
  stockShortfallShares: readonly Money[];
  /** Active loans, each with its outstanding balance and fixed installment (POUT-06). */
  loans: readonly { loanId: string; outstanding: Money; monthlyInstallment: Money }[];
  /** Approved-but-unconsumed cash-variance proposals for this employee (D-19 / Amendment 2). */
  cashVarianceAmounts: readonly Money[];
  otherDeductionAmounts: readonly Money[];
}

export interface PayrollCalculationResult {
  statutoryMode: boolean;
  lines: PayslipLine[];
  gross: Money;
  deductions: Money;
  employerCost: Money;
  net: Money;
  /** Loan ids paired with the installment amount actually taken this run — feeds `employee_loan_payments`. */
  loanInstallmentsTaken: { loanId: string; amount: Money }[];
}

function earningLine(
  code: PayrollComponentCode,
  amount: Money,
  extra?: Partial<Pick<PayslipLine, 'qty' | 'rate' | 'sourceRefType'>>,
): PayslipLine {
  return {
    componentCode: code,
    type: PayrollComponentType.EARNING,
    isStatutory: false,
    qty: extra?.qty ?? null,
    rate: extra?.rate ?? null,
    amount,
    sourceRefType: extra?.sourceRefType ?? null,
  };
}

function deductionLine(
  code: PayrollComponentCode,
  amount: Money,
  extra?: Partial<Pick<PayslipLine, 'qty' | 'rate' | 'sourceRefType'>>,
): PayslipLine {
  return {
    componentCode: code,
    type: PayrollComponentType.DEDUCTION,
    isStatutory: false,
    qty: extra?.qty ?? null,
    rate: extra?.rate ?? null,
    amount,
    sourceRefType: extra?.sourceRefType ?? null,
  };
}

/**
 * Computes the PRD BASE payslip (7 PIN + 9 POUT-family lines; zero statutory
 * lines). This is the "statutory OFF" result — `calculatePayroll` below must
 * produce byte-identical `gross`/`deductions`/`net`/base lines when the
 * statutory flag is off (the property test in `payroll.property.test.ts`
 * pins this equivalence).
 */
export function calculateBasePayslip(inputs: BasePayrollInputs): {
  lines: PayslipLine[];
  gross: Money;
  deductions: Money;
  net: Money;
  loanInstallmentsTaken: { loanId: string; amount: Money }[];
} {
  const lines: PayslipLine[] = [];

  // PIN-01..07
  lines.push(earningLine(PayrollComponentCode.BASE_SALARY, baseSalary(inputs.baseSalary)));
  const overtime = overtimePay(inputs.overtimeMinutesTotal, inputs.overtimeRatePerHour);
  if (!isZero(overtime)) {
    lines.push(
      earningLine(PayrollComponentCode.OVERTIME, overtime, {
        qty: (inputs.overtimeMinutesTotal / 60).toFixed(3),
        rate: inputs.overtimeRatePerHour,
      }),
    );
  }
  const attAllowance = attendanceAllowance(
    inputs.attendance.hasPerfectAttendance,
    inputs.attendanceAllowanceAmount,
  );
  if (!isZero(attAllowance))
    lines.push(earningLine(PayrollComponentCode.ATTENDANCE_ALLOWANCE, attAllowance));

  const incentive = performanceIncentive(inputs.performanceIncentiveAmount);
  if (!isZero(incentive))
    lines.push(earningLine(PayrollComponentCode.PERFORMANCE_INCENTIVE, incentive));

  const tenure = tenureAllowance(
    inputs.employee.joinDate,
    inputs.periodEndDate,
    inputs.tenureTiers,
  );
  if (!isZero(tenure)) lines.push(earningLine(PayrollComponentCode.TENURE_ALLOWANCE, tenure));

  const position = positionAllowance(inputs.positionAllowanceAmount);
  if (!isZero(position)) lines.push(earningLine(PayrollComponentCode.POSITION_ALLOWANCE, position));

  const other = otherEarnings(inputs.otherEarningAmounts);
  if (!isZero(other)) lines.push(earningLine(PayrollComponentCode.OTHER_EARNING, other));

  // POUT-01..09 (POUT-08 is a data-source note, not its own component — Appendix A-6)
  const dailyRate = dailyRateOf(inputs);
  const sick = deductionSick(inputs.attendance.sickDays, dailyRate, inputs.sickPaid);
  if (!isZero(sick))
    lines.push(
      deductionLine(PayrollComponentCode.DEDUCTION_SICK, sick, {
        qty: String(inputs.attendance.sickDays),
      }),
    );

  const permission = deductionPermission(
    inputs.attendance.permissionDays,
    dailyRate,
    inputs.permissionPaid,
  );
  if (!isZero(permission)) {
    lines.push(
      deductionLine(PayrollComponentCode.DEDUCTION_PERMISSION, permission, {
        qty: String(inputs.attendance.permissionDays),
      }),
    );
  }

  const absence = deductionAbsence(inputs.attendance.absentDays, dailyRate);
  if (!isZero(absence))
    lines.push(
      deductionLine(PayrollComponentCode.DEDUCTION_ABSENCE, absence, {
        qty: String(inputs.attendance.absentDays),
      }),
    );

  const leaveExcess = deductionLeaveExcess(
    inputs.leave.daysTakenThisYear,
    inputs.leave.quotaDays,
    dailyRate,
  );
  if (!isZero(leaveExcess))
    lines.push(deductionLine(PayrollComponentCode.DEDUCTION_LEAVE_EXCESS, leaveExcess));

  const shortfall = deductionStockShortfall(sumMoney([...inputs.stockShortfallShares]));
  if (!isZero(shortfall))
    lines.push(
      deductionLine(PayrollComponentCode.DEDUCTION_STOCK_SHORTFALL, shortfall, {
        sourceRefType: 'stock_opname',
      }),
    );

  const loanInstallmentsTaken: { loanId: string; amount: Money }[] = [];
  let loanTotal = ZERO_MONEY;
  for (const loan of inputs.loans) {
    const amount = loanInstallment(loan.outstanding, loan.monthlyInstallment);
    if (!isZero(amount)) {
      loanTotal = addMoney(loanTotal, amount);
      loanInstallmentsTaken.push({ loanId: loan.loanId, amount });
    }
  }
  if (!isZero(loanTotal))
    lines.push(
      deductionLine(PayrollComponentCode.DEDUCTION_LOAN_INSTALLMENT, loanTotal, {
        sourceRefType: 'employee_loan',
      }),
    );

  const late = deductionLate(inputs.attendance.lateMinutesTotal, inputs.perLateMinuteRate);
  if (!isZero(late))
    lines.push(
      deductionLine(PayrollComponentCode.DEDUCTION_LATE, late, {
        qty: String(inputs.attendance.lateMinutesTotal),
        rate: inputs.perLateMinuteRate,
      }),
    );

  const otherDed = otherDeductions(inputs.otherDeductionAmounts);
  if (!isZero(otherDed)) lines.push(deductionLine(PayrollComponentCode.OTHER_DEDUCTION, otherDed));

  const cashVariance = deductionCashVariance(inputs.cashVarianceAmounts);
  if (!isZero(cashVariance))
    lines.push(
      deductionLine(PayrollComponentCode.DEDUCTION_CASH_VARIANCE, cashVariance, {
        sourceRefType: 'cash_variance_proposal',
      }),
    );

  const gross = sumMoney(
    lines.filter((l) => l.type === PayrollComponentType.EARNING).map((l) => l.amount),
  );
  const deductions = sumMoney(
    lines.filter((l) => l.type === PayrollComponentType.DEDUCTION).map((l) => l.amount),
  );
  const net = clampMoneyToZero(subMoney(gross, deductions));

  return { lines, gross, deductions, net, loanInstallmentsTaken };
}

/**
 * Full payroll calculation. `statutoryEnabled` is the ONE gate for the D-18
 * layer: when `false`, `statutoryInputs` is ignored entirely and the result
 * is exactly `calculateBasePayslip`'s output with `employerCost = "0.00"` —
 * this equivalence is a property test (`statutoryOff ≡ base result`), not a
 * spot check, because it is the guarantee D-18 depends on.
 */
export function calculatePayroll(
  base: BasePayrollInputs,
  statutoryEnabled: boolean,
  statutoryInputs?: StatutoryCalculationInputs,
): PayrollCalculationResult {
  const baseResult = calculateBasePayslip(base);

  if (!statutoryEnabled) {
    return {
      statutoryMode: false,
      lines: baseResult.lines,
      gross: baseResult.gross,
      deductions: baseResult.deductions,
      employerCost: ZERO_MONEY,
      net: baseResult.net,
      loanInstallmentsTaken: baseResult.loanInstallmentsTaken,
    };
  }

  if (!statutoryInputs) {
    throw new RangeError('statutoryInputs is required when statutoryEnabled is true');
  }

  const statutoryLines = calculateStatutoryLines(statutoryInputs);
  const statutoryDeductionTotal = sumMoney(
    statutoryLines.filter((l) => l.type === PayrollComponentType.DEDUCTION).map((l) => l.amount),
  );
  const employerCost = sumMoney(
    statutoryLines
      .filter((l) => l.type === PayrollComponentType.EMPLOYER_COST)
      .map((l) => l.amount),
  );

  const deductions = addMoney(baseResult.deductions, statutoryDeductionTotal);
  const net = clampMoneyToZero(subMoney(baseResult.gross, deductions));

  return {
    statutoryMode: true,
    lines: [...baseResult.lines, ...statutoryLines.map(toPayslipLine)],
    gross: baseResult.gross,
    deductions,
    employerCost,
    net,
    loanInstallmentsTaken: baseResult.loanInstallmentsTaken,
  };
}

function toPayslipLine(l: StatutoryLineResult): PayslipLine {
  return {
    componentCode: l.componentCode,
    type: l.type,
    isStatutory: true,
    qty: null,
    rate: l.ratePct,
    amount: l.amount,
    sourceRefType: 'statutory',
  };
}

function isZero(amount: Money): boolean {
  return isZeroMoney(amount);
}

function dailyRateOf(inputs: BasePayrollInputs): Money {
  return dailyRateFromMonthlySalary(inputs.baseSalary, inputs.daysInMonth);
}

export * from './components';
export * from './statutory';
