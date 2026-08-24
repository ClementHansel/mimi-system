import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toCsv, downloadCsv, businessDateFilename, type CsvColumn } from './csv';

interface Row {
  name: string;
  qty: number;
  note: string | null;
}

const columns: CsvColumn<Row>[] = [
  { key: 'name', header: 'Nama' },
  { key: 'qty', header: 'Qty' },
  { key: 'note', header: 'Catatan' },
];

describe('toCsv', () => {
  it('prefixes a UTF-8 BOM so Excel reads Indonesian characters as UTF-8, not Latin-1', () => {
    const csv = toCsv([{ name: 'Nasi Uduk Betawi', qty: 1, note: null }], columns);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it('joins the header and rows with CRLF, per RFC4180', () => {
    const csv = toCsv(
      [
        { name: 'Ayam Geprek', qty: 3, note: null },
        { name: 'Es Teh', qty: 5, note: null },
      ],
      columns,
    );
    const lines = csv.slice(1).split('\r\n');
    expect(lines).toEqual(['Nama,Qty,Catatan', 'Ayam Geprek,3,', 'Es Teh,5,']);
  });

  it('quotes a cell containing a comma, and doubles up any embedded quotes', () => {
    const csv = toCsv([{ name: 'Ayam, Bebek "Special"', qty: 1, note: null }], columns);
    expect(csv.slice(1).split('\r\n')[1]).toBe('"Ayam, Bebek ""Special"""' + ',1,');
  });

  it('quotes a cell containing an embedded newline', () => {
    const csv = toCsv([{ name: 'Line1\nLine2', qty: 1, note: null }], columns);
    expect(csv.slice(1).split('\r\n')[1]).toBe('"Line1\nLine2",1,');
  });

  it('renders null/undefined cells as an empty string, not "null"', () => {
    const csv = toCsv([{ name: 'Kerupuk', qty: 0, note: null }], columns);
    expect(csv.slice(1).split('\r\n')[1]).toBe('Kerupuk,0,');
  });

  it('applies a column `format` instead of reading the raw field', () => {
    const withFormat: CsvColumn<Row>[] = [
      { key: 'name', header: 'Nama' },
      { key: 'qty', header: 'Qty x2', format: (r) => r.qty * 2 },
    ];
    const csv = toCsv([{ name: 'Tahu', qty: 4, note: null }], withFormat);
    expect(csv.slice(1).split('\r\n')[1]).toBe('Tahu,8');
  });

  describe('formula injection guard', () => {
    // Outlet/product names are user-editable master data — a cell starting
    // with any of these is a live formula (or DDE trigger) the instant the
    // export is opened in Excel/Sheets, so each must come back apostrophe-prefixed.
    it.each([
      ["=cmd|' /C calc'!A1", "'=cmd|' /C calc'!A1"],
      ['+1+1', "'+1+1"],
      ['-1+1', "'-1+1"],
      ['@SUM(A1:A2)', "'@SUM(A1:A2)"],
      ['\tsneaky', "'\tsneaky"],
      ['\rsneaky', "'\rsneaky"],
    ])('escapes a cell starting with %j', (input, expected) => {
      const csv = toCsv([{ name: input, qty: 1, note: null }], columns);
      const firstCell = csv.slice(1).split('\r\n')[1].split(',')[0];
      // \r inside the value forces RFC4180 quoting too — strip the wrapping
      // quotes (and un-double any inner ones) before comparing the guarded text.
      const unquoted = firstCell.startsWith('"')
        ? firstCell.slice(1, -1).replace(/""/g, '"')
        : firstCell;
      expect(unquoted).toBe(expected);
    });

    it('leaves an ordinary value — including one with a comma or space, not just a bare word — untouched', () => {
      const csv = toCsv([{ name: 'Ayam Bakar Madu', qty: 1, note: null }], columns);
      expect(csv.slice(1).split('\r\n')[1]).toBe('Ayam Bakar Madu,1,');
    });

    it('does not touch a value where the trigger character appears mid-string, not first', () => {
      const csv = toCsv([{ name: 'Harga = Rp10.000', qty: 1, note: null }], columns);
      expect(csv.slice(1).split('\r\n')[1]).toBe('Harga = Rp10.000,1,');
    });
  });
});

describe('businessDateFilename', () => {
  it('formats the WITA (Asia/Makassar) calendar date, not the machine-local one', () => {
    // 2026-01-01T16:30:00Z is already 2026-01-02 00:30 in WITA (UTC+8) — a
    // naive machine-local formatter running in UTC would stamp the 1st.
    const name = businessDateFilename('stok-gudang', new Date('2026-01-01T16:30:00Z'));
    expect(name).toBe('stok-gudang-2026-01-02.csv');
  });
});

describe('downloadCsv', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
    // jsdom has no Blob URL support; stub it the same way ReceiveDropForm.test.tsx does.
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
    vi.useRealTimers();
  });

  it('creates an object URL, clicks a download anchor, and revokes the URL afterwards', () => {
    vi.useFakeTimers();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadCsv('stok-gudang-2026-08-24.csv', '\uFEFFNama,Qty\r\nAyam,1');

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');

    clickSpy.mockRestore();
  });
});
