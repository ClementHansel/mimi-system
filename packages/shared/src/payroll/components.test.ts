import { describe, it, expect } from 'vitest';
import {
  attendanceAllowance,
  dailyRateFromMonthlySalary,
  deductionAbsence,
  deductionCashVariance,
  deductionLate,
  deductionLeaveExcess,
  deductionPermission,
  deductionSick,
  loanInstallment,
  loanOutstandingAfter,
  overtimePay,
  tenureAllowance,
  yearsOfService,
  splitStockShortfallEvenly,
} from './components';
import { sumMoney } from '../money';

describe('dailyRateFromMonthlySalary', () => {
  it('rounds up so a daily-rate deduction never understates a day of pay', () => {
    // 4,000,000.00 / 31 = 129,032.258... -> ceil to 129,032.26
    expect(dailyRateFromMonthlySalary('4000000.00', 31)).toBe('129032.26');
  });

  it('divides evenly when it divides evenly', () => {
    expect(dailyRateFromMonthlySalary('3000000.00', 30)).toBe('100000.00');
  });

  it('rejects a non-positive day count', () => {
    expect(() => dailyRateFromMonthlySalary('1000.00', 0)).toThrow(RangeError);
  });
});

describe('PIN-02 overtimePay', () => {
  it('computes pay for a fractional-hour overtime total', () => {
    expect(overtimePay(90, '20000.00')).toBe('30000.00'); // 1.5h * 20000
  });

  it('is zero for zero or negative minutes', () => {
    expect(overtimePay(0, '20000.00')).toBe('0.00');
    expect(overtimePay(-5, '20000.00')).toBe('0.00');
  });
});

describe('PIN-03 attendanceAllowance', () => {
  it('pays the flat bonus only on perfect attendance', () => {
    expect(attendanceAllowance(true, '200000.00')).toBe('200000.00');
    expect(attendanceAllowance(false, '200000.00')).toBe('0.00');
  });
});

describe('PIN-05 tenure allowance', () => {
  it('computes full years of service, respecting the anniversary boundary', () => {
    expect(yearsOfService('2020-08-17', '2026-08-16')).toBe(5); // one day before the 6th anniversary
    expect(yearsOfService('2020-08-17', '2026-08-17')).toBe(6); // exactly the 6th anniversary
  });

  it('picks the highest matching tier', () => {
    const tiers = [
      { minYears: 0, amount: '0.00' },
      { minYears: 3, amount: '100000.00' },
      { minYears: 5, amount: '250000.00' },
    ];
    expect(tenureAllowance('2020-08-17', '2026-08-17', tiers)).toBe('250000.00');
    expect(tenureAllowance('2022-01-01', '2026-08-17', tiers)).toBe('100000.00'); // 4 full years -> tier minYears:3
    expect(tenureAllowance('2026-06-01', '2026-08-17', tiers)).toBe('0.00');
  });
});

describe('POUT-01/02 sick & permission (paid-flag gating)', () => {
  it('sick is free when sickPaid is true', () => {
    expect(deductionSick(3, '100000.00', true)).toBe('0.00');
    expect(deductionSick(3, '100000.00', false)).toBe('300000.00');
  });

  it('permission is free when permissionPaid is true', () => {
    expect(deductionPermission(2, '100000.00', true)).toBe('0.00');
    expect(deductionPermission(2, '100000.00', false)).toBe('200000.00');
  });
});

describe('POUT-03 absence (alpha) — always deducted', () => {
  it('has no paid variant', () => {
    expect(deductionAbsence(1, '100000.00')).toBe('100000.00');
    expect(deductionAbsence(0, '100000.00')).toBe('0.00');
  });
});

describe('POUT-04 leave excess', () => {
  it('deducts only days beyond the quota', () => {
    expect(deductionLeaveExcess(15, 12, '100000.00')).toBe('300000.00');
    expect(deductionLeaveExcess(10, 12, '100000.00')).toBe('0.00');
  });
});

describe('POUT-06 loan installment amortization', () => {
  it('takes the fixed installment while outstanding exceeds it', () => {
    expect(loanInstallment('5000000.00', '500000.00')).toBe('500000.00');
  });

  it('caps the final installment at the remaining balance', () => {
    expect(loanInstallment('300000.00', '500000.00')).toBe('300000.00');
  });

  it('amortizes to exactly zero over several periods', () => {
    let outstanding = '1000000.00';
    const installment = '300000.00';
    const taken: string[] = [];
    for (let i = 0; i < 10 && outstanding !== '0.00'; i++) {
      const amount = loanInstallment(outstanding, installment);
      taken.push(amount);
      outstanding = loanOutstandingAfter(outstanding, amount);
    }
    expect(outstanding).toBe('0.00');
    expect(taken).toEqual(['300000.00', '300000.00', '300000.00', '100000.00']);
  });
});

describe('POUT-07 late deduction', () => {
  it('multiplies accumulated late minutes by the per-minute rate', () => {
    expect(deductionLate(45, '500.00')).toBe('22500.00');
    expect(deductionLate(0, '500.00')).toBe('0.00');
  });
});

describe('D-19 cash variance deduction', () => {
  it('sums every approved proposal for the period', () => {
    expect(deductionCashVariance(['50000.00', '25000.00'])).toBe('75000.00');
    expect(deductionCashVariance([])).toBe('0.00');
  });
});

describe('splitStockShortfallEvenly (POUT-05 split rule)', () => {
  it('splits a shortfall value cent-exactly among the on-shift staff', () => {
    const shares = splitStockShortfallEvenly('100000.00', 3);
    expect(shares).toHaveLength(3);
    expect(sumMoney(shares)).toBe('100000.00');
  });
});
