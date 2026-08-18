import { describe, it, expect } from 'vitest';
import {
  businessDateOf,
  witaMidnightUtc,
  businessDayBoundaries,
  shiftWindow,
  payrollPeriodBoundaries,
  lateMinutes,
  overtimeMinutes,
  workedMinutes,
} from './index';

describe('businessDateOf / witaMidnightUtc', () => {
  it('WITA midnight is 16:00 UTC the previous day', () => {
    expect(witaMidnightUtc('2026-08-17')).toBe('2026-08-16T16:00:00.000Z');
  });

  it('round-trips a business date through its midnight boundary', () => {
    expect(businessDateOf(witaMidnightUtc('2026-08-17'))).toBe('2026-08-17');
  });

  it('a moment just before WITA midnight belongs to the previous business date', () => {
    // 2026-08-16T15:59:59.999Z is one ms before 2026-08-17 00:00:00 WITA.
    expect(businessDateOf('2026-08-16T15:59:59.999Z')).toBe('2026-08-16');
    expect(businessDateOf('2026-08-16T16:00:00.000Z')).toBe('2026-08-17');
  });

  it('handles a UTC instant well past midnight WITA (e.g. late evening WITA)', () => {
    // 23:00 WITA on 2026-08-17 == 15:00 UTC on 2026-08-17.
    expect(businessDateOf('2026-08-17T15:00:00.000Z')).toBe('2026-08-17');
  });
});

describe('businessDayBoundaries', () => {
  it('spans exactly 24 hours', () => {
    const { startUtc, endUtc } = businessDayBoundaries('2026-08-17');
    expect(new Date(endUtc).getTime() - new Date(startUtc).getTime()).toBe(24 * 60 * 60 * 1000);
    expect(startUtc).toBe('2026-08-16T16:00:00.000Z');
    expect(endUtc).toBe('2026-08-17T16:00:00.000Z');
  });
});

describe('shiftWindow', () => {
  it('computes a same-day shift (Pagi 07:00-15:00)', () => {
    const w = shiftWindow('2026-08-17', '07:00', '15:00');
    expect(w.wrapsMidnight).toBe(false);
    expect(w.scheduledMinutes).toBe(8 * 60);
    expect(businessDateOf(w.startUtc)).toBe('2026-08-17');
    expect(businessDateOf(w.endUtc)).toBe('2026-08-17');
  });

  it('applies the unpaid break to scheduled minutes', () => {
    const w = shiftWindow('2026-08-17', '07:00', '15:00', 60);
    expect(w.scheduledMinutes).toBe(7 * 60);
  });

  it('computes a shift wrapping past midnight (Malam 22:00-06:00) and assigns it to the opening date', () => {
    const w = shiftWindow('2026-08-17', '22:00', '06:00');
    expect(w.wrapsMidnight).toBe(true);
    expect(w.scheduledMinutes).toBe(8 * 60);
    // The shift "belongs" to its opening business date even though it ends the next day.
    expect(businessDateOf(w.startUtc)).toBe('2026-08-17');
    expect(businessDateOf(w.endUtc)).toBe('2026-08-18');
  });
});

describe('payrollPeriodBoundaries', () => {
  it('handles a 31-day month', () => {
    expect(payrollPeriodBoundaries('2026-08')).toEqual({
      startDate: '2026-08-01',
      endDate: '2026-08-31',
    });
  });

  it('handles a 30-day month', () => {
    expect(payrollPeriodBoundaries('2026-09')).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
  });

  it('handles February in a non-leap year', () => {
    expect(payrollPeriodBoundaries('2026-02')).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
  });

  it('handles February in a leap year', () => {
    expect(payrollPeriodBoundaries('2028-02')).toEqual({
      startDate: '2028-02-01',
      endDate: '2028-02-29',
    });
  });

  it('rejects a malformed period code', () => {
    expect(() => payrollPeriodBoundaries('2026-8')).toThrow(RangeError);
    expect(() => payrollPeriodBoundaries('2026-13')).toThrow(RangeError);
  });
});

describe('lateMinutes / overtimeMinutes / workedMinutes', () => {
  const scheduledStart = '2026-08-16T23:00:00.000Z'; // 07:00 WITA
  const scheduledEnd = '2026-08-17T07:00:00.000Z'; // 15:00 WITA

  it('is 0 within the grace period', () => {
    const checkIn = new Date(new Date(scheduledStart).getTime() + 4 * 60_000).toISOString();
    expect(lateMinutes(scheduledStart, checkIn, 5)).toBe(0);
  });

  it('is 0 for an early check-in (no negative credit)', () => {
    const checkIn = new Date(new Date(scheduledStart).getTime() - 10 * 60_000).toISOString();
    expect(lateMinutes(scheduledStart, checkIn, 5)).toBe(0);
  });

  it('counts minutes beyond the grace period', () => {
    const checkIn = new Date(new Date(scheduledStart).getTime() + 20 * 60_000).toISOString();
    expect(lateMinutes(scheduledStart, checkIn, 5)).toBe(15);
  });

  it('overtime is 0 below the minimum threshold', () => {
    const checkOut = new Date(new Date(scheduledEnd).getTime() + 10 * 60_000).toISOString();
    expect(overtimeMinutes(scheduledEnd, checkOut, 30)).toBe(0);
  });

  it('overtime counts the full excess once the threshold is met', () => {
    const checkOut = new Date(new Date(scheduledEnd).getTime() + 45 * 60_000).toISOString();
    expect(overtimeMinutes(scheduledEnd, checkOut, 30)).toBe(45);
  });

  it('workedMinutes subtracts the break and floors at zero', () => {
    expect(workedMinutes(scheduledStart, scheduledEnd, 60)).toBe(8 * 60 - 60);
    expect(workedMinutes(scheduledEnd, scheduledStart, 0)).toBe(0); // check-out before check-in: never negative
  });
});
