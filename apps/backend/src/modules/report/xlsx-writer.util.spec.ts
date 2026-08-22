import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { columnName, writeXlsx } from './xlsx-writer.util';

/**
 * D-22b — proof the hand-rolled workbook is actually a workbook.
 *
 * A dependency-free binary writer earns more scrutiny than a wrapper around a
 * library would, because there is no upstream test suite behind it and the
 * failure mode is silent: Excel refuses the file with a generic "we found a
 * problem", and nobody can tell which of the ZIP structure, the CRCs or the XML
 * was wrong. So these tests take the produced bytes APART — reading the central
 * directory, inflating each entry and checking the XML — rather than asserting
 * that some bytes came out.
 */

/** Minimal ZIP reader: walks the central directory and inflates every entry. */
function readZip(buf: Buffer): Map<string, string> {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record — not a ZIP at all');

  const count = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, string>();

  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory header');
    const compressedSize = buf.readUInt32LE(offset + 20);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8');

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local file header');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = buf.subarray(dataStart, dataStart + compressedSize);
    out.set(name, inflateRawSync(data).toString('utf8'));

    offset += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe('writeXlsx — a dependency-free .xlsx', () => {
  const header = ['Tanggal', 'Item', 'Qty', 'Nilai'] as const;
  const rows = [
    ['2026-08-23', 'Ayam Potong', '12.500', '1250000.00'],
    ['2026-08-23', 'Minyak Goreng', '3.000', '75000.00'],
  ];

  it('starts with the ZIP magic and round-trips through a real ZIP reader', () => {
    const buf = writeXlsx(header, rows);
    expect(buf.subarray(0, 2).toString('utf8')).toBe('PK');

    const parts = readZip(buf);
    // The five parts a minimal workbook needs; a reader that finds any of them
    // missing rejects the whole file.
    expect([...parts.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
  });

  it('puts the header in row 1 and each record in the rows after it', () => {
    const sheet = readZip(writeXlsx(header, rows)).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<row r="1">');
    expect(sheet).toContain('<t xml:space="preserve">Tanggal</t>');
    expect(sheet).toContain('<row r="2">');
    expect(sheet).toContain('<t xml:space="preserve">Ayam Potong</t>');
    expect(sheet).toContain('<row r="3">');
    expect(sheet).toContain('<t xml:space="preserve">Minyak Goreng</t>');
  });

  it('writes decimal strings VERBATIM — trailing zeros survive', () => {
    const sheet = readZip(writeXlsx(header, rows)).get('xl/worksheets/sheet1.xml')!;
    // The whole reason every cell is an inline string. `1250000.00` routed
    // through a JS number would come back `1250000` and a finance export would
    // have quietly changed a figure.
    expect(sheet).toContain('>1250000.00<');
    expect(sheet).toContain('>12.500<');
    expect(sheet).not.toContain('>1250000<');
  });

  it('escapes XML metacharacters instead of producing a file Excel refuses', () => {
    const sheet = readZip(writeXlsx(['Nama'], [['Ayam & "Spesial" <Pedas>']])).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(sheet).toContain('Ayam &amp; &quot;Spesial&quot; &lt;Pedas&gt;');
    expect(sheet).not.toContain('<Pedas>');
  });

  it('strips forbidden control characters rather than emitting invalid XML', () => {
    // A NUL or a 0x01 in a pasted supplier name is the realistic case. XML 1.0
    // cannot represent them at all, escaped or not, so Excel rejects the whole
    // workbook. Written with explicit \u escapes — a literal control byte in a
    // test file is invisible in review and mangled by the next tool to touch it.
    const sheet = readZip(writeXlsx(['Nama'], [['Ayam\u0000 Potong\u0001']])).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(sheet).toContain('Ayam Potong');
    expect(sheet).not.toContain('\u0000');
    expect(sheet).not.toContain('\u0001');

    // ...but tab, newline and carriage return are legal and must survive, or a
    // multi-line address silently loses its line breaks.
    const kept = readZip(writeXlsx(['Alamat'], [['Jl. A\nRT 01\tBlok C']])).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(kept).toContain('Jl. A\nRT 01\tBlok C');
  });

  it('leaves empty cells genuinely empty rather than writing the string "null"', () => {
    const sheet = readZip(writeXlsx(['A', 'B', 'C'], [['x', null, undefined]])).get(
      'xl/worksheets/sheet1.xml',
    )!;
    expect(sheet).toContain('<c r="B2"/>');
    expect(sheet).toContain('<c r="C2"/>');
    expect(sheet).not.toContain('null');
    expect(sheet).not.toContain('undefined');
  });

  it('sanitises a sheet name Excel would reject, instead of shipping an unopenable file', () => {
    const book = readZip(writeXlsx(header, rows, 'laporan/penjualan:2026'));
    const workbook = book.get('xl/workbook.xml')!;
    expect(workbook).toContain('laporan_penjualan_2026');

    // 31 characters is Excel's hard limit; a longer name is silently refused.
    const long = readZip(writeXlsx(header, rows, 'x'.repeat(60))).get('xl/workbook.xml')!;
    const name = /name="([^"]+)"/.exec(long)![1]!;
    expect(name.length).toBeLessThanOrEqual(31);
  });

  it('is byte-identical for identical input, so the output can be reasoned about', () => {
    // Fixed DOS timestamps rather than `Date.now()`. A workbook whose bytes
    // change every second cannot be asserted on or diffed.
    expect(writeXlsx(header, rows).equals(writeXlsx(header, rows))).toBe(true);
  });

  it('handles a workbook wider than 26 columns, where column names roll over', () => {
    expect(columnName(0)).toBe('A');
    expect(columnName(25)).toBe('Z');
    expect(columnName(26)).toBe('AA');
    expect(columnName(27)).toBe('AB');
    expect(columnName(51)).toBe('AZ');
    expect(columnName(52)).toBe('BA');

    const wide = Array.from({ length: 30 }, (_, i) => `col${i}`);
    const sheet = readZip(writeXlsx(wide, [wide])).get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<c r="AD1"');
  });

  it('survives an empty report — a month with no data must still open', () => {
    const parts = readZip(writeXlsx(header, []));
    const sheet = parts.get('xl/worksheets/sheet1.xml')!;
    expect(sheet).toContain('<row r="1">');
    expect(sheet).not.toContain('<row r="2">');
  });
});
