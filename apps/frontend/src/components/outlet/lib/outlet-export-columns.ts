/**
 * Export columns for the seven Outlet tabs (Minta Barang, Terima Barang, Stok,
 * Stock Opname, Waste, Retur, Kas Kecil).
 *
 * THESE ARE REPORTS, NOT ROUND-TRIP IMPORT FILES — the opposite of
 * `components/admin/lib/io-columns.ts`, and deliberately so. Those columns
 * mirror the bulk importer header-for-header because master data is edited by
 * "export, fix in Excel, import back". Everything on this surface is a
 * transactional document instead: a waste record carries photo evidence, a
 * petty-cash claim carries payment proof and a goods photo, a receiving drop
 * carries a signature, and each has a status set by an approval chain. None of
 * that can travel through a CSV cell, so there is no importer to mirror and no
 * round trip to preserve. That frees these columns to include what an operator
 * actually wants in a report — document number, status, who reported it, the
 * variance — rather than only importable fields.
 *
 * Money and Qty stay VERBATIM decimal strings (CONTRACTS §0): no `Rp`, no
 * thousands separator, no float round-trip. A spreadsheet can then total a
 * column, which is most of why anyone exports this. Timestamps go through
 * `fmtDateTime`/`fmtDate` so they read in WITA (D-11) rather than as UTC ISO
 * text that would silently shift a late-evening record to the previous day.
 *
 * MULTI-LINE DOCUMENTS ARE FLATTENED, not exploded one row per line. A
 * replenishment request or petty-cash claim is one row with a line COUNT and a
 * total; per-line detail lives in the on-screen detail view. Exploding them
 * would make every document-level number (status, total) repeat and be
 * double-counted by a naive SUM — the single most common way a spreadsheet
 * export misleads.
 */
import type { CsvColumn } from '@/lib/export/csv';
import { fmtDate, fmtDateTime } from '@/lib/dates';
import type {
  Balance,
  Opname,
  PettyCash,
  Replenishment,
  ReturnDoc,
  SuratJalan,
  WasteRecord,
} from './types';

/** `Qty | Money | null` → the decimal string, or blank. Never `"null"`. */
function dec(value: string | null | undefined): string {
  return value ?? '';
}

/** `Stok` — balances per storage area, the grouping the screen itself keeps. */
export const BALANCE_EXPORT_COLUMNS: CsvColumn<Balance>[] = [
  { key: 'storageAreaName', header: 'area_simpan' },
  { key: 'storageAreaType', header: 'tipe_area' },
  { key: 'sku', header: 'sku' },
  { key: 'itemName', header: 'nama_barang' },
  { key: 'unitCode', header: 'satuan' },
  { key: 'qtyOnHand', header: 'stok' },
  { key: 'minQty', header: 'stok_minimum', format: (r) => dec(r.minQty) },
  // The reason to open this export at all is usually "what needs ordering", so
  // the flag the screen shows as a badge has to survive into the file.
  { key: 'belowMin', header: 'di_bawah_minimum', format: (r) => (r.belowMin ? 'ya' : 'tidak') },
  { key: 'value', header: 'nilai', format: (r) => dec(r.value) },
];

/** `Stock Opname` — count sessions. Variance is the column people come for. */
export const OPNAME_EXPORT_COLUMNS: CsvColumn<Opname>[] = [
  { key: 'opnameNumber', header: 'no_opname' },
  { key: 'locationName', header: 'outlet' },
  { key: 'status', header: 'status' },
  { key: 'countedBy', header: 'dihitung_oleh' },
  { key: 'startedAt', header: 'mulai', format: (r) => fmtDateTime(r.startedAt) },
  { key: 'submittedAt', header: 'diajukan', format: (r) => fmtDateTime(r.submittedAt) },
  { key: 'approvedBy', header: 'disetujui_oleh', format: (r) => r.approvedBy ?? '' },
  { key: 'approvedAt', header: 'disetujui', format: (r) => fmtDateTime(r.approvedAt) },
  { key: 'lineCount', header: 'jumlah_baris' },
  { key: 'disputedCount', header: 'jumlah_disanggah' },
  { key: 'totalVarianceValue', header: 'nilai_selisih', format: (r) => dec(r.totalVarianceValue) },
];

/** `Minta Barang` — replenishment requests, flattened to one row per request. */
export const REPLENISHMENT_EXPORT_COLUMNS: CsvColumn<Replenishment>[] = [
  { key: 'requestNumber', header: 'no_permintaan' },
  { key: 'locationName', header: 'outlet' },
  { key: 'status', header: 'status' },
  { key: 'source', header: 'sumber' },
  { key: 'requestedBy', header: 'diminta_oleh' },
  { key: 'submittedAt', header: 'diajukan', format: (r) => fmtDateTime(r.submittedAt) },
  { key: 'neededBy', header: 'dibutuhkan_tanggal', format: (r) => fmtDate(r.neededBy) },
  { key: 'sjNumber', header: 'no_surat_jalan', format: (r) => r.sjNumber ?? '' },
  { key: 'lines', header: 'jumlah_baris', format: (r) => r.lines.length },
  // Requested vs approved is the whole story of a request that was trimmed, and
  // it is invisible from the header row alone.
  {
    key: 'lines',
    header: 'total_diminta',
    format: (r) => sumDecimals(r.lines.map((l) => l.qtyRequested)),
  },
  {
    key: 'lines',
    header: 'total_disetujui',
    format: (r) => sumDecimals(r.lines.map((l) => l.qtyApproved)),
  },
  {
    key: 'lines',
    header: 'total_diterima',
    format: (r) => sumDecimals(r.lines.map((l) => l.qtyReceived)),
  },
];

/** `Terima Barang` — incoming surat jalan, one row per DROP for this outlet. */
export const RECEIVING_EXPORT_COLUMNS: CsvColumn<SuratJalan>[] = [
  { key: 'sjNumber', header: 'no_surat_jalan' },
  { key: 'shipmentType', header: 'jenis_kiriman' },
  { key: 'status', header: 'status' },
  { key: 'plannedDate', header: 'tanggal_rencana', format: (r) => fmtDate(r.plannedDate) },
  { key: 'driver', header: 'driver', format: (r) => r.driver.name },
  { key: 'vehicle', header: 'kendaraan', format: (r) => r.vehicle.plateNumber },
  {
    key: 'vehicle',
    header: 'berpendingin',
    format: (r) => (r.vehicle.hasFreezer ? 'ya' : 'tidak'),
  },
  { key: 'dispatchedAt', header: 'dikirim', format: (r) => fmtDateTime(r.dispatchedAt) },
  { key: 'completedAt', header: 'selesai', format: (r) => fmtDateTime(r.completedAt) },
  { key: 'drops', header: 'jumlah_drop', format: (r) => r.drops.length },
  {
    key: 'drops',
    header: 'jumlah_baris',
    format: (r) => r.drops.reduce((n, d) => n + d.lines.length, 0),
  },
  // A discrepancy is the one thing on this tab that needs following up, so it
  // must be visible without opening each drop.
  {
    key: 'drops',
    header: 'catatan_selisih',
    format: (r) =>
      r.drops
        .map((d) => d.discrepancyNotes)
        .filter((n): n is string => Boolean(n))
        .join(' | '),
  },
];

/** `Waste` — already one row per wasted batch on the wire, so no flattening. */
export const WASTE_EXPORT_COLUMNS: CsvColumn<WasteRecord>[] = [
  { key: 'wasteNumber', header: 'no_waste' },
  { key: 'occurredAt', header: 'waktu', format: (r) => fmtDateTime(r.occurredAt) },
  { key: 'locationName', header: 'outlet' },
  { key: 'storageAreaName', header: 'area_simpan' },
  { key: 'itemName', header: 'nama_barang' },
  { key: 'qty', header: 'qty' },
  { key: 'unitCost', header: 'harga_satuan' },
  // Not computed here: qty × unitCost in JS floats is exactly the rounding the
  // decimal-string rule exists to prevent (CONTRACTS §0). The spreadsheet can
  // multiply two clean decimal columns itself.
  { key: 'reason', header: 'alasan' },
  { key: 'status', header: 'status' },
  { key: 'reportedBy', header: 'dilaporkan_oleh' },
  { key: 'photoUrls', header: 'jumlah_foto', format: (r) => r.photoUrls.length },
];

/** `Retur` — return documents, flattened to one row per document. */
export const RETURN_EXPORT_COLUMNS: CsvColumn<ReturnDoc>[] = [
  { key: 'returnNumber', header: 'no_retur' },
  { key: 'direction', header: 'arah' },
  { key: 'fromLocationName', header: 'dari' },
  { key: 'toLocationName', header: 'ke', format: (r) => r.toLocationName ?? '' },
  { key: 'status', header: 'status' },
  { key: 'requestedBy', header: 'diminta_oleh' },
  { key: 'approvedBy', header: 'disetujui_oleh', format: (r) => r.approvedBy ?? '' },
  { key: 'shippedAt', header: 'dikirim', format: (r) => fmtDateTime(r.shippedAt) },
  { key: 'receivedAt', header: 'diterima', format: (r) => fmtDateTime(r.receivedAt) },
  { key: 'lines', header: 'jumlah_baris', format: (r) => r.lines.length },
  { key: 'lines', header: 'total_qty', format: (r) => sumDecimals(r.lines.map((l) => l.qty)) },
  {
    key: 'lines',
    header: 'total_qty_diterima',
    format: (r) => sumDecimals(r.lines.map((l) => l.qtyReceived)),
  },
  {
    key: 'lines',
    header: 'kondisi',
    format: (r) => [...new Set(r.lines.map((l) => l.condition))].join(' | '),
  },
];

/** `Kas Kecil` — petty-cash claims, flattened to one row per claim. */
export const PETTY_CASH_EXPORT_COLUMNS: CsvColumn<PettyCash>[] = [
  { key: 'pcNumber', header: 'no_kas_kecil' },
  { key: 'purchaseDate', header: 'tanggal_belanja', format: (r) => fmtDate(r.purchaseDate) },
  { key: 'storeName', header: 'toko' },
  { key: 'purchasedBy', header: 'dibeli_oleh' },
  // `totalAmount` comes off the wire already totalled by the server — the
  // authoritative figure, and not re-derived from lines here so the export can
  // never disagree with the screen.
  { key: 'totalAmount', header: 'total' },
  { key: 'status', header: 'status' },
  { key: 'verifiedBy', header: 'diverifikasi_oleh', format: (r) => r.verifiedBy ?? '' },
  { key: 'lines', header: 'jumlah_baris', format: (r) => r.lines.length },
  {
    key: 'lines',
    header: 'kategori_biaya',
    format: (r) => [...new Set(r.lines.map((l) => l.expenseCategory))].join(' | '),
  },
  { key: 'photoUrls', header: 'jumlah_foto', format: (r) => r.photoUrls.length },
];

/**
 * Sum decimal STRINGS without ever converting to a float.
 *
 * Qty and Money are strings end-to-end (CONTRACTS §0) precisely because
 * `0.1 + 0.2` is not `0.3` in IEEE-754, and an export whose totals are a cent
 * off from the screen is worse than an export with no totals at all. So this
 * adds in integer arithmetic on a common scale (the widest decimal place seen)
 * and returns a string, padded back to that scale. Nulls — an unapproved or
 * unreceived line — are skipped, not read as zero: a request with no approval
 * yet must not export as "0 approved", which reads as "approved for nothing".
 */
export function sumDecimals(values: (string | null | undefined)[]): string {
  const present = values.filter((v): v is string => v !== null && v !== undefined && v !== '');
  if (present.length === 0) return '';

  const scale = present.reduce((max, v) => Math.max(max, (v.split('.')[1] ?? '').length), 0);
  let total = 0n;
  for (const v of present) {
    const negative = v.startsWith('-');
    const [whole = '0', frac = ''] = v.replace(/^[-+]/, '').split('.');
    // Pad the fraction out to the common scale, then treat the whole thing as
    // one integer — exact for any input the wire can carry.
    const scaled = BigInt(whole + frac.padEnd(scale, '0'));
    total += negative ? -scaled : scaled;
  }

  if (scale === 0) return total.toString();
  const negative = total < 0n;
  const digits = (negative ? -total : total).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale);
  return `${negative ? '-' : ''}${whole}.${frac}`;
}
