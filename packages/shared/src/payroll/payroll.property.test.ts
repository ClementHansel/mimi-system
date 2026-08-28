import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { compareMoney, isNegativeMoney } from '../money';
import { calculateBasePayslip, calculatePayroll, type BasePayrollInputs } from './index';

function moneyString(maxRupiah: number) {
  return fc.integer({ min: 0, max: maxRupiah }).map((n) => `${n}.00`);
}

function inputsArb() {
  return fc
    .record({
      baseSalary: moneyString(20_000_000),
      overtimeMinutesTotal: fc.integer({ min: 0, max: 3000 }),
      sickDays: fc.integer({ min: 0, max: 10 }),
      permissionDays: fc.integer({ min: 0, max: 10 }),
      absentDays: fc.integer({ min: 0, max: 10 }),
      lateMinutesTotal: fc.integer({ min: 0, max: 500 }),
      hasPerfectAttendance: fc.boolean(),
      sickPaid: fc.boolean(),
      permissionPaid: fc.boolean(),
      daysTakenThisYear: fc.integer({ min: 0, max: 20 }),
      loanOutstanding: moneyString(5_000_000),
      cashVariance: moneyString(500_000),
    })
    .map((r): BasePayrollInputs => ({
      employee: { joinDate: '2020-01-01' },
      periodEndDate: '2026-08-31',
      daysInMonth: 31,
      baseSalary: r.baseSalary,
      overtimeMinutesTotal: r.overtimeMinutesTotal,
      overtimeRatePerHour: '20000.00',
      attendance: {
        sickDays: r.sickDays,
        permissionDays: r.permissionDays,
        absentDays: r.absentDays,
        lateMinutesTotal: r.lateMinutesTotal,
        hasPerfectAttendance: r.hasPerfectAttendance,
      },
      sickPaid: r.sickPaid,
      permissionPaid: r.permissionPaid,
      perLateMinuteRate: '500.00',
      attendanceAllowanceAmount: '200000.00',
      leave: {
        annual: { daysTaken: r.daysTakenThisYear, quotaDays: 12 },
        marriage: { daysTaken: 0, quotaDays: 3 },
      },
      tenureTiers: [{ minYears: 3, amount: '100000.00' }],
      performanceIncentiveAmount: null,
      positionAllowanceAmount: null,
      otherEarningAmounts: [],
      stockShortfallShares: [],
      loans:
        r.loanOutstanding === '0.00'
          ? []
          : [{ loanId: 'loan-1', outstanding: r.loanOutstanding, monthlyInstallment: '500000.00' }],
      cashVarianceAmounts: r.cashVariance === '0.00' ? [] : [r.cashVariance],
      otherDeductionAmounts: [],
    }));
}

describe('property: statutory OFF ≡ base result', () => {
  it('calculatePayroll(inputs, false) is byte-identical to calculateBasePayslip(inputs), for any inputs', () => {
    fc.assert(
      fc.property(inputsArb(), (inputs) => {
        const base = calculateBasePayslip(inputs);
        const full = calculatePayroll(inputs, false);
        expect(full.gross).toBe(base.gross);
        expect(full.deductions).toBe(base.deductions);
        expect(full.net).toBe(base.net);
        expect(full.employerCost).toBe('0.00');
        expect(full.statutoryMode).toBe(false);
        expect(full.lines).toEqual(base.lines);
        expect(full.loanInstallmentsTaken).toEqual(base.loanInstallmentsTaken);
      }),
    );
  });
});

describe('property: never a negative net without an explicit deduction', () => {
  it('with all deduction-producing inputs at zero, net === gross exactly (never negative, never manufactured)', () => {
    fc.assert(
      fc.property(
        moneyString(20_000_000),
        fc.integer({ min: 0, max: 3000 }),
        (baseSalaryAmount, overtimeMinutes) => {
          const inputs: BasePayrollInputs = {
            employee: { joinDate: '2020-01-01' },
            periodEndDate: '2026-08-31',
            daysInMonth: 31,
            baseSalary: baseSalaryAmount,
            overtimeMinutesTotal: overtimeMinutes,
            overtimeRatePerHour: '20000.00',
            attendance: {
              sickDays: 0,
              permissionDays: 0,
              absentDays: 0,
              lateMinutesTotal: 0,
              hasPerfectAttendance: false,
            },
            sickPaid: true,
            permissionPaid: true,
            perLateMinuteRate: '500.00',
            attendanceAllowanceAmount: '0.00', // no perfect-attendance bonus either, to isolate the claim
            leave: {
              annual: { daysTaken: 0, quotaDays: 12 },
              marriage: { daysTaken: 0, quotaDays: 3 },
            },
            tenureTiers: [],
            performanceIncentiveAmount: null,
            positionAllowanceAmount: null,
            otherEarningAmounts: [],
            stockShortfallShares: [],
            loans: [],
            cashVarianceAmounts: [],
            otherDeductionAmounts: [],
          };
          const result = calculateBasePayslip(inputs);
          expect(result.deductions).toBe('0.00');
          expect(result.net).toBe(result.gross);
          expect(isNegativeMoney(result.net)).toBe(false);
        },
      ),
    );
  });

  it('net is never negative for any generated input set (clamped, per D-10/§ payroll contract)', () => {
    fc.assert(
      fc.property(inputsArb(), (inputs) => {
        const result = calculateBasePayslip(inputs);
        expect(isNegativeMoney(result.net)).toBe(false);
      }),
    );
  });
});

describe('property: monotonicity', () => {
  it('more overtime minutes never decreases gross', () => {
    fc.assert(
      fc.property(inputsArb(), fc.integer({ min: 1, max: 500 }), (inputs, extraMinutes) => {
        const before = calculateBasePayslip(inputs);
        const after = calculateBasePayslip({
          ...inputs,
          overtimeMinutesTotal: inputs.overtimeMinutesTotal + extraMinutes,
        });
        expect(compareMoney(after.gross, before.gross)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('more unpaid absence days never decreases total deductions', () => {
    fc.assert(
      fc.property(inputsArb(), fc.integer({ min: 1, max: 5 }), (inputs, extraAbsentDays) => {
        const before = calculateBasePayslip(inputs);
        const after = calculateBasePayslip({
          ...inputs,
          attendance: {
            ...inputs.attendance,
            absentDays: inputs.attendance.absentDays + extraAbsentDays,
          },
        });
        expect(compareMoney(after.deductions, before.deductions)).toBeGreaterThanOrEqual(0);
      }),
    );
  });

  it('a larger approved cash-variance proposal never decreases total deductions', () => {
    fc.assert(
      fc.property(inputsArb(), moneyString(200_000), (inputs, extra) => {
        const before = calculateBasePayslip(inputs);
        const after = calculateBasePayslip({
          ...inputs,
          cashVarianceAmounts: [...inputs.cashVarianceAmounts, extra],
        });
        expect(compareMoney(after.deductions, before.deductions)).toBeGreaterThanOrEqual(0);
      }),
    );
  });
});
