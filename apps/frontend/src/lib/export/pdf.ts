/**
 * Reusable PDF export: a hand-rolled, zero-dependency PDF writer, built from
 * the same `CsvColumn<T>` shape as `./csv.ts` so one toolbar (see
 * `ExportButton`) can offer "Ekspor CSV" and "Ekspor PDF" from the exact same
 * columns array.
 *
 * ## Why hand-rolled instead of `window.print()` (option a) or `jsPDF` (option b)
 *
 * This codebase already has BOTH of the obvious answers in it, for two
 * different jobs, and neither fits a list/report export:
 *
 *  - `app/print/**` + `window.print()` is the house pattern for a document a
 *    human signs on paper (Surat Jalan, slip gaji) — see `print.css`'s own
 *    comment for why no PDF generator ships for that. It stays exactly as is
 *    for the Surat Jalan (wired below via its existing print route). But it
 *    is unusable for THIS deliverable's verification bar ("generate a real
 *    file, open or parse it") — there is no headless browser in this box
 *    (explicitly ruled out: shared, memory-constrained), so a
 *    `window.print()` path can never be exercised by a script or a test, only
 *    by a human clicking through a dialog. A feature that cannot be verified
 *    except by hand is not verified.
 *  - `jsPDF` (option b) would be a genuinely new runtime dependency for
 *    something this codebase has a standing precedent for NOT doing:
 *    `xlsx-writer.util.ts` hand-rolled a full `.xlsx` (a ZIP of XML) rather
 *    than add `exceljs`, specifically to avoid lockfile churn and
 *    supply-chain surface for "the same rows the CSV path already produces,
 *    in another format". A tabular PDF report is the same shape of problem,
 *    and — unlike `.xlsx` — a minimal PDF is actually simpler to hand-roll:
 *    standard PDF readers ship 14 built-in fonts that need no embedding, and
 *    Courier's metrics are EXACTLY 0.6em per character (not a heuristic),
 *    which turns "lay out a table" into fixed-width text columns instead of
 *    proportional-font measurement.
 *
 * So: this file IS the PDF generator, in the same spirit as the xlsx writer,
 * and it produces plain `Uint8Array` bytes with no browser API — callable
 * from a script or a `vitest` test exactly like `toCsv`, which is how
 * `pdf.test.ts` verifies a real, structurally-valid file without a headless
 * browser or a PDF-parsing dependency.
 *
 * ## What this deliberately does NOT do
 *
 * No embedded fonts (so no full Unicode — non-Latin-1 characters render as
 * `?`, the same "would rather show a placeholder than corrupt the file"
 * choice `xlsx-writer.util.ts` makes for control characters), no
 * compression, no word-wrap (cells truncate with `..`), one monospaced
 * report style. Bahasa Indonesia text (this app's only locale) is plain
 * Latin-1, so this covers every real row this app will ever export. The
 * day this needs proportional fonts, the honest move is `jsPDF`, not growing
 * this file into one.
 *
 * ## Brand
 *
 * The heading, the rule under it and the footer take the owner's brand
 * colours (`PdfBrand`), so a data export matches the invoices and receipts
 * the designed-document path prints. Colour was cheap — `r g b rg` is one
 * operator and needs no new object types.
 *
 * THE BRAND *LOGO* IS STILL NOT HERE, and that is a real limit rather than an
 * oversight. Placing a raster logo means a PDF image XObject: a JPEG can be
 * passed through with `DCTDecode`, but the logo an owner uploads is usually a
 * PNG, and PNG needs its zlib stream un-filtered and re-encoded (or the whole
 * image decoded to raw RGB) before it can be embedded — hundreds of lines of
 * image handling in a file whose entire justification is that it hand-rolls
 * only what is trivial to get exactly right. Documents that genuinely need
 * the logo (invoice, receipt, voucher, Surat Jalan) go through the designed-
 * template path instead (`components/documents/**`), which renders in the
 * browser where an `<img>` costs nothing. This exporter is for LISTS.
 */

import type { CsvColumn } from './csv';

// --- Page geometry (A4, points) --------------------------------------------
// Kept as named constants (not inlined magic numbers) because every layout
// value below — rows per page, column budget — is DERIVED from these, not
// hand-tuned separately; change a margin here and pagination stays correct.
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2;

const TITLE_SIZE = 13;
const META_SIZE = 8;
const HEAD_SIZE = 9;
const BODY_SIZE = 9;
const LINE_H = 12;
// Courier's PDF standard-14 metric is 600/1000 em for EVERY character in
// EVERY style (regular/bold) — an exact constant, not a font-measurement
// heuristic, which is what makes fixed-width column math safe here.
const CHAR_W = 0.6;

const TITLE_Y = PAGE_H - MARGIN;
const META_Y = TITLE_Y - 16;
const RULE1_Y = META_Y - 10;
const HEAD_Y = RULE1_Y - 12;
const RULE2_Y = HEAD_Y - 5;
const FIRST_ROW_Y = RULE2_Y - LINE_H;
const FOOTER_RULE_Y = MARGIN + 16;
const FOOTER_TEXT_Y = MARGIN + 4;
const ROWS_AREA_BOTTOM = FOOTER_RULE_Y + 8;

const ROWS_PER_PAGE = Math.max(1, Math.floor((FIRST_ROW_Y - ROWS_AREA_BOTTOM) / LINE_H) + 1);
const MAX_TABLE_CHARS = Math.floor(CONTENT_W / (BODY_SIZE * CHAR_W));

/**
 * The brand colours this exporter uses. Only TWO of the four, deliberately:
 * a data export is a document someone reads a hundred rows off, so the brand
 * appears as the heading and the rules, and the body stays black. Printing
 * table rows in a mid-tone brand colour is how a report becomes unreadable on
 * a tired office laser — and the rows are the entire point of the file.
 */
export interface PdfBrand {
  /** Heading + the rule under it. `#rrggbb`. */
  primary: string;
  /** Footer rule and footer text. `#rrggbb`. */
  muted: string;
}

export interface PdfDocOptions {
  /** Printed as the page heading, e.g. "Stok Gudang". */
  title: string;
  /**
   * The "generated at" line, ALREADY composed by the caller through `t()` —
   * this file stays copy-agnostic like `csv.ts`, so the WITA business
   * timestamp text (e.g. "Dibuat: 25 Agu 2026, 10.00 WITA") is built by the
   * caller, not baked in here.
   */
  generatedLabel: string;
  /** "Halaman {page} dari {total}", composed per page by the caller. */
  pageLabel: (page: number, totalPages: number) => string;
  /** Shown in place of the table when there are zero rows. */
  emptyLabel: string;
  /**
   * The company name printed in the footer. Was hardcoded to "Mimi Chicken
   * OS" — which was both a user-facing string inside a formatting library and
   * the wrong name once an owner sets their own in `company.profile`.
   * Optional so every existing call site keeps its current output.
   */
  footerLabel?: string;
  /**
   * Brand colours. Omitted = the all-black document this exporter has always
   * produced, which is what keeps this change safe for callers that have no
   * brand context (a test, a script).
   */
  brand?: PdfBrand;
}

const DEFAULT_FOOTER_LABEL = 'Mimi Chicken OS';

/**
 * `#rrggbb` → a PDF `r g b` operand triple in the 0–1 range the `rg`/`RG`
 * operators take. Junk in gives black out rather than throwing: this runs
 * against a colour that came from a settings row, and an export that fails to
 * generate is worse than one printed in black.
 */
function pdfColor(hex: string | undefined): string {
  const match = /^#([0-9a-fA-F]{6})$/.exec((hex ?? '').trim());
  if (!match?.[1]) return '0 0 0';
  const int = parseInt(match[1], 16);
  const channel = (shift: number) => (((int >> shift) & 0xff) / 255).toFixed(3);
  return `${channel(16)} ${channel(8)} ${channel(0)}`;
}

// Numbers, money (`Rp 12.345,00`), and percentages read better right-aligned;
// everything else (names, statuses) reads better left-aligned. This mirrors
// how every table in this app already right-aligns `tabular-nums` cells.
const NUMERIC_CELL = /^-?(rp\s?)?\d[\d.,]*%?$/i;

function cellText(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  return String(raw).replace(/[\r\n]+/g, ' ');
}

// WinAnsiEncoding IS Windows-1252 — for U+00A0-U+00FF it happens to match
// Unicode byte-for-byte, but 0x80-0x9F is NOT the Unicode C1 control range
// there; cp1252 repurposes those bytes for em/en dash, curly quotes, bullet,
// ellipsis, trademark, etc. — exactly the punctuation a name pasted in from
// Word/Google Docs tends to carry. Map the ones with a real glyph in the
// standard-14 fonts; anything else outside Latin-1 still becomes `?` rather
// than corrupting the content stream (the same trade-off `xlsx-writer.util.ts`
// makes for control characters in `.xlsx`).
const CP1252_EXTRA: Readonly<Record<number, number>> = {
  0x20ac: 0x80, // €
  0x201a: 0x82, // ‚
  0x0192: 0x83, // ƒ
  0x201e: 0x84, // „
  0x2026: 0x85, // …
  0x2020: 0x86, // †
  0x2021: 0x87, // ‡
  0x02c6: 0x88, // ˆ
  0x2030: 0x89, // ‰
  0x0160: 0x8a, // Š
  0x2039: 0x8b, // ‹
  0x0152: 0x8c, // Œ
  0x017d: 0x8e, // Ž
  0x2018: 0x91, // '
  0x2019: 0x92, // '
  0x201c: 0x93, // "
  0x201d: 0x94, // "
  0x2022: 0x95, // •
  0x2013: 0x96, // –
  0x2014: 0x97, // —
  0x02dc: 0x98, // ˜
  0x2122: 0x99, // ™
  0x0161: 0x9a, // š
  0x203a: 0x9b, // ›
  0x0153: 0x9c, // œ
  0x017e: 0x9e, // ž
  0x0178: 0x9f, // Ÿ
};

function toWinAnsi(text: string): string {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) {
      out += text[i];
      continue;
    }
    const mapped = CP1252_EXTRA[code];
    out += mapped !== undefined ? String.fromCharCode(mapped) : '?';
  }
  return out;
}

/** PDF literal-string escaping: backslash and parens must be escaped. */
function escapePdfText(text: string): string {
  return toWinAnsi(text).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function padCell(text: string, width: number, alignRight: boolean): string {
  const fitted =
    text.length > width
      ? width > 2
        ? `${text.slice(0, width - 2)}..`
        : text.slice(0, width)
      : text;
  const pad = ' '.repeat(Math.max(width - fitted.length, 0));
  return alignRight ? pad + fitted : fitted + pad;
}

/**
 * Natural width per column (header vs. every formatted cell, from the FULL
 * row set so alignment is stable across pages), then scaled down together if
 * the total would overflow the page — never truncated column-by-column in a
 * way that could silently drop only the last columns.
 */
function computeColumnWidths<T>(rows: readonly T[], columns: readonly CsvColumn<T>[]): number[] {
  const naturals = columns.map((col) => {
    let width = col.header.length;
    for (const row of rows) {
      const raw = col.format ? col.format(row) : row[col.key];
      width = Math.max(width, cellText(raw).length);
    }
    return Math.min(Math.max(width, 3), 28);
  });
  const gapTotal = Math.max(columns.length - 1, 0) * 2;
  const naturalTotal = naturals.reduce((a, b) => a + b, 0);
  if (naturalTotal === 0 || naturalTotal + gapTotal <= MAX_TABLE_CHARS) return naturals;
  const budget = Math.max(MAX_TABLE_CHARS - gapTotal, columns.length * 3);
  const scale = budget / naturalTotal;
  return naturals.map((width) => Math.max(3, Math.floor(width * scale)));
}

function buildHeaderLine<T>(columns: readonly CsvColumn<T>[], widths: number[]): string {
  return columns.map((col, i) => padCell(col.header, widths[i]!, false)).join('  ');
}

function buildRowLine<T>(row: T, columns: readonly CsvColumn<T>[], widths: number[]): string {
  return columns
    .map((col, i) => {
      const text = cellText(col.format ? col.format(row) : row[col.key]);
      return padCell(text, widths[i]!, NUMERIC_CELL.test(text.trim()));
    })
    .join('  ');
}

/** One `/font size Tf 1 0 0 1 x y Tm (text) Tj` line — absolute positioning via `Tm`, so pages never depend on cumulative `Td` offsets. */
function textOp(x: number, y: number, font: 'F1' | 'F2', size: number, text: string): string {
  return `/${font} ${size} Tf 1 0 0 1 ${x} ${y} Tm (${escapePdfText(text)}) Tj`;
}

/** A thin filled rectangle, used as a horizontal rule. */
function ruleOp(y: number, height: number): string {
  return `${MARGIN} ${y} ${CONTENT_W} ${height} re f`;
}

function buildPageContent(
  pageRows: string[],
  headerLine: string,
  pageIndex: number,
  totalPages: number,
  options: PdfDocOptions,
): string {
  const brandFill = pdfColor(options.brand?.primary);
  const mutedFill = pdfColor(options.brand?.muted);

  const lines: string[] = ['0 0 0 rg', 'BT'];
  // The heading carries the brand colour; everything after it is reset to
  // black in the same text object, so a colour never leaks into the rows.
  lines.push(`${brandFill} rg`);
  lines.push(textOp(MARGIN, TITLE_Y, 'F2', TITLE_SIZE, options.title));
  lines.push('0 0 0 rg');
  lines.push(textOp(MARGIN, META_Y, 'F1', META_SIZE, options.generatedLabel));

  const pageText = options.pageLabel(pageIndex + 1, totalPages);
  const pageTextW = pageText.length * META_SIZE * CHAR_W;
  lines.push(textOp(MARGIN + CONTENT_W - pageTextW, META_Y, 'F1', META_SIZE, pageText));

  lines.push(textOp(MARGIN, HEAD_Y, 'F2', HEAD_SIZE, headerLine));

  if (pageRows.length === 0) {
    lines.push(textOp(MARGIN, FIRST_ROW_Y, 'F1', BODY_SIZE, options.emptyLabel));
  } else {
    pageRows.forEach((line, i) => {
      lines.push(textOp(MARGIN, FIRST_ROW_Y - i * LINE_H, 'F1', BODY_SIZE, line));
    });
  }
  lines.push('ET');

  // The heavy rule under the title is the brand's second appearance; the
  // column rule stays black because it belongs to the table, and the footer
  // rule is muted so it recedes from the data above it.
  lines.push(`${brandFill} rg`);
  lines.push(ruleOp(RULE1_Y, 0.75));
  lines.push('0 0 0 rg');
  lines.push(ruleOp(RULE2_Y, 0.5));
  lines.push(`${mutedFill} rg`);
  lines.push(ruleOp(FOOTER_RULE_Y, 0.5));

  // BUG FIX: this footer line's `Tf`/`Tm`/`Tj` operators used to sit OUTSIDE
  // any text object. Those are text operators and are only valid between `BT`
  // and `ET` (PDF spec 9.4) — lenient viewers ignored the stray operators and
  // silently dropped the footer, which is why an invalid file still looked
  // fine in a browser and why nobody noticed. It gets its own `BT`/`ET` here
  // rather than being moved up into the first one, so it keeps its own fill
  // colour without having to restore black afterwards.
  lines.push('BT');
  lines.push(
    textOp(MARGIN, FOOTER_TEXT_Y, 'F1', META_SIZE, options.footerLabel ?? DEFAULT_FOOTER_LABEL),
  );
  lines.push('ET');
  lines.push('0 0 0 rg');

  return lines.join('\n');
}

interface PdfObject {
  id: number;
  text: string;
}

/**
 * Concatenate objects + a byte-exact xref table + trailer. Mirrors
 * `xlsx-writer.util.ts`'s `buildZip`: track offsets as we go, write a
 * conforming index afterwards, rather than a streaming/pretty-printed
 * approach that would make offsets hard to get exactly right.
 */
function serializePdf(objects: PdfObject[], rootId: number): Uint8Array<ArrayBuffer> {
  let out = '%PDF-1.4\n';
  const offsets = new Map<number, number>();
  for (const obj of objects) {
    offsets.set(obj.id, out.length);
    out += `${obj.id} 0 obj\n${obj.text}\nendobj\n`;
  }

  const xrefOffset = out.length;
  const maxId = Math.max(...objects.map((o) => o.id));
  out += `xref\n0 ${maxId + 1}\n`;
  // Every entry is EXACTLY 20 bytes (PDF spec 7.5.4): 10-digit offset, SP,
  // 5-digit generation, SP, keyword, then a 2-byte EOL — no trailing space
  // before the EOL, which is the easiest way to end up 1 byte short/long.
  out += '0000000000 65535 f\r\n';
  for (let id = 1; id <= maxId; id += 1) {
    const offset = offsets.get(id);
    out +=
      offset === undefined
        ? '0000000000 00000 f\r\n'
        : `${String(offset).padStart(10, '0')} 00000 n\r\n`;
  }
  out += `trailer\n<< /Size ${maxId + 1} /Root ${rootId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;

  // Every character above was constructed to be <= 0xFF (WinAnsi/Latin-1),
  // so `charCodeAt` is already the byte value — no TextEncoder/UTF-8 step,
  // which would be WRONG here (it would multi-byte-encode the very bytes
  // this format needs to stay single-byte).
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i += 1) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

/**
 * Build a complete, multi-page PDF from the SAME `rows`/`columns` shape as
 * `toCsv` — a monospaced (Courier) report: title, a "generated at" + page
 * number line repeated on every page, then a fixed-width table with its
 * header row repeated on every page (same reason `print.css` repeats
 * `<thead>` across a paginated print: a reader should never lose the column
 * labels partway down a long list).
 */
export function toPdf<T>(
  rows: readonly T[],
  columns: readonly CsvColumn<T>[],
  options: PdfDocOptions,
): Uint8Array<ArrayBuffer> {
  const widths = computeColumnWidths(rows, columns);
  const headerLine = buildHeaderLine(columns, widths);
  const rowLines = rows.map((row) => buildRowLine(row, columns, widths));

  const chunks: string[][] = [];
  for (let i = 0; i < rowLines.length; i += ROWS_PER_PAGE) {
    chunks.push(rowLines.slice(i, i + ROWS_PER_PAGE));
  }
  if (chunks.length === 0) chunks.push([]);

  const objects: PdfObject[] = [
    { id: 1, text: '<< /Type /Catalog /Pages 2 0 R >>' },
    {
      id: 2,
      text: `<< /Type /Pages /Kids [${chunks.map((_, i) => `${5 + i * 2} 0 R`).join(' ')}] /Count ${chunks.length} >>`,
    },
    {
      id: 3,
      text: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>',
    },
    {
      id: 4,
      text: '<< /Type /Font /Subtype /Type1 /BaseFont /Courier-Bold /Encoding /WinAnsiEncoding >>',
    },
  ];

  chunks.forEach((pageRows, i) => {
    const pageId = 5 + i * 2;
    const contentId = 6 + i * 2;
    const content = buildPageContent(pageRows, headerLine, i, chunks.length, options);
    objects.push({
      id: pageId,
      text: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`,
    });
    objects.push({
      id: contentId,
      text: `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    });
  });

  return serializePdf(objects, 1);
}

/**
 * `<base>-<WITA business date>.pdf` — same rule as `csv.ts`'s
 * `businessDateFilename`: the WITA calendar day, never the machine-local one.
 */
export function businessDatePdfFilename(base: string, now: Date = new Date()): string {
  // Reuses `fmtDateTime` purely to stay on ONE WITA-formatting code path;
  // the filename wants `YYYY-MM-DD`, so re-derive it the same way `csv.ts`
  // does rather than parsing `fmtDateTime`'s human-readable output.
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Makassar',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  return `${base}-${iso}.pdf`;
}

/** Trigger a browser download of `bytes` as `filename` — mirrors `downloadCsv`. */
export function downloadPdf(filename: string, bytes: Uint8Array<ArrayBuffer>): void {
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
