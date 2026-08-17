/**
 * Money arithmetic — NUMERIC(18,2), IDR, decimal-string wire format (D-10, CONTRACTS.md §0).
 *
 * Every function here takes `Money` (decimal string) in and returns `Money`
 * out; BigInt is used strictly as an internal implementation detail so no
 * caller ever needs to think about scaled integers. Rounding defaults to
 * "round half up" (standard Indonesian commercial rounding) and is always
 * explicit at the one place non-money-scale results are folded back to
 * money scale (multiplication, division, rate application).
 */
import type { Money, Qty } from './types';
import {
  parseFixed,
  formatFixed,
  addFixed,
  subFixed,
  negateFixed,
  absFixed,
  compareFixed,
  isZeroFixed,
  isNegativeFixed,
  minFixed,
  maxFixed,
  mulFixed,
  divFixed,
  type RoundingMode,
} from './decimal/fixed-point';
import { parseQty, QTY_SCALE } from './qty';

export const MONEY_SCALE = 2;

export function parseMoney(value: Money): bigint {
  return parseFixed(value, MONEY_SCALE);
}

export function formatMoney(scaled: bigint): Money {
  return formatFixed(scaled, MONEY_SCALE);
}

export const ZERO_MONEY: Money = formatMoney(0n);

export function addMoney(a: Money, b: Money): Money {
  return formatMoney(addFixed(parseMoney(a), parseMoney(b)));
}

export function subMoney(a: Money, b: Money): Money {
  return formatMoney(subFixed(parseMoney(a), parseMoney(b)));
}

export function sumMoney(values: Money[]): Money {
  return formatMoney(values.reduce((acc, v) => addFixed(acc, parseMoney(v)), 0n));
}

export function negateMoney(a: Money): Money {
  return formatMoney(negateFixed(parseMoney(a)));
}

export function absMoney(a: Money): Money {
  return formatMoney(absFixed(parseMoney(a)));
}

/** -1 if a < b, 0 if equal, 1 if a > b. */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  return compareFixed(parseMoney(a), parseMoney(b));
}

export function isZeroMoney(a: Money): boolean {
  return isZeroFixed(parseMoney(a));
}

export function isNegativeMoney(a: Money): boolean {
  return isNegativeFixed(parseMoney(a));
}

export function isPositiveMoney(a: Money): boolean {
  return !isZeroMoney(a) && !isNegativeMoney(a);
}

export function minMoney(a: Money, b: Money): Money {
  return formatMoney(minFixed(parseMoney(a), parseMoney(b)));
}

export function maxMoney(a: Money, b: Money): Money {
  return formatMoney(maxFixed(parseMoney(a), parseMoney(b)));
}

/** Floors a value at zero — total/refund amounts are never negative (mirrors AIRE cart convention). */
export function clampMoneyToZero(a: Money): Money {
  return isNegativeMoney(a) ? ZERO_MONEY : a;
}

/** unit price (Money) × quantity (Qty) → line total (Money), rounded half-up to 2dp by default. */
export function mulMoneyByQty(price: Money, qty: Qty, mode: RoundingMode = 'half_up'): Money {
  return formatMoney(mulFixed(parseMoney(price), MONEY_SCALE, parseQty(qty), QTY_SCALE, MONEY_SCALE, mode));
}

/**
 * amount × rate → Money, rounded half-up by default. `rate` is itself a decimal
 * string (e.g. `"0.11"` for 11% PPN, `"0.05"` for a 5% service charge) at
 * `rateScale` fractional digits (2 is the usual choice for a percentage rate).
 */
export function mulMoneyByRate(
  amount: Money,
  rate: string,
  rateScale = 4,
  mode: RoundingMode = 'half_up',
): Money {
  const scaledRate = parseFixed(rate, rateScale);
  return formatMoney(mulFixed(parseMoney(amount), MONEY_SCALE, scaledRate, rateScale, MONEY_SCALE, mode));
}

export function divMoney(
  amount: Money,
  divisor: Money,
  resultScale = MONEY_SCALE,
  mode: RoundingMode = 'half_up',
): Money {
  return formatFixed(
    divFixed(parseMoney(amount), MONEY_SCALE, parseMoney(divisor), MONEY_SCALE, resultScale, mode),
    resultScale,
  );
}

/**
 * Splits `total` into `parts` equal-as-possible Money shares that sum back to
 * exactly `total` (the classic "divide 100.00 by 3" problem: 33.34/33.33/33.33,
 * not 33.33 × 3 = 99.99 lost to rounding). Remainder cents are distributed to
 * the first shares in order — deterministic, GL-safe.
 */
export function splitMoneyEvenly(total: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new RangeError(`parts must be a positive integer, got ${parts}`);
  }
  const totalScaled = parseMoney(total);
  const negative = totalScaled < 0n;
  const magnitude = negative ? -totalScaled : totalScaled;
  const base = magnitude / BigInt(parts);
  const remainder = magnitude % BigInt(parts);
  const shares: bigint[] = [];
  for (let i = 0; i < parts; i++) {
    const share = base + (BigInt(i) < remainder ? 1n : 0n);
    shares.push(negative ? -share : share);
  }
  return shares.map(formatMoney);
}
