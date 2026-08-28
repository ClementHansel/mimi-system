/**
 * Display formatting for `DocPayload.fields`/`.totals` values — money,
 * quantity, temperature, date and datetime.
 *
 * WHY THIS FILE EXISTS AT ALL, AND WHY ITS NAMES DON'T MATCH THE FRONTEND'S
 * ---------------------------------------------------------------------------
 * `apps/frontend/src/lib/formatters.ts` (`formatMoney`/`formatQty`/
 * `formatTemp`) is the ACTUAL rendering code every screen in the app already
 * uses and is therefore the one this backend must byte-for-byte match — but
 * it is frontend code, not importable from a NestJS process. Meanwhile
 * `@mimi/shared` exports functions with the EXACT SAME NAMES
 * (`formatMoney`/`formatQty` in `packages/shared/src/money.ts`/`qty.ts`) that
 * do something completely different: they are ARITHMETIC serializers for
 * `Money`/`Qty` value objects (bigint-backed fixed point), not display
 * formatters for wire decimal-strings. Importing `@mimi/shared`'s
 * `formatMoney` here by mistake would compile cleanly, run without error, and
 * print the wrong string on every invoice — a silent bug, not a type error,
 * because both functions genuinely take a string-ish input and return a
 * string. So this file is a SEPARATE, LOCAL reimplementation of the
 * frontend's formatting rules, under DELIBERATELY DIFFERENT NAMES
 * (`formatIdr`, `formatQtyText`, `formatTempText`) precisely so a resolver
 * that writes `import { formatMoney } from '@mimi/shared'` cannot silently
 * get this file's behaviour, and a resolver that means to use this file
 * cannot silently get `@mimi/shared`'s.
 *
 * The logic below is transcribed from `apps/frontend/src/lib/formatters.ts`
 * as it exists today (read directly, not from memory) — see that file's own
 * header for the string-only-arithmetic rationale this copy inherits
 * (CONTRACTS.md §0: Money/Qty/Temp travel as decimal strings end-to-end,
 * never `Number()`/`parseFloat`, so a big payroll figure or a cold-chain
 * reading never round-trips through float precision loss). If the frontend's
 * formatter ever changes, this file must change with it by hand — there is
 * no compiler that will catch the drift, which is the cost of not sharing
 * code across the frontend/backend boundary here (recorded so the next
 * reader knows this is deliberate, not an oversight).
 *
 * SPEC DRIFT ON RECORD: `packages/shared/src/documents/payload.ts`'s own doc
 * comment on `DocPayloadTotalRow.value` gives `'Rp 125.000'` WITH a space as
 * the example. `apps/frontend/src/lib/formatters.ts`'s `formatMoney` — what
 * actually renders on every screen today — emits `'Rp125.000'` WITHOUT a
 * space. This file matches the LIVE renderer, not the stale doc comment,
 * because a document that visually agrees with the app the owner uses every
 * day is the thing that matters; the doc comment is wrong and is flagged
 * here for whoever next touches `payload.ts` to fix.
 */

/** Split a decimal-string wire value into sign/integer/fraction without float parsing — mirrors `formatters.ts`'s private helper of the same shape. */
function splitDecimalString(raw: string): { negative: boolean; intPart: string; fracPart: string } {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  return { negative, intPart: intPartRaw || '0', fracPart: fracPartRaw };
}

/** Group an unsigned digit string into thousands using `.` — id-ID convention (`Rp125.000`). */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/**
 * `formatMoney` from `apps/frontend/src/lib/formatters.ts`, transcribed
 * verbatim under a distinct name (see file header). Symbol `Rp`, NO space,
 * `.` thousands, `,` decimal, cents hidden when the truncated 2-digit
 * fraction is `'00'`, sign before the symbol, `'—'` (U+2014) for
 * null/undefined/empty.
 */
export function formatIdr(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const { negative, intPart, fracPart } = splitDecimalString(value);
  const grouped = groupThousands(intPart);
  const fracPadded = (fracPart + '00').slice(0, 2);
  const showCents = fracPadded !== '00';
  const body = showCents ? `${grouped},${fracPadded}` : grouped;
  const sign = negative ? '-' : '';
  return `${sign}Rp${body}`;
}

/**
 * `formatQty` from `apps/frontend/src/lib/formatters.ts`, transcribed under
 * a distinct name. Trailing fraction zeros stripped (`'12.500'` → `'12,5'`,
 * `'12.000'` → `'12'`), `.` thousands, `,` decimal, `'—'` for
 * null/undefined/empty. No unit suffix here — a resolver appends `uom`
 * itself as a separate column/field rather than baking it into the number.
 */
export function formatQtyText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const { negative, intPart, fracPart } = splitDecimalString(value);
  const trimmedFrac = fracPart.replace(/0+$/, '');
  const grouped = groupThousands(intPart);
  const body = trimmedFrac ? `${grouped},${trimmedFrac}` : grouped;
  const sign = negative ? '-' : '';
  return `${sign}${body}`;
}

/**
 * `formatTemp` from `apps/frontend/src/lib/formatters.ts`, transcribed under
 * a distinct name (`temp_c`'s formatter). Always exactly 1 decimal, `°C`
 * suffix, no thousands grouping (a temperature is never in the thousands),
 * `'—'` for null/undefined/empty.
 */
export function formatTempText(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const { negative, intPart, fracPart } = splitDecimalString(value);
  const frac = (fracPart + '0').slice(0, 1);
  const sign = negative ? '-' : '';
  return `${sign}${intPart},${frac}°C`;
}

// ── Dates ─────────────────────────────────────────────────────────────────────

/**
 * WHY DATES ON A `DocPayload` ARE LANGUAGE-FREE ISO STRINGS, NOT `29 Agu 2026`
 * -----------------------------------------------------------------------------
 * `packages/shared/src/wita` (the shared WITA date module, D-11) exports only
 * machine forms (`businessDateOf` → `'YYYY-MM-DD'`, `witaMidnightUtc`, etc) —
 * there is no human-facing date formatter in it, and there must not be one:
 * the frontend's `fmtDate` renders Indonesian month abbreviations
 * (`'29 Agu 2026'`), and that is exactly the kind of user-facing copy this
 * backend may not emit (BUILD-PLAN §6.9 — see `template.ts`'s header for the
 * same rule applied to field labels). So a resolver here emits the ISO form
 * and stops; the frontend can re-render it in the owner's locale if it later
 * chooses to.
 *
 * This is also PRECEDENTED, not just permitted: the existing (pre-template)
 * Surat Jalan print page already prints `sj.plannedDate` raw — a bare
 * `'YYYY-MM-DD'` `DATE` column value with no reformatting — so a resolver
 * emitting `sj_date` as ISO matches what a customer already sees on paper
 * today, not a regression from it.
 *
 * THE COST, RECORDED: the customer reading a printed invoice sees
 * `'2026-08-29'` instead of `'29 Agu 2026'`. That is a real, visible
 * trade-off, accepted because the alternative — the backend hand-rolling
 * Indonesian month names — is the one thing `DocPayload.fields` (as opposed
 * to `.labelKeys`) is defined not to contain.
 */
export function formatDateText(isoDate: string): string {
  return isoDate;
}

/**
 * `'YYYY-MM-DD HH.mm WITA'` — the language-free datetime form for a receipt's
 * `datetime` token and any other timestamp a resolver needs to print. `HH.mm`
 * (dot, not colon) avoids a bare colon reading as a ratio/range in a cramped
 * 80mm receipt column; `WITA` is a fixed literal, never translated, because
 * D-11 pins this whole system to `Asia/Makassar` with no other timezone in
 * play — it identifies the offset, not a translated word.
 */
export function formatDateTimeText(instant: string | Date): string {
  const ms = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(ms)) return '—';
  // `WITA_OFFSET_MS` is +8h with no DST (see `@mimi/shared`'s `wita` module
  // header) — plain millisecond arithmetic is exact and avoids `Intl`, for
  // the same cross-runtime-determinism reason that module gives.
  const WITA_OFFSET_MS = 8 * 60 * 60 * 1000;
  const shifted = new Date(ms + WITA_OFFSET_MS);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const mi = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${y}-${mo}-${d} ${h}.${mi} WITA`;
}
