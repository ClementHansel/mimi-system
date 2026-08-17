/**
 * Stock-opname variance math (FR-SO-02) — the count-sheet's core calculation.
 * `Qty` is a NUMERIC(14,3) decimal STRING (CONTRACTS §0); this stays a string
 * end to end via scaled-BigInt arithmetic so a `float` never touches a value
 * that could carry stock-count precision, matching `lib/formatters.ts`'s
 * decimal-string-only rule for the same wire type.
 */
import type { Qty } from '@/lib/shared-types';

const SCALE = 1000n; // Qty allows up to 3 decimals (parseQtyInput)

function toScaledInt(raw: string): bigint {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  const intPart = intPartRaw || '0';
  const fracPart = (fracPartRaw + '000').slice(0, 3);
  const magnitude = BigInt(intPart) * SCALE + BigInt(fracPart || '0');
  return negative ? -magnitude : magnitude;
}

function fromScaledInt(scaled: bigint): Qty {
  const negative = scaled < 0n;
  const abs = negative ? -scaled : scaled;
  const intPart = abs / SCALE;
  const fracPart = (abs % SCALE).toString().padStart(3, '0');
  const trimmedFrac = fracPart.replace(/0+$/, '');
  return `${negative ? '-' : ''}${intPart}${trimmedFrac ? `.${trimmedFrac}` : ''}` as Qty;
}

/** `countedQty - systemQty`, computed on scaled integers — never `Number()`/`parseFloat`. */
export function computeDiffQty(systemQty: Qty, countedQty: Qty): Qty {
  return fromScaledInt(toScaledInt(countedQty) - toScaledInt(systemQty));
}

/** A line "varies" (and therefore needs a mandatory reason, FR-SO-02) whenever `diffQty !== 0`. */
export function hasVariance(diffQty: Qty): boolean {
  return toScaledInt(diffQty) !== 0n;
}

export interface OpnameLineDraft {
  itemId: string;
  systemQty: Qty;
  countedQty: Qty | null;
  varianceReason: string;
}

/** A line is ready to submit once: not yet counted (skipped) OR counted with no variance OR counted with a variance + a non-blank reason. */
export function isLineReady(line: OpnameLineDraft): boolean {
  if (line.countedQty === null) return true;
  const diff = computeDiffQty(line.systemQty, line.countedQty);
  if (!hasVariance(diff)) return true;
  return line.varianceReason.trim().length > 0;
}

/** Whole-sheet gate for the "Ajukan" (submit) button — every counted line with a variance must carry a reason (FR-SO-02, mirrors the backend's `ERR_VARIANCE_REASON_REQUIRED`). */
export function canSubmitOpname(lines: OpnameLineDraft[]): boolean {
  return lines.every(isLineReady);
}
