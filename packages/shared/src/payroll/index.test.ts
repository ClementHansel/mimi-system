import { describe, it, expect } from 'vitest';
import { PayrollComponentCode } from '../enums';
import { calculateBasePayslip, calculatePayroll, type BasePayrollInputs } from './index';

function baseInputs(overrides: Partial<BasePayrollInputs> = {}): BasePayrollInputs {
  return {
    employee: { joinDate: '2020-01-01' },
    periodEndDate: '2026-08-31',
    daysInMonth: 31,
    baseSalary: '4000000.00',
    overtimeMinutesTotal: 0,
    overtimeRatePerHour: '20000.00',
    attendance: {
      sickDays: 0,
      permissionDays: 0,
      absentDays: 0,
      lateMinutesTotal: 0,
      hasPerfectAttendance: true,
    },
    sickPaid: true,
    permissionPaid: false,
    perLateMinuteRate: '500.00',
    attendanceAllowanceAmount: '200000.00',
    leave: { daysTakenThisYear: 0, quotaDays: 12 },
    tenureTiers: [],
    performanceIncentiveAmount: null,
    positionAllowanceAmount: null,
    otherEarningAmounts: [],
    stockShortfallShares: [],
    loans: [],
    cashVarianceAmounts: [],
    otherDeductionAmounts: [],
    ...overrides,
  };
}

describe('calculateBasePayslip', () => {
  it('produces just the base salary + attendance allowance when everything else is quiet', () => {
    const result = calculateBasePayslip(baseInputs());
    expect(result.gross).toBe('4200000.00');
    expect(result.deductions).toBe('0.00');
    expect(result.net).toBe('4200000.00');
    const codes = result.lines.map((l) => l.componentCode);
    expect(codes).toContain(PayrollComponentCode.BASE_SALARY);
    expect(codes).toContain(PayrollComponentCode.ATTENDANCE_ALLOWANCE);
  });

  it('applies overtime, lateness, and absence together', () => {
    const result = calculateBasePayslip(
      baseInputs({
        overtimeMinutesTotal: 120,
        attendance: {
          sickDays: 0,
          permissionDays: 0,
          absentDays: 1,
          lateMinutesTotal: 30,
          hasPerfectAttendance: false,
        },
      }),
    );
    const dailyRate = '129032.26'; // 4,000,000 / 31 ceil
    expect(result.gross).toBe('4040000.00'); // base 4,000,000 + overtime 40,000 (2h * 20,000)
    expect(result.deductions).toBe((30 * 500 + Number(dailyRate)).toFixed(2)); // late 15,000 + 1 absent day
    expect(result.net).toBe((Number(result.gross) - Number(result.deductions)).toFixed(2));
  });

  it('caps a loan installment at the outstanding balance and records which loan/amount was taken', () => {
    const result = calculateBasePayslip(
      baseInputs({
        loans: [{ loanId: 'loan-1', outstanding: '150000.00', monthlyInstallment: '500000.00' }],
      }),
    );
    expect(result.loanInstallmentsTaken).toEqual([{ loanId: 'loan-1', amount: '150000.00' }]);
    expect(result.deductions).toBe('150000.00');
  });

  it('includes an approved cash-variance proposal as its own line (D-19)', () => {
    const result = calculateBasePayslip(baseInputs({ cashVarianceAmounts: ['75000.00'] }));
    const line = result.lines.find(
      (l) => l.componentCode === PayrollComponentCode.DEDUCTION_CASH_VARIANCE,
    );
    expect(line?.amount).toBe('75000.00');
    expect(line?.sourceRefType).toBe('cash_variance_proposal');
  });

  it('never produces a negative net: deductions exceeding gross clamp to zero', () => {
    const result = calculateBasePayslip(
      baseInputs({
        baseSalary: '100000.00',
        attendanceAllowanceAmount: '0.00',
        loans: [{ loanId: 'l', outstanding: '5000000.00', monthlyInstallment: '5000000.00' }],
      }),
    );
    expect(result.net).toBe('0.00');
  });
});

describe('calculatePayroll — statutory gate', () => {
  it('statutory OFF produces exactly the base result with employerCost 0.00', () => {
    const inputs = baseInputs({ overtimeMinutesTotal: 60 });
    const base = calculateBasePayslip(inputs);
    const full = calculatePayroll(inputs, false);
    expect(full.statutoryMode).toBe(false);
    expect(full.gross).toBe(base.gross);
    expect(full.deductions).toBe(base.deductions);
    expect(full.net).toBe(base.net);
    expect(full.employerCost).toBe('0.00');
    expect(full.lines).toEqual(base.lines);
  });

  it('throws if statutoryEnabled is true but no statutory inputs are supplied', () => {
    expect(() => calculatePayroll(baseInputs(), true)).toThrow(RangeError);
  });
});
