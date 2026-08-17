import { describe, it, expect } from 'vitest';
import {
  parseFixed,
  formatFixed,
  addFixed,
  subFixed,
  mulFixed,
  divFixed,
  rescale,
  compareFixed,
  isNegativeFixed,
} from './fixed-point';

describe('parseFixed / formatFixed', () => {
  it('round-trips a plain money string', () => {
    expect(formatFixed(parseFixed('125000.00', 2), 2)).toBe('125000.00');
  });

  it('round-trips a negative value', () => {
    expect(formatFixed(parseFixed('-18.0', 1), 1)).toBe('-18.0');
  });

  it('round-trips zero without a stray sign', () => {
    expect(formatFixed(parseFixed('-0.00', 2), 2)).toBe('0.00');
    expect(formatFixed(parseFixed('0', 2), 2)).toBe('0.00');
  });

  it('pads a short fractional part to the field scale', () => {
    expect(formatFixed(parseFixed('12.5', 3), 3)).toBe('12.500');
  });

  it('rejects more fractional digits than the field scale', () => {
    expect(() => parseFixed('12.5001', 3)).toThrow(RangeError);
  });

  it('rejects garbage input', () => {
    expect(() => parseFixed('12,000', 2)).toThrow(RangeError);
    expect(() => parseFixed('abc', 2)).toThrow(RangeError);
    expect(() => parseFixed('1e5', 2)).toThrow(RangeError);
  });

  it('formats an integer-scale value with no dot', () => {
    expect(formatFixed(42n, 0)).toBe('42');
  });
});

describe('add / sub', () => {
  it('adds and subtracts exactly, no float drift', () => {
    const a = parseFixed('0.10', 2);
    const b = parseFixed('0.20', 2);
    expect(formatFixed(addFixed(a, b), 2)).toBe('0.30');
    expect(formatFixed(subFixed(b, a), 2)).toBe('0.10');
  });
});

describe('rescale', () => {
  it('half_up rounds .5 away from zero', () => {
    // 1.005 at scale 3 -> scale 2
    expect(formatFixed(rescale(parseFixed('1.005', 3), 3, 2, 'half_up'), 2)).toBe('1.01');
    expect(formatFixed(rescale(parseFixed('-1.005', 3), 3, 2, 'half_up'), 2)).toBe('-1.01');
  });

  it('floor always rounds toward negative infinity', () => {
    expect(formatFixed(rescale(parseFixed('1.29', 2), 2, 1, 'floor'), 1)).toBe('1.2');
    expect(formatFixed(rescale(parseFixed('-1.21', 2), 2, 1, 'floor'), 1)).toBe('-1.3');
  });

  it('ceil always rounds toward positive infinity', () => {
    expect(formatFixed(rescale(parseFixed('1.21', 2), 2, 1, 'ceil'), 1)).toBe('1.3');
    expect(formatFixed(rescale(parseFixed('-1.29', 2), 2, 1, 'ceil'), 1)).toBe('-1.2');
  });

  it('upscaling never rounds', () => {
    expect(formatFixed(rescale(parseFixed('1.2', 1), 1, 4), 4)).toBe('1.2000');
  });
});

describe('mulFixed', () => {
  it('multiplies a Money by a Qty and rounds to Money scale', () => {
    // 12500.55 * 3.333 = 41664.33315 -> half-up at 2dp = 41664.33 (money scale 2, qty scale 3)
    const price = parseFixed('12500.55', 2);
    const qty = parseFixed('3.333', 3);
    const total = mulFixed(price, 2, qty, 3, 2, 'half_up');
    expect(formatFixed(total, 2)).toBe('41664.33');
  });

  it('multiplying by zero qty gives zero', () => {
    const price = parseFixed('999.99', 2);
    const qty = parseFixed('0.000', 3);
    expect(formatFixed(mulFixed(price, 2, qty, 3, 2), 2)).toBe('0.00');
  });
});

describe('divFixed', () => {
  it('divides two Money values into a rate', () => {
    const total = parseFixed('100.00', 2);
    const parts = parseFixed('3.00', 2);
    // 100/3 = 33.3333... -> half_up at scale 4
    expect(formatFixed(divFixed(total, 2, parts, 2, 4, 'half_up'), 4)).toBe('33.3333');
  });

  it('throws on division by zero', () => {
    expect(() => divFixed(parseFixed('1.00', 2), 2, 0n, 2, 2)).toThrow(RangeError);
  });
});

describe('compareFixed / isNegativeFixed', () => {
  it('orders values correctly regardless of sign', () => {
    expect(compareFixed(parseFixed('-1.00', 2), parseFixed('1.00', 2))).toBe(-1);
    expect(compareFixed(parseFixed('1.00', 2), parseFixed('1.00', 2))).toBe(0);
    expect(isNegativeFixed(parseFixed('-0.01', 2))).toBe(true);
    expect(isNegativeFixed(parseFixed('0.00', 2))).toBe(false);
  });
});
