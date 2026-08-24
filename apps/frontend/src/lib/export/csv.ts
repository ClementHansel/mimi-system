/**
 * Reusable CSV export: RFC4180 quoting, a UTF-8 BOM (so Excel renders
 * Indonesian names/currency correctly instead of guessing Latin-1/ANSI), and
 * a guard against CSV formula injection.
 *
 * WHY the formula guard: outlet names, product names, and other exported
 * fields are user-editable master data (see `components/admin/MasterDataPanel`).
 * A row whose name is literally `=cmd|'/c calc'!A1` or `+1+1` becomes a live
 * formula the instant someone opens the export in Excel/Sheets — this is the
 * well-known CSV/DDE injection class (OWASP), not a hypothetical here, since
 * the source field is attacker-editable free text, not a generated ID.
 */

import { toDateInput } from '@/lib/dates';

export interface CsvColumn<T> {
  key: keyof T;
  header: string;
  /** Derive the cell instead of reading `row[key]` verbatim — joins, lookups, formatting. */
  format?: (row: T) => string | number | null | undefined;
}

const BOM = '\uFEFF';

// First-character triggers a spreadsheet reads as "this cell is a formula"
// (or, for tab/CR, a way to smuggle a delimiter/line-break past a naive
// parser). Prefixing with an apostrophe forces text interpretation in
// Excel/Sheets while leaving the visible value unchanged for a human reader.
const FORMULA_TRIGGERS = new Set(['=', '+', '-', '@', '\t', '\r']);

function guardFormulaInjection(value: string): string {
  // `charAt` (not `value[0]`) so this stays a plain `string` under
  // `noUncheckedIndexedAccess` — no need to assert away an `undefined` that
  // can't actually occur once `length > 0` is checked.
  return value.length > 0 && FORMULA_TRIGGERS.has(value.charAt(0)) ? `'${value}` : value;
}

// RFC4180 §2.5-2.7: quote (and double up inner quotes) whenever the field
// contains the delimiter, a quote, or a line break.
function quoteCell(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function cellText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw);
}

/** Build an RFC4180 CSV string (CRLF rows, UTF-8 BOM) from rows + column defs. */
export function toCsv<T>(rows: T[], columns: CsvColumn<T>[]): string {
  const header = columns.map((c) => quoteCell(c.header)).join(',');
  const body = rows.map((row) =>
    columns
      .map((col) => {
        const raw = col.format ? col.format(row) : row[col.key];
        return quoteCell(guardFormulaInjection(cellText(raw)));
      })
      .join(','),
  );
  return BOM + [header, ...body].join('\r\n');
}

/**
 * `<base>-<WITA business date>.csv` — filenames key off the WITA business
 * day (D-11), never the machine's local date: a UTC server or a laptop in
 * another timezone would otherwise stamp yesterday's or tomorrow's date on
 * an export taken right at the WITA day boundary.
 */
export function businessDateFilename(base: string, now: Date = new Date()): string {
  return `${base}-${toDateInput(now)}.csv`;
}

/** Trigger a browser download of `csv` as `filename`. */
export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick, not synchronously — some browsers tear the
  // blob down before the download actually starts if the URL is revoked in
  // the same task as `click()`.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
