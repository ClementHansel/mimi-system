/**
 * `node-pg` parses a Postgres `DATE` column into a JS `Date` constructed via
 * the LOCAL-timezone constructor (`new Date(year, month-1, day)`) — not UTC
 * — and there is no global `types.setTypeParser` override anywhere in this
 * backend (`modules/report/report.types.ts` documents the same absence for
 * `TIMESTAMPTZ`). Calling `.toISOString()` on that value re-reads it as UTC,
 * which SHIFTS the calendar date by the server process's UTC offset — under
 * `Asia/Makassar` (UTC+8, D-11's mandated timezone), a `DATE` column holding
 * June 30 serializes as `"2026-06-29T16:00:00.000Z"`, one full day off from
 * the `ISODate` (`YYYY-MM-DD`, no time component) CONTRACTS.md documents for
 * every such field. `TIMESTAMPTZ` columns do NOT suffer this — only `DATE`.
 *
 * Every `DATE` column any module returns over HTTP must go through this
 * helper — reading the Date's LOCAL calendar components (which is what
 * recovers the ORIGINAL y/m/d pg's local constructor encoded) rather than
 * its UTC ones. Passing a value pg has NOT converted (already a plain
 * string — a defensive case, not the expected one on this backend today) is
 * a safe no-op. Also safe to call on a fresh `new Date()` you're about to
 * write back to a `DATE` column (e.g. an "effective today" default) — same
 * local-vs-UTC mismatch applies on the write path too.
 *
 * Originally written for `modules/accounting` (`accounting.types.ts`,
 * confirmed by the off-by-one-day symptom in
 * `accounting.integration.spec.ts`'s periods test) and promoted here once
 * `modules/purchasing` and `modules/supplier` turned out to need the exact
 * same fix (BE-PURCH-FIX) — a third and fourth independent module hitting
 * the same `pg` gotcha. `modules/replenishment` and `modules/delivery` each
 * carried their OWN private copy of this same function (not wired to this
 * shared one, and each subtly WRONG — both used the UTC getters instead of
 * the local ones, which is the identical bug this file exists to fix) —
 * consolidated onto this shared helper by CLEANUP-DATE.
 */
export function formatDateOnly(value: unknown): string {
  if (!(value instanceof Date)) return String(value);
  const y = value.getFullYear();
  const m = String(value.getMonth() + 1).padStart(2, '0');
  const d = String(value.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
