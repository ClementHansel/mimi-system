import { describe, it, expect } from 'vitest';
import {
  VOUCHER_CODE_ALPHABET,
  VOUCHER_CODE_BODY_LENGTH,
  VoucherStatus,
  VoucherType,
  checkVoucher,
  formatVoucherCode,
  isVoucherCode,
  normalizeVoucherCode,
  type VoucherCheckInput,
  type VoucherRules,
} from './index';

const RULES: VoucherRules = {
  type: VoucherType.Fixed,
  value: '10000.00',
  minSubtotal: '0.00',
  maxDiscount: null,
  validFrom: '2026-08-01',
  validUntil: '2026-08-31',
  locationIds: null,
};

function input(over: Partial<VoucherCheckInput> = {}): VoucherCheckInput {
  return {
    rules: RULES,
    status: VoucherStatus.Active,
    subtotal: '50000.00',
    businessDate: '2026-08-15',
    locationId: 'loc-1',
    ...over,
  };
}

describe('checkVoucher — the rules an offline till and the server must agree on', () => {
  it('takes a flat amount off the basket', () => {
    expect(checkVoucher(input())).toEqual({ ok: true, discount: '10000.00' });
  });

  it('takes a percentage of the subtotal without ever touching a float', () => {
    const result = checkVoucher(
      input({ rules: { ...RULES, type: VoucherType.Percentage, value: '10.00' } }),
    );
    expect(result).toEqual({ ok: true, discount: '5000.00' });
  });

  it('honours a percentage cap', () => {
    const result = checkVoucher(
      input({
        rules: {
          ...RULES,
          type: VoucherType.Percentage,
          value: '50.00',
          maxDiscount: '15000.00',
        },
      }),
    );
    expect(result).toEqual({ ok: true, discount: '15000.00' });
  });

  it('never discounts more than the basket — a voucher cannot make the till owe money', () => {
    const result = checkVoucher(input({ subtotal: '4000.00' }));
    expect(result).toEqual({ ok: true, discount: '4000.00' });
  });

  it('rounds a percentage half-up at the rupiah cent, like every other money path', () => {
    // 33.33% of 10.005 would be the classic float trap; the fixed-point path
    // must land on an exact 2-decimal Money string.
    const result = checkVoucher(
      input({
        subtotal: '33333.00',
        rules: { ...RULES, type: VoucherType.Percentage, value: '33.33' },
      }),
    );
    // 33333.00 × 0.3333 = 11109.8889 → 11109.89 half-up.
    expect(result).toEqual({ ok: true, discount: '11109.89' });
  });

  it.each([
    ['redeemed voucher', { status: VoucherStatus.Redeemed }, 'not_active'],
    ['voided voucher', { status: VoucherStatus.Void }, 'not_active'],
    ['before the window', { businessDate: '2026-07-31' }, 'not_started'],
    ['after the window', { businessDate: '2026-09-01' }, 'expired'],
  ] as const)('refuses %s', (_label, over, reason) => {
    expect(checkVoucher(input(over))).toEqual({ ok: false, reason });
  });

  it('refuses a basket below the minimum', () => {
    const result = checkVoucher(
      input({ subtotal: '9999.00', rules: { ...RULES, minSubtotal: '10000.00' } }),
    );
    expect(result).toEqual({ ok: false, reason: 'below_minimum' });
  });

  it('refuses an outlet the batch was not issued for, and allows one it was', () => {
    const scoped = { ...RULES, locationIds: ['loc-2', 'loc-3'] };
    expect(checkVoucher(input({ rules: scoped }))).toEqual({
      ok: false,
      reason: 'wrong_location',
    });
    expect(checkVoucher(input({ rules: scoped, locationId: 'loc-2' })).ok).toBe(true);
  });

  it('reports the most fundamental reason first — an expired coupon never says "spend more"', () => {
    // Both wrong: expired AND under the minimum. The customer must hear
    // "expired", or they add an item and are refused a second time.
    const result = checkVoucher(
      input({
        businessDate: '2026-09-05',
        subtotal: '1.00',
        rules: { ...RULES, minSubtotal: '10000.00' },
      }),
    );
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('rejects a percentage finer than the coupon could have been printed with', () => {
    expect(() =>
      checkVoucher(input({ rules: { ...RULES, type: VoucherType.Percentage, value: '10.001' } })),
    ).toThrow(/decimals/);
  });
});

describe('voucher codes', () => {
  it('draws from 32 symbols with none of the ones a human misreads', () => {
    expect(VOUCHER_CODE_ALPHABET).toHaveLength(32);
    for (const confusable of ['I', 'L', 'O', 'U']) {
      expect(VOUCHER_CODE_ALPHABET).not.toContain(confusable);
    }
  });

  it('formats indices as MC-XXXX-XXXX', () => {
    const code = formatVoucherCode([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(code).toBe('MC-0123-4567');
    expect(isVoucherCode(code)).toBe(true);
  });

  it('refuses to format the wrong number of symbols rather than pad silently', () => {
    expect(() => formatVoucherCode([1, 2, 3])).toThrow();
    expect(VOUCHER_CODE_BODY_LENGTH).toBe(8);
  });

  it.each([
    ['MC-0123-4567', 'MC-0123-4567'],
    ['mc-0123-4567', 'MC-0123-4567'],
    ['MC01234567', 'MC-0123-4567'],
    ['01234567', 'MC-0123-4567'],
    ['mc 0123 4567', 'MC-0123-4567'],
    // The three excluded letters map back to the digit they were misread as,
    // which is the entire reason they were excluded.
    ['MC-O123-456I', 'MC-0123-4561'],
    ['MC-L123-4567', 'MC-1123-4567'],
  ])('normalises what a cashier actually types: %s', (typed, expected) => {
    expect(normalizeVoucherCode(typed)).toBe(expected);
  });

  it('returns null for something that cannot be a code', () => {
    expect(normalizeVoucherCode('')).toBeNull();
    expect(normalizeVoucherCode('MC-0123')).toBeNull();
    expect(normalizeVoucherCode('MC-0123-45678')).toBeNull();
  });
});
