/**
 * Export columns for the supplier surface.
 *
 * `SUPPLIER_IO_COLUMNS` mirrors the bulk importer's `suppliers` entity
 * header-for-header (`apps/backend/src/modules/import/import-schema.ts`), for
 * the same reason `components/admin/lib/io-columns.ts` does: the realistic bulk
 * edit is "export what exists, fix it in a spreadsheet, import it back", and
 * that round trip only works if an exported file is a valid import file. The
 * importer upserts on `code`, so a round trip updates rather than duplicating.
 *
 * The coupling crosses a package boundary and cannot be typechecked — the
 * frontend cannot import backend code — so `io-columns.test.ts` pins the header
 * list against the same literals. Changing an importer column means changing
 * both, and the test names which entity drifted.
 *
 * Columns the importer does NOT accept are deliberately absent even though the
 * table shows them (`is_active` — deactivation is a `DELETE`, never a field on
 * an update): exporting a column that cannot be imported back turns the round
 * trip into a silent data-loss step.
 *
 * PRICE HISTORY IS EXPORT-ONLY and has no import counterpart at all. It is
 * append-only by design (FR-SUP-04): rows are written as a side effect of a
 * price change or a PO, never authored directly. Its columns are therefore
 * chosen to be READ — item name, price, when, and where the figure came from —
 * not to round-trip.
 */
import type { CsvColumn } from '@/lib/export/csv';
import { fmtDate } from '@/lib/dates';
import type { PriceHistoryEntry, Supplier, SupplierItem } from './types';

/** How the importer's `boolean` kind wants a value written (`ya`/`tidak`). */
function bool(value: boolean): string {
  return value ? 'ya' : 'tidak';
}

/**
 * `suppliers` — `code,name,contact_name,phone,email,address,
 * payment_terms_days,bank_name,bank_account,bank_account_name,outlet_visible`.
 */
export const SUPPLIER_IO_COLUMNS: CsvColumn<Supplier>[] = [
  { key: 'code', header: 'code' },
  { key: 'name', header: 'name' },
  { key: 'contactName', header: 'contact_name', format: (r) => r.contactName ?? '' },
  { key: 'phone', header: 'phone', format: (r) => r.phone ?? '' },
  { key: 'email', header: 'email', format: (r) => r.email ?? '' },
  { key: 'address', header: 'address', format: (r) => r.address ?? '' },
  { key: 'paymentTermsDays', header: 'payment_terms_days' },
  { key: 'bankName', header: 'bank_name', format: (r) => r.bankName ?? '' },
  { key: 'bankAccount', header: 'bank_account', format: (r) => r.bankAccount ?? '' },
  { key: 'bankAccountName', header: 'bank_account_name', format: (r) => r.bankAccountName ?? '' },
  { key: 'outletVisible', header: 'outlet_visible', format: (r) => bool(r.outletVisible) },
];

/**
 * `Riwayat Harga Supplier` — export only, and a REPORT rather than a round
 * trip (see this file's header). Money stays a verbatim decimal string
 * (CONTRACTS §0) so a spreadsheet can chart it.
 */
export const PRICE_HISTORY_EXPORT_COLUMNS: CsvColumn<PriceHistoryEntry>[] = [
  { key: 'itemName', header: 'nama_barang' },
  { key: 'price', header: 'harga' },
  { key: 'effectiveDate', header: 'tanggal_berlaku', format: (r) => fmtDate(r.effectiveDate) },
  // `manual` (someone typed it) vs `po` (it came off a purchase order) is the
  // difference between a quote and a price actually paid.
  { key: 'source', header: 'sumber' },
  { key: 'recordedBy', header: 'dicatat_oleh', format: (r) => r.recordedBy ?? '' },
];

/**
 * A supplier's current item list. Export only: setting a price writes an
 * append-only history row (FR-SUP-04) and goes through
 * `PUT /suppliers/:id/items/:itemId` one item at a time, so there is no bulk
 * write for this to round-trip into.
 */
export const SUPPLIER_ITEM_EXPORT_COLUMNS: CsvColumn<SupplierItem>[] = [
  { key: 'itemName', header: 'nama_barang' },
  { key: 'supplierSku', header: 'sku_supplier', format: (r) => r.supplierSku ?? '' },
  { key: 'currentPrice', header: 'harga_sekarang' },
  { key: 'leadTimeDays', header: 'lead_time_hari' },
  { key: 'isPreferred', header: 'utama', format: (r) => bool(r.isPreferred) },
];
