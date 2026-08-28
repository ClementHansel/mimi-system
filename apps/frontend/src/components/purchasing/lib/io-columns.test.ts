/**
 * Pins the supplier export headers against the BACKEND importer's column list.
 *
 * The coupling is real and crosses a package boundary, so the compiler cannot
 * see it: the frontend cannot import `apps/backend/src/modules/import/
 * import-schema.ts`. If a column is renamed there and not here, an exported
 * file stops being a valid import file and every row comes back "kolom tidak
 * dikenal" — a failure that shows up in an operator's face rather than in CI.
 * So the literals below are transcribed from that file, and this test is what
 * names the drift.
 */
import { describe, it, expect } from 'vitest';
import {
  SUPPLIER_IO_COLUMNS,
  PRICE_HISTORY_EXPORT_COLUMNS,
  SUPPLIER_ITEM_EXPORT_COLUMNS,
} from './io-columns';
import { toCsv } from '@/lib/export/csv';
import type { Supplier, PriceHistoryEntry } from './types';

describe('SUPPLIER_IO_COLUMNS', () => {
  it("matches the importer's `suppliers` columns, in order", () => {
    expect(SUPPLIER_IO_COLUMNS.map((c) => c.header)).toEqual([
      'code',
      'name',
      'contact_name',
      'phone',
      'email',
      'address',
      'payment_terms_days',
      'bank_name',
      'bank_account',
      'bank_account_name',
      'outlet_visible',
    ]);
  });

  it('omits columns the importer cannot accept', () => {
    // `is_active` is server-owned — deactivation is a DELETE, never a field on
    // an update. Exporting it would make the round trip lossy the first time
    // someone re-imported.
    const headers = SUPPLIER_IO_COLUMNS.map((c) => c.header);
    expect(headers).not.toContain('is_active');
    expect(headers).not.toContain('id');
  });

  const SUPPLIER: Supplier = {
    id: 's1',
    code: 'SUP-001',
    name: 'PT Ayam Jaya',
    contactName: 'Budi',
    phone: '+62-812-3456789',
    email: 'sales@ayamjaya.co.id',
    address: 'Jl. Soekarno No. 1',
    paymentTermsDays: 30,
    bankName: 'BCA',
    bankAccount: '1234567890',
    bankAccountName: 'PT Ayam Jaya',
    outletVisible: false,
    isActive: true,
  };

  it('writes booleans as the ya/tidak the importer parses', () => {
    const csv = toCsv([SUPPLIER, { ...SUPPLIER, outletVisible: true }], SUPPLIER_IO_COLUMNS);
    const [, hidden, visible] = csv.split('\r\n');
    expect(hidden?.endsWith('tidak')).toBe(true);
    expect(visible?.endsWith('ya')).toBe(true);
  });

  it('writes blanks, never the literal "null", for absent optionals', () => {
    const bare: Supplier = {
      ...SUPPLIER,
      contactName: null,
      phone: null,
      email: null,
      address: null,
      bankName: null,
      bankAccount: null,
      bankAccountName: null,
    };
    const csv = toCsv([bare], SUPPLIER_IO_COLUMNS);
    expect(csv).not.toContain('null');
    expect(csv).not.toContain('undefined');
  });

  it('round-trips: the exported header row IS an importable header row', () => {
    // The whole point of mirroring the importer. If this ever fails, the export
    // has stopped being re-importable.
    const csv = toCsv([SUPPLIER], SUPPLIER_IO_COLUMNS);
    // `\uFEFF` as an escape, not a literal BOM: the raw character is invisible
    // in every editor and diff, and eslint's no-irregular-whitespace rejects
    // it outright - which had CI's lint step failing.
    const header = csv.replace(/^\uFEFF/, '').split('\r\n')[0];
    expect(header).toBe(
      'code,name,contact_name,phone,email,address,payment_terms_days,bank_name,bank_account,bank_account_name,outlet_visible',
    );
  });
});

describe('PRICE_HISTORY_EXPORT_COLUMNS', () => {
  it('keeps money as a verbatim decimal string', () => {
    const entry: PriceHistoryEntry = {
      itemId: 'i1',
      itemName: 'Ayam Utuh',
      price: '38500.00',
      effectiveDate: '2026-08-01',
      source: 'po',
      recordedBy: 'Budi',
    };
    const csv = toCsv([entry], PRICE_HISTORY_EXPORT_COLUMNS);
    expect(csv).toContain('38500.00');
    expect(csv).not.toContain('Rp');
  });

  it('keeps `source`, which distinguishes a quote from a price actually paid', () => {
    expect(PRICE_HISTORY_EXPORT_COLUMNS.map((c) => c.header)).toContain('sumber');
  });

  it('is export-only — no importer column names leak into it', () => {
    // Price history is append-only (FR-SUP-04): rows are a side effect of a
    // price change or a PO, never authored. These headers are Indonesian
    // report labels precisely so nobody mistakes the file for an import sheet.
    for (const columns of [PRICE_HISTORY_EXPORT_COLUMNS, SUPPLIER_ITEM_EXPORT_COLUMNS]) {
      const headers = columns.map((c) => c.header);
      expect(headers).not.toContain('code');
      expect(headers).not.toContain('price');
      expect(new Set(headers).size).toBe(headers.length);
    }
  });
});
