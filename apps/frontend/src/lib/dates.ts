/**
 * WITA (Asia/Makassar) date/time helpers — D-11: the app timezone is fixed to
 * WITA app-wide, never `Asia/Jakarta` (that was AIRE's default; do not copy
 * it, per BUILD-PLAN D-11). All server timestamps are UTC `TIMESTAMPTZ` on
 * the wire (ISO-8601); every human-facing render goes through here.
 */

const TIME_ZONE = 'Asia/Makassar';
const LOCALE = 'id-ID';

/** Normalize an ISODateTime/ISODate/Date into a `Date`, or null if unparseable. */
function toDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `29 Agu 2026` in WITA. */
export function fmtDate(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
}

/** `29 Agu 2026, 14.05 WITA`. */
export function fmtDateTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  const date = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(d);
  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${date}, ${time} WITA`;
}

/** `14.05 WITA`. */
export function fmtTime(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '—';
  return `${new Intl.DateTimeFormat(LOCALE, {
    timeZone: TIME_ZONE,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)} WITA`;
}

/** Inclusive date range for a "Periode" column; collapses to one date when both ends match. */
export function fmtDateRange(
  from: string | Date | null | undefined,
  to: string | Date | null | undefined,
): string {
  const a = toDate(from);
  const b = toDate(to);
  if (!a && !b) return '—';
  if (a && b && fmtDate(a) === fmtDate(b)) return fmtDate(a);
  if (!b) return `${fmtDate(a)} –`;
  if (!a) return `– ${fmtDate(b)}`;
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}

/**
 * `YYYY-MM-DD` in WITA for `<input type="date">` — never derived by slicing
 * a UTC ISO string, which can shift the calendar day for a WITA (+8) reader.
 */
export function toDateInput(value: string | Date | null | undefined): string {
  const d = toDate(value);
  if (!d) return '';
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

const RELATIVE_UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 60 * 60 * 24 * 365],
  ['month', 60 * 60 * 24 * 30],
  ['week', 60 * 60 * 24 * 7],
  ['day', 60 * 60 * 24],
  ['hour', 60 * 60],
  ['minute', 60],
];

/** `5 menit lalu`, `2 jam lalu`, `baru saja` — for heartbeats, "last sync", notifications. */
export function fmtRelative(
  value: string | Date | null | undefined,
  now: Date = new Date(),
): string {
  const d = toDate(value);
  if (!d) return '—';
  const rtf = new Intl.RelativeTimeFormat(LOCALE, { numeric: 'auto' });
  const diffSeconds = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return diffSeconds <= 0 ? 'baru saja' : rtf.format(0, 'second');
  for (const [unit, secondsInUnit] of RELATIVE_UNITS) {
    if (abs >= secondsInUnit || unit === 'minute') {
      const value2 = Math.round(diffSeconds / secondsInUnit);
      return rtf.format(value2, unit);
    }
  }
  return fmtDateTime(d);
}
