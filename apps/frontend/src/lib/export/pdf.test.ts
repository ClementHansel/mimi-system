import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { toPdf, downloadPdf, businessDatePdfFilename, type PdfDocOptions } from './pdf';
import type { CsvColumn } from './csv';

interface Row {
  name: string;
  qty: number;
  amount: string;
}

const columns: CsvColumn<Row>[] = [
  { key: 'name', header: 'Nama' },
  { key: 'qty', header: 'Qty' },
  { key: 'amount', header: 'Jumlah' },
];

function baseOptions(overrides: Partial<PdfDocOptions> = {}): PdfDocOptions {
  return {
    title: 'Stok Gudang',
    generatedLabel: 'Dibuat: 25 Agu 2026, 10.00 WITA',
    pageLabel: (page, total) => `Halaman ${page} dari ${total}`,
    emptyLabel: 'Tidak ada data',
    ...overrides,
  };
}

/**
 * A minimal, dependency-free structural parse: walk `startxref` -> `xref`
 * table -> confirm every listed offset actually lands on `"<id> 0 obj"`.
 * This is the same bar `xlsx-writer.util.spec.ts`-style tests hold a
 * hand-rolled binary format to — proof the BYTES are internally consistent,
 * not just that the generator function returned without throwing.
 */
function assertStructurallyValidPdf(bytes: Uint8Array<ArrayBuffer>): {
  objectCount: number;
  text: string;
} {
  // Every byte here was constructed to be <= 0xFF by `pdf.ts` itself, so
  // decoding one-byte-per-char (rather than UTF-8) reverses `serializePdf`
  // exactly — this is latin1, not `TextDecoder('utf-8')`, on purpose.
  const text = Array.from(bytes, (b) => String.fromCharCode(b)).join('');

  expect(text.startsWith('%PDF-1.4\n')).toBe(true);
  expect(text.endsWith('%%EOF')).toBe(true);

  const startxrefMatch = /startxref\n(\d+)\n%%EOF$/.exec(text);
  expect(startxrefMatch).not.toBeNull();
  const xrefOffset = Number(startxrefMatch![1]);
  expect(text.slice(xrefOffset, xrefOffset + 4)).toBe('xref');

  const countMatch = /^xref\n0 (\d+)\n/.exec(text.slice(xrefOffset));
  expect(countMatch).not.toBeNull();
  const total = Number(countMatch![1]);

  const tableStart = xrefOffset + countMatch![0].length;
  for (let id = 1; id < total; id += 1) {
    const entry = text.slice(tableStart + id * 20, tableStart + id * 20 + 20);
    expect(entry).toHaveLength(20);
    expect(entry.endsWith('\r\n')).toBe(true);
    if (entry.endsWith('f\r\n')) continue; // a free/unused id — not expected here, but not a corruption either
    const offset = Number(entry.slice(0, 10));
    expect(text.slice(offset, offset + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
  }

  const rootMatch = /\/Root (\d+) 0 R/.exec(text);
  expect(rootMatch).not.toBeNull();
  expect(text).toContain(`${rootMatch![1]} 0 obj\n<< /Type /Catalog`);

  return { objectCount: total - 1, text };
}

describe('toPdf', () => {
  it('produces a structurally valid, parseable single-page PDF', () => {
    const bytes = toPdf(
      [{ name: 'Ayam Geprek', qty: 3, amount: 'Rp 45.000' }],
      columns,
      baseOptions(),
    );
    const { text } = assertStructurallyValidPdf(bytes);

    expect(text).toContain('/Count 1'); // one page
    expect(text).toContain('(Stok Gudang)'); // title
    expect(text).toContain('(Dibuat: 25 Agu 2026, 10.00 WITA)'); // WITA generated-at line
    expect(text).toContain('Halaman 1 dari 1'); // page number, present even for a single page
    expect(text).toContain('Ayam Geprek'); // the actual row data made it into a content stream
  });

  it('paginates and numbers pages once the row count exceeds one page', () => {
    const manyRows: Row[] = Array.from({ length: 120 }, (_, i) => ({
      name: `Item ${i}`,
      qty: i,
      amount: `Rp ${i}.000`,
    }));
    const bytes = toPdf(manyRows, columns, baseOptions());
    const { text } = assertStructurallyValidPdf(bytes);

    const countMatch = /\/Count (\d+)/.exec(text);
    const totalPages = Number(countMatch![1]);
    expect(totalPages).toBeGreaterThan(1);

    expect(text).toContain(`Halaman 1 dari ${totalPages}`);
    expect(text).toContain(`Halaman ${totalPages} dari ${totalPages}`);
    // Every row landed somewhere across the pages, none silently dropped.
    expect(text).toContain('Item 0');
    expect(text).toContain('Item 119');
  });

  it('renders the empty-state label instead of a table when there are zero rows', () => {
    const bytes = toPdf([], columns, baseOptions());
    const { text } = assertStructurallyValidPdf(bytes);
    expect(text).toContain('/Count 1');
    expect(text).toContain('(Tidak ada data)');
  });

  it('escapes parentheses and backslashes so a name never breaks the content stream', () => {
    const bytes = toPdf(
      [{ name: 'Ayam (Spesial) \\ Pedas', qty: 1, amount: 'Rp 1.000' }],
      columns,
      baseOptions(),
    );
    const { text } = assertStructurallyValidPdf(bytes);
    expect(text).toContain('Ayam \\(Spesial\\) \\\\ Pedas');
  });

  it('replaces characters outside WinAnsi/Latin-1 with "?" rather than corrupting the byte stream', () => {
    const bytes = toPdf([{ name: 'Ayam 🐔', qty: 1, amount: 'Rp 1.000' }], columns, baseOptions());
    const { text } = assertStructurallyValidPdf(bytes);
    expect(text).toContain('Ayam ?');
  });

  it('right-aligns money-shaped cells and left-aligns text — column boundaries stay fixed down every row', () => {
    const bytes = toPdf(
      [
        { name: 'A', qty: 1, amount: 'Rp 1.000' },
        { name: 'Kerupuk Palembang', qty: 100, amount: 'Rp 250.000' },
      ],
      columns,
      baseOptions(),
    );
    const { text } = assertStructurallyValidPdf(bytes);
    // A right-aligned numeric cell for the shorter value is left-PADDED with
    // spaces inside the literal string, so the amount's trailing digits and
    // the column width line up regardless of row length.
    expect(text).toContain('   Rp 1.000'); // padded to match "Rp 250.000"'s width
  });
});

describe('businessDatePdfFilename', () => {
  it('formats the WITA (Asia/Makassar) calendar date, not the machine-local one', () => {
    const name = businessDatePdfFilename('stok-gudang', new Date('2026-01-01T16:30:00Z'));
    expect(name).toBe('stok-gudang-2026-01-02.pdf');
  });
});

describe('downloadPdf', () => {
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;

  beforeEach(() => {
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

    downloadPdf('stok-gudang-2026-08-25.pdf', toPdf([], columns, baseOptions()));

    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    vi.runAllTimers();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock');

    clickSpy.mockRestore();
  });
});
