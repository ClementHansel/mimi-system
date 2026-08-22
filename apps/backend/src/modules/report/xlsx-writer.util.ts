import { deflateRawSync } from 'node:zlib';

/**
 * D-22b — a real `.xlsx` writer, with NO npm dependency.
 *
 * ## Why this exists rather than `exceljs`
 *
 * All ten report endpoints advertised `format=xlsx` in CONTRACTS §4.19 and
 * returned **501** for it, because no spreadsheet library is in this workspace
 * and adding one routes through W1-A (BUILD-PLAN collision rule 2). PRD ASM-02
 * has the client's finance team living in Excel, so an advertised format that
 * always fails is a contract this system does not honour.
 *
 * An `.xlsx` is a ZIP of a handful of small XML parts. Node ships `zlib`, so
 * the whole thing is writable here in ~150 lines with no dependency, no
 * lockfile churn and no supply-chain surface — for a feature whose entire job
 * is "the same rows the CSV path already produces, in a workbook".
 *
 * ## What this deliberately does NOT do
 *
 * No formatting, no formulas, no multiple sheets, no column widths, no styles
 * part at all. Every cell is an inline string. That is a real limitation and it
 * is the right one: the moment this file grows a styles table it stops being a
 * defensible alternative to a maintained library, and the honest move then is
 * to add `exceljs` rather than to keep growing this.
 *
 * ## Why inline strings, and why everything is a string
 *
 * `Money`/`Qty` arrive from `pg` as decimal STRINGS (`NUMERIC(18,2)`/`(14,3)`).
 * Writing them as XLSX numbers would route them through an IEEE-754 double and
 * can silently round or drop trailing zeros — the same rule `csv-writer.util.ts`
 * states for the same reason. A finance export that quietly changes a figure is
 * worse than no export. Excel will still let the reader convert a column if
 * they want numbers; it cannot un-round what we rounded.
 *
 * `t="inlineStr"` also removes the need for a `sharedStrings.xml` part and its
 * index bookkeeping, which is the other half of what keeps this small.
 */

/** CRC-32 (IEEE 802.3), the checksum every ZIP entry header carries. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * Control characters XML 1.0 forbids outright — everything below 0x20 except
 * tab, newline and carriage return. Written as explicit `\u` escapes rather
 * than as literal bytes in a character class: literal control characters in
 * source are invisible in review and trivially mangled by any tool that
 * touches the file, and getting this class subtly wrong (an inverted `[^...]`,
 * say) would strip almost every REAL character from every export instead.
 *
 * `no-control-regex` is disabled on the line below deliberately: matching
 * control characters IS the purpose of this pattern. That rule exists to catch
 * them appearing by accident, which is the opposite of the case here.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;

/**
 * XML text escaping.
 *
 * Also strips characters XML 1.0 forbids outright (most control codes). A raw control byte — which a pasted-in supplier name or a mangled
 * import can genuinely contain — produces a file Excel refuses to open with no
 * useful message, so dropping them is better than emitting a corrupt workbook.
 */
function escapeXml(value: string): string {
  return value
    .replace(CONTROL_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** `0` → `A`, `25` → `Z`, `26` → `AA` — the spreadsheet column name for a zero-based index. */
export function columnName(index: number): string {
  let n = index;
  let name = '';
  for (;;) {
    name = String.fromCharCode(65 + (n % 26)) + name;
    if (n < 26) return name;
    n = Math.floor(n / 26) - 1;
  }
}

interface ZipEntry {
  name: string;
  data: Buffer;
}

/**
 * Builds the ZIP container by hand: local header + deflated data per entry,
 * then the central directory and the end-of-central-directory record.
 *
 * Timestamps are fixed at the DOS epoch (1980-01-01) rather than `Date.now()`,
 * so the same rows always produce byte-identical bytes. That makes the output
 * testable and diffable; a workbook whose bytes change every second cannot be
 * asserted on.
 */
function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.data);
    const crc = crc32(entry.data);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(0, 10); // mod time (fixed)
    local.writeUInt16LE(33, 12); // mod date = 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(deflated.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0); // central directory header signature
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6); // version needed
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(deflated.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30); // extra
    central.writeUInt16LE(0, 32); // comment
    central.writeUInt16LE(0, 34); // disk number
    central.writeUInt16LE(0, 36); // internal attrs
    central.writeUInt32LE(0, 38); // external attrs
    central.writeUInt32LE(offset, 42); // local header offset
    nameBuf.copy(central, 46);

    locals.push(local, deflated);
    centrals.push(central);
    offset += local.length + deflated.length;
  }

  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...locals, centralDir, eocd]);
}

function sheetXml(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const renderRow = (
    cells: readonly (string | number | boolean | null | undefined)[],
    rowNumber: number,
  ): string => {
    const tags = cells.map((cell, i) => {
      if (cell === null || cell === undefined || cell === '') {
        return `<c r="${columnName(i)}${rowNumber}"/>`;
      }
      return `<c r="${columnName(i)}${rowNumber}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(
        String(cell),
      )}</t></is></c>`;
    });
    return `<row r="${rowNumber}">${tags.join('')}</row>`;
  };

  const body = [renderRow(header, 1), ...rows.map((r, i) => renderRow(r, i + 2))].join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`;
}

/**
 * A complete single-sheet `.xlsx` workbook.
 *
 * `sheetName` is sanitised to Excel's own rules — 31 characters, and none of
 * `[]:*?/\` — because Excel silently refuses to open a workbook whose sheet
 * name breaks them, which would look like a corrupt export rather than a bad
 * filename.
 */
export function writeXlsx(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
  sheetName = 'Sheet1',
): Buffer {
  const safeSheet = (sheetName.replace(/[[\]:*?/\\]/g, '_').slice(0, 31) || 'Sheet1').trim();

  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
    '</Types>';

  const rootRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>';

  const workbook =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<sheets><sheet name="${escapeXml(safeSheet)}" sheetId="1" r:id="rId1"/></sheets>` +
    '</workbook>';

  const workbookRels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
    '</Relationships>';

  // Order matters to some readers: `[Content_Types].xml` must be the first entry.
  return buildZip([
    { name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
    { name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
    { name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
    { name: 'xl/worksheets/sheet1.xml', data: Buffer.from(sheetXml(header, rows), 'utf8') },
  ]);
}
