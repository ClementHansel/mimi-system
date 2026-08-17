/**
 * Quantity arithmetic — NUMERIC(14,3), decimal-string wire format (D-10, CONTRACTS.md §0).
 * Same decimal-safe discipline as `./money`; kept as a separate module because
 * qty and money are never interchangeable types even though both are decimal
 * strings (a stray `Qty` where a `Money` is expected is a bug this separation
 * makes visible at the type level).
 */
import type { Qty } from './types';
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

export const QTY_SCALE = 3;

export function parseQty(value: Qty): bigint {
  return parseFixed(value, QTY_SCALE);
}

export function formatQty(scaled: bigint): Qty {
  return formatFixed(scaled, QTY_SCALE);
}

export const ZERO_QTY: Qty = formatQty(0n);

export function addQty(a: Qty, b: Qty): Qty {
  return formatQty(addFixed(parseQty(a), parseQty(b)));
}

export function subQty(a: Qty, b: Qty): Qty {
  return formatQty(subFixed(parseQty(a), parseQty(b)));
}

export function sumQty(values: Qty[]): Qty {
  return formatQty(values.reduce((acc, v) => addFixed(acc, parseQty(v)), 0n));
}

export function negateQty(a: Qty): Qty {
  return formatQty(negateFixed(parseQty(a)));
}

export function absQty(a: Qty): Qty {
  return formatQty(absFixed(parseQty(a)));
}

export function compareQty(a: Qty, b: Qty): -1 | 0 | 1 {
  return compareFixed(parseQty(a), parseQty(b));
}

export function isZeroQty(a: Qty): boolean {
  return isZeroFixed(parseQty(a));
}

export function isNegativeQty(a: Qty): boolean {
  return isNegativeFixed(parseQty(a));
}

export function minQty(a: Qty, b: Qty): Qty {
  return formatQty(minFixed(parseQty(a), parseQty(b)));
}

export function maxQty(a: Qty, b: Qty): Qty {
  return formatQty(maxFixed(parseQty(a), parseQty(b)));
}

/**
 * Unit conversion: `qty_to = qty_from × factor` (CONTRACTS.md `unit_conversions.factor NUMERIC(14,6)`).
 * Factor is its own decimal string at 6dp per the schema; result rounds half-up to Qty scale.
 */
export function convertQty(qtyFrom: Qty, factor: string, mode: RoundingMode = 'half_up'): Qty {
  const FACTOR_SCALE = 6;
  const scaledFactor = parseFixed(factor, FACTOR_SCALE);
  if (scaledFactor <= 0n) throw new RangeError(`Unit conversion factor must be > 0, got ${factor}`);
  return formatQty(mulFixed(parseQty(qtyFrom), QTY_SCALE, scaledFactor, FACTOR_SCALE, QTY_SCALE, mode));
}

export function divQty(a: Qty, b: Qty, resultScale = QTY_SCALE, mode: RoundingMode = 'half_up'): Qty {
  return formatFixed(divFixed(parseQty(a), QTY_SCALE, parseQty(b), QTY_SCALE, resultScale, mode), resultScale);
}
