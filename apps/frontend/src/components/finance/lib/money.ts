import type { Money } from '@/lib/shared-types';

/**
 * Decimal-string-safe arithmetic for the one screen where a rounding
 * artifact becomes an audit finding (F07 finance — CONTRACTS §0). Every
 * value here is a `Money` wire string ("125000.00"); summing/comparing goes
 * through `BigInt` cents, never `parseFloat`/`Number()` — the same guarantee
 * `@mimi/shared`'s server-side GL validator gives the backend, mirrored here
 * so the manual-journal-entry form can show a live running balance without
 * risking float drift on a big entry.
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
