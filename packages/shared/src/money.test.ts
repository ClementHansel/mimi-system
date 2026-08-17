import { describe, it, expect } from 'vitest';
import {
  addMoney,
  subMoney,
  sumMoney,
  compareMoney,
  isZeroMoney,
  isNegativeMoney,
  clampMoneyToZero,
  mulMoneyByQty,
  mulMoneyByRate,
  divMoney,
  splitMoneyEvenly,
  minMoney,
  maxMoney,
  ZERO_MONEY,
} from './money';

describe('Money basic arithmetic', () => {
  it('adds and subtracts without float drift', () => {
    // The classic float trap: 0.1 + 0.2 !== 0.3 in IEEE754. Money must not have this bug.
    expect(addMoney('1000.10', '2000.20')).toBe('3000.30');
    expect(subMoney('3000.30', '2000.20')).toBe('1000.10');
  });

  it('sums a list of amounts', () => {
    expect(sumMoney(['100.00', '250.50', '-50.50'])).toBe('300.00');
    expect(sumMoney([])).toBe(ZERO_MONEY);
  });

  it('compares amounts', () => {
    expect(compareMoney('100.00', '99.99')).toBe(1);
    expect(compareMoney('99.99', '100.00')).toBe(-1);
    expect(compareMoney('100.00', '100.00')).toBe(0);
  });

  it('recognizes zero and negative amounts', () => {
    expect(isZeroMoney('0.00')).toBe(true);
    expect(isZeroMoney('-0.00')).toBe(true);
    expect(isNegativeMoney('-0.01')).toBe(true);
    expect(isNegativeMoney('0.00')).toBe(false);
  });

  it('clamps negative totals to zero', () => {
    expect(clampMoneyToZero('-500.00')).toBe('0.00');
    expect(clampMoneyToZero('500.00')).toBe('500.00');
  });

  it('picks min/max', () => {
    expect(minMoney('10.00', '20.00')).toBe('10.00');
    expect(maxMoney('10.00', '20.00')).toBe('20.00');
  });
});

describe('Money × Qty line totals', () => {
  it('computes a POS line total', () => {
    // 3 ekor ayam @ 45000.00 = 135000.00
    expect(mulMoneyByQty('45000.00', '3.000')).toBe('135000.00');
  });

  it('rounds half-up at the money boundary', () => {
    // 0.03 * 2.500 = 0.075 -> half-up at 2dp = 0.08
    expect(mulMoneyByQty('0.03', '2.500')).toBe('0.08');
  });
});

describe('mulMoneyByRate (PPN / service charge)', () => {
  it('applies an 11% PPN', () => {
    expect(mulMoneyByRate('100000.00', '0.11')).toBe('11000.00');
  });

  it('applies a 5% service charge', () => {
    expect(mulMoneyByRate('50000.00', '0.05')).toBe('2500.00');
  });
});

describe('divMoney', () => {
  it('computes a per-unit rate at extra precision', () => {
    expect(divMoney('100.00', '3.00', 4)).toBe('33.3333');
  });
});

describe('splitMoneyEvenly', () => {
  it('splits without losing or gaining a cent', () => {
    const shares = splitMoneyEvenly('100.00', 3);
    expect(shares).toEqual(['33.34', '33.33', '33.33']);
    expect(sumMoney(shares)).toBe('100.00');
  });

  it('splits a negative amount (refund) without drift', () => {
    const shares = splitMoneyEvenly('-100.00', 3);
    expect(sumMoney(shares)).toBe('-100.00');
  });

  it('handles an exact division', () => {
    expect(splitMoneyEvenly('90.00', 3)).toEqual(['30.00', '30.00', '30.00']);
  });

  it('rejects a non-positive part count', () => {
    expect(() => splitMoneyEvenly('10.00', 0)).toThrow(RangeError);
  });
});
