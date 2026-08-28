import { describe, expect, it } from 'vitest';
import { normalizeHeader, parseCsv, parseDecimal } from './csv-parse';
import { toCsv } from '@/lib/export/csv';

/**
 * These are the cases that decide whether a line import is trustworthy, so they
 * are tested against real spreadsheet output rather than tidy hand-written CSV:
 * an Excel round trip (BOM, CRLF, semicolons), a clipboard paste (tabs), and
 * Indonesian number formatting. A parser that is merely "mostly right" here
 * silently writes off the wrong quantity of stock, which is the failure this
 * whole path exists to avoid.
 */
describe('parseCsv', () => {
  it('reads a plain comma file with CRLF rows', () => {
    const parsed = parseCsv('Nama Barang,Jumlah\r\nAyam Fillet Dada,3\r\nBakso Ayam,1,5\r\n');
    expect(parsed.headers).toEqual(['Nama Barang', 'Jumlah']);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]!.get('Nama Barang')).toBe('Ayam Fillet Dada');
    expect(parsed.rows[0]!.line).toBe(2);
  });

  it('does not report a phantom blank row for a trailing newline', () => {
    expect(parseCsv('A,B\r\n1,2\r\n').rows).toHaveLength(1);
    expect(parseCsv('A,B\n1,2').rows).toHaveLength(1);
  });

  it('strips the UTF-8 BOM instead of gluing it to the first header', () => {
    const parsed = parseCsv('﻿SKU,Jumlah\r\nAB-1,2\r\n');
    expect(parsed.headers[0]).toBe('SKU');
    expect(parsed.rows[0]!.get('SKU')).toBe('AB-1');
  });

  it('accepts a file this app exported, unedited', () => {
    // The round trip the importers are built around: `toCsv` writes a BOM,
    // CRLF rows and RFC4180 quoting, and its own output must parse back.
    const csv = toCsv(
      [{ name: 'Ayam, Utuh', qty: '2' }],
      [
        { key: 'name', header: 'Nama Barang' },
        { key: 'qty', header: 'Jumlah' },
      ],
    );
    const parsed = parseCsv(csv);
    expect(parsed.rows[0]!.get('Nama Barang')).toBe('Ayam, Utuh');
    expect(parsed.rows[0]!.get('Jumlah')).toBe('2');
  });

  it('honours quotes containing the delimiter, doubled quotes and line breaks', () => {
    const parsed = parseCsv('A,B\r\n"x,y","he said ""hi"""\r\n"multi\nline",2\r\n');
    expect(parsed.rows[0]!.get('A')).toBe('x,y');
    expect(parsed.rows[0]!.get('B')).toBe('he said "hi"');
    expect(parsed.rows[1]!.get('A')).toBe('multi\nline');
    expect(parsed.rows).toHaveLength(2);
  });

  it('detects a semicolon file (Excel on an Indonesian/European locale)', () => {
    const parsed = parseCsv('Nama Barang;Jumlah\r\nAyam Paha Atas;2,5\r\n');
    expect(parsed.headers).toEqual(['Nama Barang', 'Jumlah']);
    expect(parsed.rows[0]!.get('Jumlah')).toBe('2,5');
  });

  it('detects a tab file (a block of cells pasted from a spreadsheet)', () => {
    const parsed = parseCsv('Nama Barang\tJumlah\nAyam Wing Berbumbu\t4\n');
    expect(parsed.rows[0]!.get('Nama Barang')).toBe('Ayam Wing Berbumbu');
    expect(parsed.rows[0]!.get('Jumlah')).toBe('4');
  });

  it('matches headers regardless of case and stray whitespace', () => {
    const parsed = parseCsv('  nama   barang ,JUMLAH\r\nBeras Premium,10\r\n');
    expect(parsed.rows[0]!.get('Nama Barang')).toBe('Beras Premium');
    expect(parsed.rows[0]!.get('Jumlah')).toBe('10');
  });

  it('reads a missing trailing cell as blank, not undefined', () => {
    const parsed = parseCsv('A,B,C\r\n1,2\r\n');
    expect(parsed.rows[0]!.get('C')).toBe('');
  });

  it('flags an all-blank row so callers skip it instead of erroring five times', () => {
    const parsed = parseCsv('A,B\r\n1,2\r\n , \r\n');
    expect(parsed.rows[1]!.isBlank).toBe(true);
    expect(parsed.rows[0]!.isBlank).toBe(false);
  });

  it('takes the FIRST of two identically named columns', () => {
    const parsed = parseCsv('Jumlah,Jumlah\r\n7,\r\n');
    expect(parsed.rows[0]!.get('Jumlah')).toBe('7');
  });

  it('returns nothing for empty input rather than throwing', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
  });
});

describe('normalizeHeader', () => {
  it('folds case and collapses whitespace', () => {
    expect(normalizeHeader('  Area   Penyimpanan ')).toBe('area penyimpanan');
  });
});

describe('parseDecimal', () => {
  it('reads plain and dot-decimal numbers', () => {
    expect(parseDecimal('12')).toBe('12');
    expect(parseDecimal('2.5')).toBe('2.5');
    expect(parseDecimal(' 3 ')).toBe('3');
  });

  it('reads an Indonesian decimal comma', () => {
    expect(parseDecimal('2,5')).toBe('2.5');
  });

  it('reads Indonesian grouping with a decimal comma', () => {
    expect(parseDecimal('1.234,5')).toBe('1234.5');
  });

  it('reads English grouping with a decimal point', () => {
    expect(parseDecimal('1,234.5')).toBe('1234.5');
  });

  it('treats exactly three digits after a lone comma as grouping', () => {
    // `1,500` from a spreadsheet means fifteen hundred, not one and a half.
    expect(parseDecimal('1,500')).toBe('1500');
  });

  it('keeps a negative sign so the caller can reject it', () => {
    // Quantity importers refuse negatives themselves — parsing must not hide
    // one by returning null, which would read as "not a number".
    expect(parseDecimal('-4')).toBe('-4');
  });

  it('returns null for anything that is not a number', () => {
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('dua')).toBeNull();
    expect(parseDecimal('12kg')).toBeNull();
    expect(parseDecimal('1.2.3')).toBeNull();
    expect(parseDecimal('-')).toBeNull();
  });
});
