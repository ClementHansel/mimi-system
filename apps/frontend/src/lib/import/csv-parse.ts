/**
 * Client-side CSV parsing, for the LINE importers.
 *
 * WHY THERE IS A SECOND CSV PATH AT ALL. `components/import/ImportPanel` is
 * the server-validated importer for MASTER DATA: it uploads the file,
 * `POST .../preview` answers would-create/would-update/error per row, and
 * `POST .../commit` writes. That shape is right for a table upserted on a
 * natural key (items, employees, accounts) and wrong for a TRANSACTIONAL
 * document. There is no natural key to upsert an opname count, a waste
 * write-off or a purchase request on; re-importing the same file must not
 * "update" yesterday's waste record, and a half-committed document is not a
 * state the domain services allow. Waste needs a photo attached, retur needs a
 * per-line reason, opname needs the variance rules — none of which a
 * fire-and-forget row-upserter can honour.
 *
 * So a line import fills IN THE FORM instead of bypassing it: the CSV becomes
 * the draft lines, the operator sees them in the modal they already use, and
 * the one existing endpoint does the writing with all its validation intact.
 * A wrong file is then a wrong draft, which is recoverable, instead of a
 * committed document that has to be cancelled.
 *
 * The parser is deliberately small but not naive — it is RFC4180-correct for
 * the cases a spreadsheet actually produces, because the file being imported is
 * usually one this app exported (`lib/export/csv.ts`) and edited in Excel:
 *   - a UTF-8 BOM (which `toCsv` writes) is stripped, not read as part of the
 *     first header's name;
 *   - quoted fields may contain the delimiter, doubled quotes and line breaks;
 *   - CRLF and LF both end a row, and a trailing newline is not a blank row;
 *   - `;`- and tab-delimited files are detected, because Excel on an Indonesian
 *     or European locale writes semicolons by default and the operator has no
 *     idea that is what happened.
 */

export interface ParsedCsv {
  /** Header names, trimmed, in file order. */
  headers: string[];
  /** One record per data row, keyed by header. Missing trailing cells read as ''. */
  rows: CsvRecord[];
}

export interface CsvRecord {
  /** 1-based line number IN THE FILE (the header is line 1) — what an error must cite. */
  line: number;
  get(header: string): string;
  /** Every cell is blank — callers skip these instead of reporting five errors for one empty row. */
  isBlank: boolean;
}

/**
 * Which delimiter this file uses. Counted OUTSIDE quotes and on the header line
 * only: a header is short, never contains a line break, and is the one row
 * guaranteed to carry every delimiter the file uses.
 */
function detectDelimiter(text: string): ',' | ';' | '\t' {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  let commas = 0;
  let semis = 0;
  let tabs = 0;
  let inQuotes = false;
  for (const ch of firstLine) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (inQuotes) continue;
    else if (ch === ',') commas += 1;
    else if (ch === ';') semis += 1;
    else if (ch === '\t') tabs += 1;
  }
  if (semis > commas && semis >= tabs) return ';';
  if (tabs > commas && tabs > semis) return '\t';
  return ',';
}

/** Split the whole text into rows of cells, honouring quotes across newlines. */
function splitRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);

    if (inQuotes) {
      if (ch === '"') {
        // A doubled quote is one literal quote; a lone one closes the field.
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }

    if (ch === '"' && cell === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\r') {
      // Swallow it; the \n that follows ends the row. On classic-Mac line
      // endings there is no \n, so end the row here instead.
      if (text.charAt(i + 1) !== '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      }
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }

  // A last row exists only if the file did NOT end on a newline — otherwise
  // this is the phantom blank row every naive parser reports.
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * Header matching is FORGIVING, one way only. An operator round-trips a file
 * through Excel and comes back with "Nama Barang " or "nama barang"; refusing
 * that file teaches them the importer is fussy rather than that their file is
 * wrong. Case, surrounding whitespace and repeated inner spaces are ignored.
 */
export function normalizeHeader(header: string): string {
  return header.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Parse CSV text into headers + keyed records. Never throws on malformed input. */
export function parseCsv(text: string): ParsedCsv {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(withoutBom);
  const raw = splitRows(withoutBom, delimiter);
  if (raw.length === 0) return { headers: [], rows: [] };

  const headers = (raw[0] ?? []).map((h) => h.trim());
  const index = new Map<string, number>();
  headers.forEach((h, i) => {
    const key = normalizeHeader(h);
    // FIRST wins on a duplicated header: a file with two "Qty" columns is
    // already a mistake, and silently reading the later (usually empty) one is
    // the surprising half of it.
    if (!index.has(key)) index.set(key, i);
  });

  const rows: CsvRecord[] = raw.slice(1).map((cells, i) => ({
    line: i + 2,
    isBlank: cells.every((c) => c.trim() === ''),
    get(header: string): string {
      const at = index.get(normalizeHeader(header));
      return at === undefined ? '' : (cells[at] ?? '').trim();
    },
  }));

  return { headers, rows };
}

/**
 * Read a `File` as UTF-8 text and parse it. Excel on Windows can still write
 * Windows-1252 without a BOM, which decodes to mojibake rather than an error —
 * that is a legibility problem the operator can SEE in the preview table and
 * fix by re-saving as "CSV UTF-8", not something to guess at here.
 */
export async function readCsvFile(file: File): Promise<ParsedCsv> {
  return parseCsv(await file.text());
}

/**
 * The number an operator typed, as the API's decimal string.
 *
 * Indonesian spreadsheets write `1.234,5`; English ones write `1,234.5`; a hand
 * edit writes `1234,5`. All three mean the same quantity, and `Number()` on any
 * of them is either wrong or `NaN`. Returns `null` when the text is not a number
 * at all, so the caller reports a row error instead of importing a silent zero —
 * the failure mode that would write off the wrong amount of stock.
 */
export function parseDecimal(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  const hasComma = trimmed.includes(',');
  const hasDot = trimmed.includes('.');
  let normalized = trimmed;

  if (hasComma && hasDot) {
    // Whichever separator comes LAST is the decimal point; the other groups
    // thousands. `1.234,5` -> comma last -> the dots are grouping.
    normalized =
      trimmed.lastIndexOf(',') > trimmed.lastIndexOf('.')
        ? trimmed.replace(/\./g, '').replace(',', '.')
        : trimmed.replace(/,/g, '');
  } else if (hasComma) {
    // A single comma is a decimal comma UNLESS it is grouping: `1,5` is one and
    // a half, while a spreadsheet writes thousands as `1,500`, so exactly three
    // trailing digits is read as grouping.
    normalized = /,\d{3}$/.test(trimmed) ? trimmed.replace(/,/g, '') : trimmed.replace(',', '.');
  }

  normalized = normalized.replace(/\s/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(normalized)) return null;
  return normalized;
}
