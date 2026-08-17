/**
 * WITA (`Asia/Makassar`, UTC+8, no DST) date utilities — D-11.
 *
 * Everything here is plain millisecond arithmetic, deliberately not
 * `Intl`/ICU-backed: WITA never observes daylight saving, so a fixed +8h
 * offset is exact, and staying off `Intl` keeps this module byte-identical
 * across the cloud (Node), branch node (Node), and device (browser) tiers —
 * the same reason `@mimi/sync-protocol`'s projector avoids environment-
 * specific behavior. Do not swap this for `Intl.DateTimeFormat` without
 * re-verifying against all three runtimes.
 *
 * Business-date rule (shared with SYNC-PROTOCOL §6.4 and CONTRACTS.md's
 * reporting section): a shift or business day spanning the WITA midnight
 * boundary belongs to its OPENING date, never the closing date.
 */
import type { ISODate, ISODateTime } from '../types';

export const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;

function toDate(instant: ISODateTime): Date {
  const d = new Date(instant);
  if (Number.isNaN(d.getTime())) {
    throw new RangeError(`Invalid ISO datetime: ${JSON.stringify(instant)}`);
  }
  return d;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** `'YYYY-MM-DD'` formatting of already-shifted UTC-field components. */
function formatDateFromUtcFields(d: Date): ISODate {
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/**
 * A `Date` whose UTC getters (`getUTCHours`, `getUTCDate`, ...) return the
 * WITA wall-clock components for the given instant. Internal helper — do not
 * export a "shifted Date" as public API, since callers could mistake it for
 * a real instant and serialize it wrong.
 */
function witaWallTimeFields(instant: ISODateTime): Date {
  return new Date(toDate(instant).getTime() + WITA_OFFSET_MS);
}

/** The WITA calendar date (`'YYYY-MM-DD'`) a UTC instant falls on. */
export function businessDateOf(instant: ISODateTime): ISODate {
  return formatDateFromUtcFields(witaWallTimeFields(instant));
}

/** The UTC instant corresponding to `00:00:00` WITA on the given calendar date. */
export function witaMidnightUtc(date: ISODate): ISODateTime {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new RangeError(`Expected 'YYYY-MM-DD', got ${JSON.stringify(date)}`);
  }
  const utcMidnight = Date.parse(`${date}T00:00:00.000Z`);
  if (Number.isNaN(utcMidnight)) throw new RangeError(`Invalid date: ${JSON.stringify(date)}`);
  return new Date(utcMidnight - WITA_OFFSET_MS).toISOString();
}

/** `[startUtc, endUtc)` — the UTC instant range covering one WITA calendar day. */
export function businessDayBoundaries(date: ISODate): { startUtc: ISODateTime; endUtc: ISODateTime } {
  const startUtc = witaMidnightUtc(date);
  const endUtc = new Date(new Date(startUtc).getTime() + 24 * 60 * 60 * 1000).toISOString();
  return { startUtc, endUtc };
}

function parseHHmm(value: string): { hours: number; minutes: number } {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Expected 'HH:mm', got ${JSON.stringify(value)}`);
  const hours = Number.parseInt(match[1]!, 10);
  const minutes = Number.parseInt(match[2]!, 10);
  if (hours > 23 || minutes > 59) throw new RangeError(`Invalid time: ${JSON.stringify(value)}`);
  return { hours, minutes };
}

/**
 * The UTC instant window for a `work_shifts` template (`start_time`/`end_time`,
 * possibly wrapping past midnight — CONTRACTS.md `end_time` may be `< start_time`)
 * applied on a given WITA business date.
 */
export function shiftWindow(
  date: ISODate,
  startTime: string,
  endTime: string,
  breakMinutes = 0,
): { startUtc: ISODateTime; endUtc: ISODateTime; wrapsMidnight: boolean; scheduledMinutes: number } {
  const dayStart = new Date(witaMidnightUtc(date)).getTime();
  const start = parseHHmm(startTime);
  const end = parseHHmm(endTime);
  const startOffsetMin = start.hours * 60 + start.minutes;
  const endOffsetMinRaw = end.hours * 60 + end.minutes;
  const wrapsMidnight = endOffsetMinRaw <= startOffsetMin;
  const endOffsetMin = wrapsMidnight ? endOffsetMinRaw + 24 * 60 : endOffsetMinRaw;

  const startUtc = new Date(dayStart + startOffsetMin * 60_000).toISOString();
  const endUtc = new Date(dayStart + endOffsetMin * 60_000).toISOString();
  const scheduledMinutes = Math.max(0, endOffsetMin - startOffsetMin - breakMinutes);

  return { startUtc, endUtc, wrapsMidnight, scheduledMinutes };
}

/** `'YYYY-MM'` → `{ startDate, endDate }` (inclusive), the payroll period boundary. */
export function payrollPeriodBoundaries(periodCode: string): { startDate: ISODate; endDate: ISODate } {
  const match = /^(\d{4})-(\d{2})$/.exec(periodCode);
  if (!match) throw new RangeError(`Expected 'YYYY-MM', got ${JSON.stringify(periodCode)}`);
  const year = Number.parseInt(match[1]!, 10);
  const month = Number.parseInt(match[2]!, 10);
  if (month < 1 || month > 12) throw new RangeError(`Invalid month in period code: ${periodCode}`);
  const startDate = `${match[1]}-${match[2]}-01`;
  // Day 0 of the *next* month == the last day of this month (plain UTC-field arithmetic; no tz involved,
  // this is calendar math on Y-M-D, not an instant).
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const endDate = `${match[1]}-${match[2]}-${pad2(lastDay)}`;
  return { startDate, endDate };
}

/**
 * Minutes late vs. a scheduled start, after the grace period (`settings
 * ['hr.late_grace_minutes']`, default 5 — POUT-07). Never negative; an early
 * or on-time check-in is 0, not a negative "credit".
 */
export function lateMinutes(
  scheduledStartUtc: ISODateTime,
  actualCheckInUtc: ISODateTime,
  graceMinutes = 5,
): number {
  const diffMinutes = Math.round((toDate(actualCheckInUtc).getTime() - toDate(scheduledStartUtc).getTime()) / 60_000);
  return Math.max(0, diffMinutes - graceMinutes);
}

/**
 * Minutes of overtime beyond a scheduled end, applied only once the excess
 * clears `minMinutes` (`settings['hr.overtime'].minMinutes`, default 30 —
 * PIN-02: a 5-minute straggler is not overtime).
 */
export function overtimeMinutes(
  scheduledEndUtc: ISODateTime,
  actualCheckOutUtc: ISODateTime,
  minMinutesThreshold = 30,
): number {
  const diffMinutes = Math.round((toDate(actualCheckOutUtc).getTime() - toDate(scheduledEndUtc).getTime()) / 60_000);
  return diffMinutes >= minMinutesThreshold ? diffMinutes : 0;
}

/** Raw worked minutes between check-in and check-out, minus the shift's unpaid break. */
export function workedMinutes(checkInUtc: ISODateTime, checkOutUtc: ISODateTime, breakMinutes = 0): number {
  const diffMinutes = Math.round((toDate(checkOutUtc).getTime() - toDate(checkInUtc).getTime()) / 60_000);
  return Math.max(0, diffMinutes - breakMinutes);
}
