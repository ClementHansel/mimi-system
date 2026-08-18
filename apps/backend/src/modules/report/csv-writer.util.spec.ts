import { describe, expect, it } from 'vitest';
import { toCsvRow, writeCsv } from './csv-writer.util';

describe('toCsvRow', () => {
  it('joins plain cells with commas, unquoted', () => {
    expect(toCsvRow(['a', 'b', 1, true])).toBe('a,b,1,true');
  });

  it('renders null/undefined as an empty field, not the literal string', () => {
    expect(toCsvRow(['a', null, undefined, 'b'])).toBe('a,,,b');
  });

  it('quotes and doubles internal quotes for a cell containing a comma', () => {
    expect(toCsvRow(['Ayam, Goreng'])).toBe('"Ayam, Goreng"');
  });

  it('quotes and doubles a literal double-quote inside a cell', () => {
    expect(toCsvRow(['12" pizza'])).toBe('"12"" pizza"');
  });

  it('quotes a cell containing an embedded newline', () => {
    expect(toCsvRow(['line1\nline2'])).toBe('"line1\nline2"');
  });

  it('leaves a Money/Qty decimal string exactly as given (no rounding, no numeric coercion)', () => {
    // Money/Qty are NUMERIC(18,2)/(14,3) decimal STRINGS from `pg` — this asserts the writer never
    // routes them through `Number()`, which would silently drop a trailing zero.
    expect(toCsvRow(['150000.00', '3.500'])).toBe('150000.00,3.500');
  });
});

describe('writeCsv', () => {
  it('produces a header row, CRLF-joined data rows, a trailing CRLF, and a leading UTF-8 BOM', () => {
    const csv = writeCsv(
      ['itemName', 'qty'],
      [
        ['Ayam Fillet', '10.000'],
        ['Tepung', '25.000'],
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const body = csv.slice(1);
    expect(body).toBe('itemName,qty\r\nAyam Fillet,10.000\r\nTepung,25.000\r\n');
  });

  it('quotes a header/data field that itself needs quoting', () => {
    const csv = writeCsv(['name, with comma'], [['value "quoted"']]);
    const body = csv.slice(1);
    expect(body).toBe('"name, with comma"\r\n"value ""quoted"""\r\n');
  });

  it('produces only the header + trailing CRLF for zero data rows', () => {
    const csv = writeCsv(['a', 'b'], []);
    expect(csv.slice(1)).toBe('a,b\r\n');
  });
});
