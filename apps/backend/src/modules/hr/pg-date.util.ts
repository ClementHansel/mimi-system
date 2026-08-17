/**
 * `pg` parses a Postgres `DATE` column into a JS `Date` at LOCAL midnight
 * (it calls the local-timezone `Date` constructor with the year/month/day it
 * received, not a UTC one). Formatting that value with anything UTC-based —
 * `.toISOString()`, `getUTCFullYear()`/`getUTCMonth()`/`getUTCDate()` — shifts
 * the calendar date BACKWARD by one day whenever the process runs in a
 * timezone ahead of UTC. This app pins `process.env.TZ = 'Asia/Makassar'`
 * (`main.ts`, D-11) — exactly such a timezone — so every `DATE` column this
 * module exposes (`attendance.date`, `employees.join_date`,
 * `employments.start_date`/`end_date`, `leave_requests.start_date`/`end_date`,
 * `shift_assignments.date`) would otherwise render one day early to a real
 * user. The fix is LOCAL getters, not UTC ones: since the `Date` was built at
 * LOCAL midnight for the intended calendar day, `getFullYear()`/`getMonth()`/
 * `getDate()` recover the correct y/m/d regardless of the process's offset.
 */
export function pgDateToIso(value: unknown): string {
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  // Already a string (e.g. selected via `to_char(...)`, or `pg`'s parser configured differently
  // elsewhere) — or null/undefined, which callers handle themselves.
  return value as string;
}
