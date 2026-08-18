/**
 * Fixed-point decimal arithmetic on BigInt-scaled integers.
 *
 * Money is NUMERIC(18,2), quantity is NUMERIC(14,3), temperature is NUMERIC(4,1)
 * in Postgres (D-10), and all three cross the wire as decimal strings
 * (CONTRACTS.md §0). Nothing in this file, or anything built on it, ever
 * touches a JS `number` for a value that carries money, quantity, or
 * temperature — floats drift silently; BigInt-scaled integers do not, and
 * neither does Postgres NUMERIC. This module is the one place that boundary
 * is crossed (string in, string out); everything else in `@mimi/shared`
 * composes these primitives.
 *
 * Zero I/O. Pure functions only.
 */

export type RoundingMode = 'half_up' | 'half_even' | 'floor' | 'ceil' | 'down';

const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;

/** Parse a decimal string (e.g. `"125000.00"`) into an integer scaled by `10^scale`. */
export function parseFixed(value: string, scale: number): bigint {
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a decimal string, got ${typeof value}`);
  }
  const trimmed = value.trim();
  if (!DECIMAL_STRING_RE.test(trimmed)) {
    throw new RangeError(`Invalid decimal string: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const dotIndex = unsigned.indexOf('.');
  const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? '' : unsigned.slice(dotIndex + 1);
  if (fracPart.length > scale) {
    throw new RangeError(
      `${JSON.stringify(value)} has more than ${scale} fractional digits for this field`,
    );
  }
  const paddedFrac = fracPart.padEnd(scale, '0');
  const digits = `${intPart}${paddedFrac}`;
  const magnitude = BigInt(digits.length === 0 ? '0' : digits);
  return negative && magnitude !== 0n ? -magnitude : magnitude;
}

/** Format a scaled integer back into the canonical wire decimal string. */
export function formatFixed(scaled: bigint, scale: number): string {
  const negative = scaled < 0n;
  const magnitude = negative ? -scaled : scaled;
  const digits = magnitude.toString().padStart(scale + 1, '0');
  const splitAt = digits.length - scale;
  const intPart = digits.slice(0, splitAt) || '0';
  const fracPart = scale > 0 ? digits.slice(splitAt) : '';
  const sign = negative && magnitude !== 0n ? '-' : '';
  return scale > 0 ? `${sign}${intPart}.${fracPart}` : `${sign}${intPart}`;
}

export function addFixed(a: bigint, b: bigint): bigint {
  return a + b;
}
export function subFixed(a: bigint, b: bigint): bigint {
  return a - b;
}
export function negateFixed(a: bigint): bigint {
  return -a;
}
export function absFixed(a: bigint): bigint {
  return a < 0n ? -a : a;
}
export function compareFixed(a: bigint, b: bigint): -1 | 0 | 1 {
  return a < b ? -1 : a > b ? 1 : 0;
}
export function isZeroFixed(a: bigint): boolean {
  return a === 0n;
}
export function isNegativeFixed(a: bigint): boolean {
  return a < 0n;
}
export function minFixed(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}
export function maxFixed(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}
export function sumFixed(values: bigint[]): bigint {
  return values.reduce((acc, v) => acc + v, 0n);
}

function divideRound(numerator: bigint, divisor: bigint, mode: RoundingMode): bigint {
  if (divisor === 0n) throw new RangeError('Division by zero');
  const resultNegative = numerator < 0n !== divisor < 0n;
  const n = numerator < 0n ? -numerator : numerator;
  const d = divisor < 0n ? -divisor : divisor;
  const quotient = n / d;
  const remainder = n % d;
  let result = quotient;
  if (remainder !== 0n) {
    switch (mode) {
      case 'down':
        break; // truncate toward zero
      case 'floor':
        if (resultNegative) result = quotient + 1n;
        break;
      case 'ceil':
        if (!resultNegative) result = quotient + 1n;
        break;
      case 'half_up':
        if (remainder * 2n >= d) result = quotient + 1n;
        break;
      case 'half_even': {
        const twice = remainder * 2n;
        if (twice > d || (twice === d && quotient % 2n === 1n)) result = quotient + 1n;
        break;
      }
    }
  }
  return resultNegative && result !== 0n ? -result : result;
}

/** Rescale a raw scaled integer from one decimal scale to another, rounding per `mode`. */
export function rescale(
  value: bigint,
  fromScale: number,
  toScale: number,
  mode: RoundingMode = 'half_up',
): bigint {
  if (toScale === fromScale) return value;
  if (toScale > fromScale) {
    return value * 10n ** BigInt(toScale - fromScale);
  }
  const divisor = 10n ** BigInt(fromScale - toScale);
  return divideRound(value, divisor, mode);
}

/**
 * Multiply two scaled values (e.g. a Money at scale 2 by a Qty at scale 3),
 * producing a result at `resultScale`, rounded per `mode`.
 */
export function mulFixed(
  a: bigint,
  scaleA: number,
  b: bigint,
  scaleB: number,
  resultScale: number,
  mode: RoundingMode = 'half_up',
): bigint {
  const raw = a * b; // implicit scale = scaleA + scaleB
  return rescale(raw, scaleA + scaleB, resultScale, mode);
}

/** Divide two scaled values, producing a result at `resultScale`, rounded per `mode`. */
export function divFixed(
  numerator: bigint,
  numScale: number,
  denominator: bigint,
  denScale: number,
  resultScale: number,
  mode: RoundingMode = 'half_up',
): bigint {
  if (denominator === 0n) throw new RangeError('Division by zero');
  // value = numerator/10^numScale ÷ denominator/10^denScale, evaluated at resultScale:
  //   = numerator * 10^(resultScale + denScale - numScale) / denominator
  const shiftExp = resultScale + denScale - numScale;
  if (shiftExp >= 0) {
    return divideRound(numerator * 10n ** BigInt(shiftExp), denominator, mode);
  }
  return divideRound(numerator, denominator * 10n ** BigInt(-shiftExp), mode);
}
