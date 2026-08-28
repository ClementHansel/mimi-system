import { describe, expect, it } from 'vitest';
import {
  formatDateTimeText,
  formatDateText,
  formatIdr,
  formatQtyText,
  formatTempText,
} from './doc-format.util';

describe('doc-format.util — must match apps/frontend/src/lib/formatters.ts byte-for-byte', () => {
  describe('formatIdr', () => {
    it('hides cents when the fraction is exactly .00', () => {
      expect(formatIdr('125000.00')).toBe('Rp125.000');
    });

    it('shows cents when the fraction is non-zero', () => {
      expect(formatIdr('125000.50')).toBe('Rp125.000,50');
    });

    it('groups thousands with "."', () => {
      expect(formatIdr('1234567.00')).toBe('Rp1.234.567');
    });

    it('puts the sign before the symbol', () => {
      expect(formatIdr('-125000.00')).toBe('-Rp125.000');
    });

    it('formats zero', () => {
      expect(formatIdr('0.00')).toBe('Rp0');
    });

    it.each([null, undefined, ''])('returns "—" for %s', (value) => {
      expect(formatIdr(value)).toBe('—');
    });
  });

  describe('formatQtyText', () => {
    it('strips trailing fraction zeros', () => {
      expect(formatQtyText('12.500')).toBe('12,5');
      expect(formatQtyText('12.000')).toBe('12');
      expect(formatQtyText('12.050')).toBe('12,05');
    });

    it('groups thousands', () => {
      expect(formatQtyText('1234.000')).toBe('1.234');
    });

    it('keeps the sign', () => {
      expect(formatQtyText('-3.500')).toBe('-3,5');
    });

    it.each([null, undefined, ''])('returns "—" for %s', (value) => {
      expect(formatQtyText(value)).toBe('—');
    });
  });

  describe('formatTempText', () => {
    it('always shows exactly 1 decimal', () => {
      expect(formatTempText('-18.0')).toBe('-18,0°C');
      expect(formatTempText('4.5')).toBe('4,5°C');
    });

    it('does not group thousands', () => {
      expect(formatTempText('1000.0')).toBe('1000,0°C');
    });

    it('formats zero', () => {
      expect(formatTempText('0.0')).toBe('0,0°C');
    });

    it.each([null, undefined, ''])('returns "—" for %s', (value) => {
      expect(formatTempText(value)).toBe('—');
    });
  });

  describe('formatDateText', () => {
    it('passes an ISO date through unchanged — deliberately language-free', () => {
      expect(formatDateText('2026-08-29')).toBe('2026-08-29');
    });
  });

  describe('formatDateTimeText', () => {
    it('renders YYYY-MM-DD HH.mm WITA from a UTC instant', () => {
      // 2026-08-29T10:00:00Z + 8h WITA offset = 2026-08-29 18.00 WITA
      expect(formatDateTimeText('2026-08-29T10:00:00.000Z')).toBe('2026-08-29 18.00 WITA');
    });

    it('rolls the calendar date forward across the WITA midnight boundary', () => {
      // 2026-08-29T20:00:00Z + 8h = 2026-08-30 04.00 WITA
      expect(formatDateTimeText('2026-08-29T20:00:00.000Z')).toBe('2026-08-30 04.00 WITA');
    });

    it('accepts a Date instance', () => {
      expect(formatDateTimeText(new Date('2026-08-29T10:00:00.000Z'))).toBe(
        '2026-08-29 18.00 WITA',
      );
    });

    it('returns "—" for an unparsable value', () => {
      expect(formatDateTimeText('not-a-date')).toBe('—');
    });
  });
});
