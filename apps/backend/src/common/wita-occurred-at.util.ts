/**
 * B-16 — converts a real instant into an ISO-8601 string carrying an
 * explicit `+08:00` (`Asia/Makassar` / WITA, D-11) offset, for events fed to
 * `PostingEngineService`, which derives `entryDate` as
 * `event.payload.occurredAt.slice(0, 10)` (`posting-engine.service.ts`).
 *
 * `Date.prototype.toISOString()` always renders in UTC ('Z'). For a location
 * whose business day is WITA (UTC+8), the UTC calendar date and the WITA
 * calendar date disagree for any instant between 00:00 and 08:00 WITA (which
 * is still the PREVIOUS day in UTC) — exactly the off-by-one-day trap this
 * codebase has already hit twice (`daily-posting.service.ts`'s
 * `endOfBusinessDay` doc comment; the seed's own SJ date bug). This helper is
 * for POINT-IN-TIME events (a PO receipt, a stock-opname approval) rather
 * than a day aggregate, so it preserves the real time-of-day — the returned
 * string still resolves to the exact same instant as `at`, merely labelled
 * with WITA's fixed (no-DST) offset instead of 'Z', so its first 10
 * characters are the correct WITA business date.
 *
 * Kept as its own copy here (rather than importing `modules/waste-return`'s
 * identical `wita-occurred-at.util.ts`) so this module's B-16 wiring never
 * depends on a file owned by the parallel waste/returns agent.
 */
const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

export function toWitaOccurredAt(at: Date = new Date()): string {
  const shifted = new Date(at.getTime() + WITA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const mo = pad(shifted.getUTCMonth() + 1, 2);
  const d = pad(shifted.getUTCDate(), 2);
  const h = pad(shifted.getUTCHours(), 2);
  const mi = pad(shifted.getUTCMinutes(), 2);
  const s = pad(shifted.getUTCSeconds(), 2);
  const ms = pad(shifted.getUTCMilliseconds(), 3);
  return `${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}+08:00`;
}
