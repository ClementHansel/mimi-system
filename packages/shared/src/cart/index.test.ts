import { describe, it, expect } from 'vitest';
import {
  calculateCartSummary,
  calculateChange,
  calculateLineTotal,
  calculateOnlineOrderJournalSplit,
  calculateOnlineOrderNet,
  validateOnlineOrderNet,
} from './index';

describe('calculateLineTotal', () => {
  it('multiplies qty by unit price and subtracts the line discount', () => {
    expect(
      calculateLineTotal({
        productId: 'p1',
        unitPrice: '45000.00',
        qty: '3.000',
        discount: '0.00',
      }),
    ).toBe('135000.00');
    expect(
      calculateLineTotal({
        productId: 'p1',
        unitPrice: '45000.00',
        qty: '3.000',
        discount: '10000.00',
      }),
    ).toBe('125000.00');
  });

  it('floors at zero when the discount exceeds the line value', () => {
    expect(
      calculateLineTotal({
        productId: 'p1',
        unitPrice: '10000.00',
        qty: '1.000',
        discount: '50000.00',
      }),
    ).toBe('0.00');
  });
});

describe('calculateCartSummary', () => {
  it('sums line totals and applies the sale-level discount', () => {
    const summary = calculateCartSummary(
      [
        { productId: 'p1', unitPrice: '45000.00', qty: '2.000', discount: '0.00' },
        { productId: 'p2', unitPrice: '15000.00', qty: '1.000', discount: '0.00' },
      ],
      '5000.00',
    );
    expect(summary.subtotal).toBe('105000.00');
    expect(summary.total).toBe('100000.00');
  });

  it('never produces a negative total', () => {
    const summary = calculateCartSummary(
      [{ productId: 'p1', unitPrice: '1000.00', qty: '1.000', discount: '0.00' }],
      '999999.00',
    );
    expect(summary.total).toBe('0.00');
  });
});

describe('calculateChange', () => {
  it('computes cash change', () => {
    expect(calculateChange('100000.00', '85000.00')).toBe('15000.00');
  });

  it('is zero when paid equals or is less than the total (never negative)', () => {
    expect(calculateChange('85000.00', '85000.00')).toBe('0.00');
    expect(calculateChange('50000.00', '85000.00')).toBe('0.00');
  });
});

describe('GoFood/ShopeeFood net-received math (FR-POS-05/07)', () => {
  const amounts = {
    grossAmount: '100000.00',
    discountAmount: '5000.00',
    platformFee: '15000.00',
    otherFee: '0.00',
  };

  it('computes net = gross - discount - fees', () => {
    expect(calculateOnlineOrderNet(amounts)).toBe('80000.00');
  });

  it('validates a correct netReceived', () => {
    expect(validateOnlineOrderNet(amounts, '80000.00')).toEqual({ ok: true });
  });

  it('rejects an incorrect netReceived with ERR_NET_MISMATCH', () => {
    const result = validateOnlineOrderNet(amounts, '79999.00');
    expect(result).toMatchObject({ ok: false, code: 'ERR_NET_MISMATCH', expectedNet: '80000.00' });
  });

  it('splits the journal legs: net to platform receivable, fees+discount to commission expense', () => {
    const split = calculateOnlineOrderJournalSplit(amounts);
    expect(split.netLeg).toBe('80000.00');
    expect(split.feeLeg).toBe('20000.00');
  });
});
