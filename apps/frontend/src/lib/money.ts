import type { Money } from '@/lib/shared-types';

/**
 * Decimal-string-safe money arithmetic (CONTRACTS §0). Every value here is a
 * `Money` wire string ("125000.00"); summing/comparing goes through `BigInt`
 * cents, never `parseFloat`/`Number()` — the same guarantee `@mimi/shared`'s
 * server-side GL validator gives the backend, mirrored here so a screen can
 * show a live running total without risking float drift on a big entry.
 *
 * This started life as `components/finance/lib/money.ts`, for the one screen
 * where a rounding artifact becomes an audit finding. It lives in `lib/` now
 * because the dashboard's Sales and Marketing tabs foot their own columns and
 * compute discount/fee shares of gross, and a SECOND implementation of
 * "add up these decimal strings" is exactly how two screens start disagreeing
 * about the same day's revenue. `components/finance/lib/money.ts` re-exports
 * this file, so finance's existing imports and its test are unchanged.
 */

function toCents(value: string): bigint {
  const trimmed = value.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  const intPart = intPartRaw || '0';
  const fracPart = (fracPartRaw + '00').slice(0, 2) || '00';
  const cents = BigInt(intPart) * 100n + BigInt(fracPart);
  return negative ? -cents : cents;
}

function fromCents(cents: bigint): Money {
  const negative = cents < 0n;
  const abs = negative ? -cents : cents;
  const intPart = abs / 100n;
  const fracPart = abs % 100n;
  return `${negative ? '-' : ''}${intPart.toString()}.${fracPart.toString().padStart(2, '0')}`;
}

/** Sums a list of `Money` strings (blank/undefined treated as zero). */
export function sumMoney(values: (Money | null | undefined)[]): Money {
  const total = values.reduce<bigint>(
    (acc, v) => acc + (v && v.trim() !== '' ? toCents(v) : 0n),
    0n,
  );
  return fromCents(total);
}

/** True when two `Money` strings represent the same amount (e.g. "0.00" vs. "0"). */
export function moneyEquals(a: Money | null | undefined, b: Money | null | undefined): boolean {
  const av = a && a.trim() !== '' ? toCents(a) : 0n;
  const bv = b && b.trim() !== '' ? toCents(b) : 0n;
  return av === bv;
}

export function isZeroMoney(value: Money | null | undefined): boolean {
  return moneyEquals(value, '0.00');
}

/**
 * `part` as a percentage of `whole`, as a plain number for `formatPercent`.
 *
 * Returns `null` — not `0` — when `whole` is zero, and the caller is expected
 * to render that as "—" rather than "0,0%". A day with no sales has no
 * discount RATE; printing 0% asserts something the data does not say, which
 * is the same "plausible but wrong total" failure `ReportsPanel`'s balance
 * indicator exists to prevent.
 *
 * Computed on `BigInt` cents scaled by 10_000 before the single division, so
 * the only float involved is the last step and the ratio never drifts on a
 * nine-figure gross. The division ROUNDS half-up rather than truncating:
 * BigInt `/` floors, which turned 0.1% of a 987-million gross into "0,0999%"
 * — a fifth significant digit of noise in a figure rendered to one decimal.
 * Sign is stripped before rounding and reapplied after, so a negative share
 * rounds away from zero symmetrically instead of toward it.
 */
export function moneySharePct(
  part: Money | null | undefined,
  whole: Money | null | undefined,
): number | null {
  const wholeCents = whole && whole.trim() !== '' ? toCents(whole) : 0n;
  if (wholeCents === 0n) return null;
  const partCents = part && part.trim() !== '' ? toCents(part) : 0n;

  const num = partCents * 1000000n;
  const negative = num < 0n !== wholeCents < 0n;
  const absNum = num < 0n ? -num : num;
  const absDen = wholeCents < 0n ? -wholeCents : wholeCents;
  const scaled = (absNum + absDen / 2n) / absDen;
  return Number(negative ? -scaled : scaled) / 10000;
}

/**
 * Comparator for `Array.prototype.sort` over `Money` strings — so "sort by
 * revenue descending" never routes through `parseFloat` (CONTRACTS §0).
 * Ascending: `rows.sort((a, b) => compareMoney(a.x, b.x))`; descending: swap
 * the arguments.
 *
 * `@mimi/shared`'s `money.ts` holds the CANONICAL `compareMoney` — the one the
 * voucher and GL calculators use — and this agrees with it by construction:
 * both compare `BigInt` cents parsed the same way, so a table sorted in the UI
 * orders rows exactly as the server would. It is not imported through the
 * `shared-types` seam for the same reason the rest of this file isn't: the
 * shared signatures require a real `Money`, while report and form data can
 * legitimately be blank, and this file's whole job is that null-tolerance over
 * its own single `toCents` primitive. Blank/absent sorts as zero, matching
 * `sumMoney`'s treatment, so a row with no amount lands where a "0.00" row
 * would rather than at an arbitrary end.
 */
export function compareMoney(a: Money | null | undefined, b: Money | null | undefined): number {
  const av = a && a.trim() !== '' ? toCents(a) : 0n;
  const bv = b && b.trim() !== '' ? toCents(b) : 0n;
  return av < bv ? -1 : av > bv ? 1 : 0;
}
