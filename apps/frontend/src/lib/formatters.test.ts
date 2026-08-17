import { describe, it, expect } from 'vitest';
import {
  formatMoney,
  parseMoneyInput,
  formatQty,
  parseQtyInput,
  formatTemp,
  parseTempInput,
  formatNumber,
} from './formatters';

describe('formatMoney', () => {
  it('formats a whole-Rupiah decimal string with thousands grouping', () => {
    expect(formatMoney('125000.00')).toBe('Rp125.000');
  });

  it('hides .00 cents by default (auto) but shows a non-zero fraction', () => {
    expect(formatMoney('1500.00', { cents: 'auto' })).toBe('Rp1.500');
    expect(formatMoney('1500.50', { cents: 'auto' })).toBe('Rp1.500,50');
  });

  it('respects cents: "always" and "never"', () => {
    expect(formatMoney('1500.00', { cents: 'always' })).toBe('Rp1.500,00');
    expect(formatMoney('1500.50', { cents: 'never' })).toBe('Rp1.500');
  });

  it('handles negative amounts (void/refund reversals)', () => {
    expect(formatMoney('-25000.00')).toBe('-Rp25.000');
  });

  it('never round-trips through a JS float — large NUMERIC(18,2) values stay exact', () => {
    // 2^53 - 1 would already lose precision through Number(); this must not.
    expect(formatMoney('9007199254740993.00')).toBe('Rp9.007.199.254.740.993');
  });

  it('returns an em dash for null/undefined/empty', () => {
    expect(formatMoney(null)).toBe('—');
    expect(formatMoney(undefined)).toBe('—');
    expect(formatMoney('')).toBe('—');
  });

  it('can omit the Rp symbol', () => {
    expect(formatMoney('1000.00', { withSymbol: false })).toBe('1.000');
  });
});

describe('parseMoneyInput', () => {
  it('parses grouped id-ID input back to the canonical decimal string', () => {
    expect(parseMoneyInput('125.000')).toBe('125000.00');
  });

  it('parses a bare digit string', () => {
    expect(parseMoneyInput('125000')).toBe('125000.00');
  });

  it('strips leading zeros', () => {
    expect(parseMoneyInput('0125000')).toBe('125000.00');
  });

  it('round-trips through formatMoney', () => {
    const parsed = parseMoneyInput('45.000');
    expect(formatMoney(parsed)).toBe('Rp45.000');
  });

  it('returns null for empty input', () => {
    expect(parseMoneyInput('')).toBeNull();
    expect(parseMoneyInput('   ')).toBeNull();
  });

  it('preserves a leading minus', () => {
    expect(parseMoneyInput('-10.000')).toBe('-10000.00');
  });
});

describe('formatQty / parseQtyInput', () => {
  it('formats with id-ID comma decimal and trims trailing zeros', () => {
    expect(formatQty('12.500', 'kg')).toBe('12,5 kg');
    expect(formatQty('12.000', 'kg')).toBe('12 kg');
  });

  it('parses comma or period decimal input to the canonical period-decimal string', () => {
    expect(parseQtyInput('12,5')).toBe('12.5');
    expect(parseQtyInput('12.5')).toBe('12.5');
  });

  it('rejects more than 3 decimal places (NUMERIC(14,3))', () => {
    expect(parseQtyInput('1,2345')).toBeNull();
  });
});

describe('formatTemp / parseTempInput', () => {
  it('formats a cold-chain reading with a comma decimal and °C', () => {
    expect(formatTemp('-18.0')).toBe('-18,0°C');
    expect(formatTemp('4.5')).toBe('4,5°C');
  });

  it('parses back to the canonical 1-decimal wire string', () => {
    expect(parseTempInput('-18')).toBe('-18.0');
    expect(parseTempInput('-18,5')).toBe('-18.5');
  });
});

describe('formatNumber', () => {
  it('formats with id-ID grouping', () => {
    expect(formatNumber(12345)).toBe('12.345');
  });

  it('returns an em dash for null/NaN', () => {
    expect(formatNumber(null)).toBe('—');
    expect(formatNumber(Number.NaN)).toBe('—');
  });
});
