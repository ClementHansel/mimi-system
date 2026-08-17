import { describe, it, expect } from 'vitest';
import { computeDiffQty, hasVariance, isLineReady, canSubmitOpname } from './opname-variance';

describe('computeDiffQty', () => {
  it('computes a positive surplus without floating point drift', () => {
    expect(computeDiffQty('10.000', '12.500')).toBe('2.5');
  });

  it('computes a negative shortage', () => {
    expect(computeDiffQty('12.500', '10.000')).toBe('-2.5');
  });

  it('returns zero (no sign) when counted matches system exactly', () => {
    expect(computeDiffQty('100.000', '100.000')).toBe('0');
  });

  it('handles the 3-decimal boundary precisely (the float-drift case)', () => {
    // 0.1 + 0.2 !== 0.3 in float64; this must not drift.
    expect(computeDiffQty('0.100', '0.300')).toBe('0.2');
  });

  it('handles large integer stock counts', () => {
    expect(computeDiffQty('1000000.000', '999999.500')).toBe('-0.5');
  });
});

describe('hasVariance', () => {
  it('is false for an exact zero diff', () => {
    expect(hasVariance('0')).toBe(false);
  });

  it('is true for any nonzero diff, positive or negative', () => {
    expect(hasVariance('0.001')).toBe(true);
    expect(hasVariance('-0.001')).toBe(true);
  });
});

describe('isLineReady / canSubmitOpname (the mandatory-reason gate, FR-SO-02)', () => {
  const base = { itemId: 'item-1', systemQty: '10.000' as const };

  it('a not-yet-counted line is ready (counting is per area, not all lines at once)', () => {
    expect(isLineReady({ ...base, countedQty: null, varianceReason: '' })).toBe(true);
  });

  it('a counted line with no variance needs no reason', () => {
    expect(isLineReady({ ...base, countedQty: '10.000', varianceReason: '' })).toBe(true);
  });

  it('a counted line WITH variance and no reason is NOT ready', () => {
    expect(isLineReady({ ...base, countedQty: '8.000', varianceReason: '' })).toBe(false);
  });

  it('a counted line with variance and a blank/whitespace-only reason is NOT ready', () => {
    expect(isLineReady({ ...base, countedQty: '8.000', varianceReason: '   ' })).toBe(false);
  });

  it('a counted line with variance and a real reason IS ready', () => {
    expect(isLineReady({ ...base, countedQty: '8.000', varianceReason: 'Kedaluwarsa, dibuang' })).toBe(true);
  });

  it('canSubmitOpname blocks submit while ANY line has an unexplained variance', () => {
    const lines = [
      { ...base, itemId: 'a', countedQty: '10.000', varianceReason: '' },
      { ...base, itemId: 'b', countedQty: '7.000', varianceReason: '' },
    ];
    expect(canSubmitOpname(lines)).toBe(false);
  });

  it('canSubmitOpname allows submit once every varying line has a reason', () => {
    const lines = [
      { ...base, itemId: 'a', countedQty: '10.000', varianceReason: '' },
      { ...base, itemId: 'b', countedQty: '7.000', varianceReason: 'Selisih hitung ulang' },
    ];
    expect(canSubmitOpname(lines)).toBe(true);
  });
});
