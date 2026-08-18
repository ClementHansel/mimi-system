/**
 * Minimal hand-rolled CSV serializer — no npm dependency (there is no CSV
 * library anywhere in this workspace's package.json/node_modules, confirmed
 * by grep before writing this; adding one is out of scope for a read-only
 * export path this small). RFC 4180 quoting: a field is wrapped in double
 * quotes and its own quotes doubled whenever it contains a comma, a double
 * quote, or a newline (`\n`/`\r`) — the three characters that would
 * otherwise corrupt the delimited structure.
 *
 * Every cell is written as the STRING it was given, verbatim — this
 * matters for `Money`/`Qty` fields (`NUMERIC(18,2)`/`(14,3)` decimal
 * strings from `pg`): they must reach the CSV byte-for-byte, never routed
 * through `Number()`/template-string coercion that could round or drop
 * trailing zeros.
 */
function csvEscapeCell(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** One CSV row from already-stringified cells (`null`/`undefined` become an empty field). */
export function toCsvRow(cells: readonly (string | number | boolean | null | undefined)[]): string {
  return cells.map((c) => csvEscapeCell(c === null || c === undefined ? '' : String(c))).join(',');
}

/**
 * A full CSV document: header row + data rows, `\r\n` line endings (the
 * RFC 4180 convention Excel/Sheets expect on import) and a trailing UTF-8
 * BOM so Excel opens it without mis-detecting the encoding.
 */
export function writeCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [toCsvRow(header), ...rows.map((r) => toCsvRow(r))];
  return '﻿' + lines.join('\r\n') + '\r\n';
}
