import { describe, it, expect } from 'vitest';
import { compareMoney as sharedCompareMoney } from '@mimi/shared';
import { compareMoney, moneySharePct } from './money';

/**
 * `moneySharePct` is what the dashboard's Sales and Marketing tabs use for
 * every "% of gross" figure (discount rate, platform-fee rate, a channel's
 * contribution). `sumMoney`/`moneyEquals`/`isZeroMoney` are covered by
 * `components/finance/lib/money.test.ts`, which predates the move to `lib/`
 * and still exercises them through the re-export.
 *
 * The zero-denominator case is the reason this function exists at all rather
 * than a division at each call site: a period with no sales has no discount
 * RATE, and rendering `0,0%` for it asserts something the data does not say.
 * `null` forces the caller to decide, and every caller renders an em dash.
 */
describe('moneySharePct', () => {
  it('computes a whole percentage', () => {
    expect(moneySharePct('25000.00', '100000.00')).toBe(25);
  });

  it('keeps four decimals of ratio precision on a fractional share', () => {
    expect(moneySharePct('1.00', '3.00')).toBeCloseTo(33.3333, 4);
  });

  it('does not drift on a nine-figure gross (the float trap this guards)', () => {
    // 0.1% of 987,654,321.00 — a float ratio here loses the trailing digits.
    expect(moneySharePct('987654.32', '987654321.00')).toBeCloseTo(0.1, 4);
  });

  it('returns null — never 0 — when the denominator is zero', () => {
    expect(moneySharePct('0.00', '0.00')).toBeNull();
    expect(moneySharePct('500.00', '0.00')).toBeNull();
  });

  it('treats a blank/absent denominator as zero, so it is also null', () => {
    expect(moneySharePct('500.00', '')).toBeNull();
    expect(moneySharePct('500.00', null)).toBeNull();
    expect(moneySharePct('500.00', undefined)).toBeNull();
  });

  it('treats a blank/absent numerator as zero against a real denominator', () => {
    expect(moneySharePct(null, '100000.00')).toBe(0);
    expect(moneySharePct('', '100000.00')).toBe(0);
  });

  it('carries the sign through — a refund-heavy day reads negative, not absolute', () => {
    expect(moneySharePct('-25000.00', '100000.00')).toBe(-25);
  });

  it('handles a share above 100% rather than clamping it', () => {
    // Discount can exceed gross on a heavily-voided day; clamping would hide
    // exactly the anomaly a reader opened the report to find.
    expect(moneySharePct('150000.00', '100000.00')).toBe(150);
  });
});

describe('compareMoney', () => {
  it('sorts ascending as a comparator, without float compare', () => {
    const sorted = ['0.30', '0.10', '0.20'].sort((a, b) => compareMoney(a, b));
    expect(sorted).toEqual(['0.10', '0.20', '0.30']);
  });

  it('sorts descending when the arguments are swapped', () => {
    const sorted = ['100.00', '999999999.99', '0.01'].sort((a, b) => compareMoney(b, a));
    expect(sorted).toEqual(['999999999.99', '100.00', '0.01']);
  });

  it('treats "0" and "0.00" as equal, and blank/absent as zero', () => {
    expect(compareMoney('0', '0.00')).toBe(0);
    expect(compareMoney('', '0.00')).toBe(0);
    expect(compareMoney(null, '0.00')).toBe(0);
    expect(compareMoney(undefined, '-0.01')).toBe(1);
  });

  it('orders negatives below zero (a refund row sorts last, not first)', () => {
    expect(compareMoney('-5.00', '0.00')).toBe(-1);
    expect(compareMoney('-5.00', '-10.00')).toBe(1);
  });

  /**
   * The header of `money.ts` claims this wrapper "agrees by construction" with
   * `@mimi/shared`'s canonical comparator — the one the voucher and GL
   * calculators use. That claim is what makes it safe for a UI table sort to be
   * described as ordering rows "exactly as the server would", so it is proven
   * here rather than trusted. Only non-blank inputs are compared: the shared
   * signature requires a real `Money`, and the null-tolerance is precisely the
   * part this wrapper adds on top.
   */
  it('agrees with the canonical @mimi/shared comparator on every real Money pair', () => {
    const values = ['0.00', '0.01', '0.10', '0.20', '1.00', '-5.00', '999999999.99', '12345.67'];
    for (const a of values) {
      for (const b of values) {
        expect(Math.sign(compareMoney(a, b))).toBe(sharedCompareMoney(a, b));
      }
    }
  });
});
