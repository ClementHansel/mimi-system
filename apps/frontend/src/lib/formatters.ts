/**
 * Money / quantity / temperature / number formatters.
 *
 * CONTRACTS.md §0 (the wire-precision rule): Money, Qty and Temp travel as
 * DECIMAL STRINGS ("125000.00", "12.500", "-18.0"), never JS numbers — the
 * backend's NUMERIC(18,2)/(14,3)/(4,1) columns would otherwise round-trip
 * through float and lose or corrupt cents on a big payroll run or a cold-chain
 * reading. Every formatter here works on the STRING, never via
 * `parseFloat`/`Number()` for anything that could carry money-shaped
 * precision — grouping/sign/decimal-point handling is done with string slicing
 * so precision is bounded only by NUMERIC's own limits, not by float64.
 *
 * The one deliberate exception is `formatQtyNumber`/display-only helpers that
 * accept a plain `number` (chart axes, counts) — those were never decimal
 * strings on the wire to begin with.
 */

import type { Money, Qty, Temp } from './shared-types';

/** Split a decimal-string wire value into sign/integer/fraction without float parsing. */
function splitDecimalString(raw: string): { negative: boolean; intPart: string; fracPart: string } {
  const trimmed = raw.trim();
  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;
  const [intPartRaw, fracPartRaw = ''] = unsigned.split('.');
  return { negative, intPart: intPartRaw || '0', fracPart: fracPartRaw };
}

/** Group an unsigned digit string into thousands using `.` — id-ID convention (Rp125.000). */
function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

export interface FormatMoneyOptions {
  /** 'auto' (default) hides ".00", 'always' always shows 2 decimals, 'never' always hides them. */
  cents?: 'auto' | 'always' | 'never';
  /** Show the "Rp" prefix. Default true. */
  withSymbol?: boolean;
}

/**
 * Format a Money decimal string ("125000.00") as Indonesian Rupiah
 * ("Rp125.000"). Indonesian retail has not used sub-Rupiah denominations in
 * decades, so cents are hidden by default even though the column is
 * NUMERIC(18,2) — `cents: 'always'` is available for GL/payroll views where
 * an exact-to-the-sen reconciliation matters.
 */
export function formatMoney(value: Money | null | undefined, opts: FormatMoneyOptions = {}): string {
  if (value === null || value === undefined || value === '') return '—';
  const { cents = 'auto', withSymbol = true } = opts;
  const { negative, intPart, fracPart } = splitDecimalString(value);
  const grouped = groupThousands(intPart);
  const fracPadded = (fracPart + '00').slice(0, 2);
  const showCents = cents === 'always' || (cents === 'auto' && fracPadded !== '00');
  const body = showCents ? `${grouped},${fracPadded}` : grouped;
  const sign = negative ? '-' : '';
  return `${sign}${withSymbol ? 'Rp' : ''}${body}`;
}

/**
 * Parse user keyboard input in a MoneyInput back into the canonical Money
 * wire string. Accepts thousand-grouped id-ID input ("125.000") or a bare
 * number ("125000"); rejects anything that isn't digits/separators. IDR has
 * no working sub-unit in practice, so MoneyInput is whole-Rupiah — the
 * canonical string still carries ".00" to match NUMERIC(18,2).
 */
export function parseMoneyInput(raw: string): Money | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  const negative = trimmed.startsWith('-');
  const digitsOnly = trimmed.replace(/[^\d]/g, '');
  if (digitsOnly === '') return null;
  const normalized = digitsOnly.replace(/^0+(?=\d)/, '');
  return `${negative ? '-' : ''}${normalized}.00`;
}

/** Format a Qty decimal string ("12.500") for display, e.g. "12,5 kg". Trims trailing zeros. */
export function formatQty(value: Qty | null | undefined, unitCode?: string): string {
  if (value === null || value === undefined || value === '') return '—';
  const { negative, intPart, fracPart } = splitDecimalString(value);
  const trimmedFrac = fracPart.replace(/0+$/, '');
  const grouped = groupThousands(intPart);
  const body = trimmedFrac ? `${grouped},${trimmedFrac}` : grouped;
  const sign = negative ? '-' : '';
  return unitCode ? `${sign}${body} ${unitCode}` : `${sign}${body}`;
}

/** Parse user input in a QtyInput into the canonical Qty wire string (up to 3 decimals). */
export function parseQtyInput(raw: string): Qty | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '' || trimmed === '-') return null;
  if (!/^-?\d+(\.\d{1,3})?$/.test(trimmed)) return null;
  const [intPartRaw, fracPart] = trimmed.split('.');
  const intPart = intPartRaw ?? '';
  const negative = intPart.startsWith('-');
  const cleanInt = intPart.replace('-', '').replace(/^0+(?=\d)/, '') || '0';
  return `${negative ? '-' : ''}${cleanInt}${fracPart !== undefined ? `.${fracPart}` : ''}`;
}

/** Format a Temp decimal string ("-18.0") for display, e.g. "-18,0°C". Always shows 1 decimal. */
export function formatTemp(value: Temp | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const { negative, intPart, fracPart } = splitDecimalString(value);
  const frac = (fracPart + '0').slice(0, 1);
  const sign = negative ? '-' : '';
  return `${sign}${intPart},${frac}°C`;
}

/** Parse user input in a TempInput into the canonical Temp wire string (exactly 1 decimal). */
export function parseTempInput(raw: string): Temp | null {
  const trimmed = raw.trim().replace(',', '.');
  if (trimmed === '' || trimmed === '-') return null;
  if (!/^-?\d+(\.\d{1,1})?$/.test(trimmed)) return null;
  const [intPartRaw, fracPart = '0'] = trimmed.split('.');
  const intPart = intPartRaw ?? '';
  const negative = intPart.startsWith('-');
  const cleanInt = intPart.replace('-', '') || '0';
  return `${negative ? '-' : ''}${cleanInt}.${fracPart}`;
}

/** Plain id-ID number formatting for counts/percentages (never money/qty/temp). */
export function formatNumber(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value);
}

export function formatPercent(value: number | null | undefined, fractionDigits = 1): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—';
  return `${new Intl.NumberFormat('id-ID', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(value)}%`;
}
