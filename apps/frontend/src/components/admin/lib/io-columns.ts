/**
 * Export columns for the master-data lists, defined to match what the BULK
 * IMPORTER accepts — header for header, in order.
 *
 * WHY THAT MATTERS: the bulk edit people actually do is "export what exists,
 * fix it in a spreadsheet, import it back". That round trip only works if an
 * exported file is a valid import file. So every header below is a column name
 * from `apps/backend/src/modules/import/import-schema.ts`'s `IMPORT_ENTITIES`,
 * and every value is written in the shape that entity's parser expects — a
 * category by NAME (not id), a unit by CODE, booleans as the `ya`/`tidak` the
 * importer's `boolean` kind accepts, money as a plain decimal with no `Rp` and
 * no thousands separator.
 *
 * THE COUPLING IS REAL AND CROSSES A PACKAGE BOUNDARY, so it cannot be checked
 * by the compiler: the frontend cannot import backend code. `io-columns.test.ts`
 * pins the header lists here against the same literals, so a drift shows up as
 * a failing test naming the entity rather than as an import that rejects every
 * row with "kolom tidak dikenal". Changing an importer column means changing
 * both, and the test says so.
 *
 * Columns the importer does NOT accept are deliberately absent even where the
 * table shows them (an item's `avg_cost`, a product's photo, a package's
 * members): exporting a column that cannot be imported back turns the round
 * trip into a silent data-loss step the first time someone re-imports.
 */
import type { CsvColumn } from '@/lib/export/csv';
import { fmtDateTime } from '@/lib/dates';
import { roleLabel } from '../roleRank';
import { specFor } from './settings-registry';
import type { AuditRow, Item, ItemCategory, Product, Setting, UserRow } from '../types';

type T = (key: string, params?: Record<string, string | number>) => string;

/** How the importer's `boolean` kind wants a value written (`ya`/`tidak`, per its column hints). */
function bool(value: boolean): string {
  return value ? 'ya' : 'tidak';
}

/** `items` — `sku,name,category,base_unit,storage_type,is_sellable,shelf_life_days,barcode`. */
export const ITEM_IO_COLUMNS: CsvColumn<Item>[] = [
  { key: 'sku', header: 'sku' },
  { key: 'name', header: 'name' },
  // The NAME, because that is what the importer resolves against
  // `item_categories.name`. An id would fail every row.
  { key: 'categoryName', header: 'category', format: (r) => r.categoryName ?? '' },
  { key: 'baseUnit', header: 'base_unit', format: (r) => r.baseUnit.code },
  { key: 'storageType', header: 'storage_type' },
  { key: 'isSellable', header: 'is_sellable', format: (r) => bool(r.isSellable) },
  { key: 'shelfLifeDays', header: 'shelf_life_days', format: (r) => r.shelfLifeDays ?? '' },
  { key: 'barcode', header: 'barcode', format: (r) => r.barcode ?? '' },
];

/** `item_categories` — `name,sort_order`. */
export const ITEM_CATEGORY_IO_COLUMNS: CsvColumn<ItemCategory>[] = [
  { key: 'name', header: 'name' },
  { key: 'sortOrder', header: 'sort_order' },
];

/** `products` — `code,name,category,price,sort_order`. */
export const PRODUCT_IO_COLUMNS: CsvColumn<Product>[] = [
  { key: 'code', header: 'code' },
  { key: 'name', header: 'name' },
  // `Product.category` is already the joined `product_categories.name`, which
  // is exactly what the importer resolves — no lookup needed here.
  { key: 'category', header: 'category' },
  // Plain decimal string, NOT `formatMoney`: "Rp18.500" is not a number to any
  // parser, and the importer's `decimal` kind wants the raw value.
  { key: 'price', header: 'price' },
  { key: 'sortOrder', header: 'sort_order' },
];

/**
 * Everything below is EXPORT-ONLY, unlike the three round-trip const above —
 * same split `purchasing/lib/io-columns.ts` makes between `SUPPLIER_IO_COLUMNS`
 * and its append-only `PRICE_HISTORY_EXPORT_COLUMNS`. None of these three
 * (audit log, users, settings) is a `chart_of_accounts`-style importer
 * entity — see each function's comment for the specific reason a bulk import
 * would be actively wrong here, not merely unbuilt.
 */

/**
 * `Jejak Audit` (F10 audit log, CONTRACTS §4.0). EXPORT ONLY: the audit log
 * is append-only by construction — every row is written by the
 * `@Audited()` interceptor as a side effect of some OTHER write, never
 * authored directly — so a CSV importer for it would be a way to forge
 * history, which is the one thing this surface exists to make impossible.
 *
 * `beforeValue`/`afterValue` are exported as compact JSON so the export can
 * answer the same "what changed" question the detail modal does, without
 * reformatting either object — a money field inside one of them (say, a
 * journal-post audit row) survives as whatever decimal string it already was.
 */
export function auditIoColumns(): CsvColumn<AuditRow>[] {
  return [
    { key: 'occurredAt', header: 'Waktu', format: (r) => fmtDateTime(r.occurredAt) },
    { key: 'userName', header: 'Pengguna', format: (r) => r.userName ?? '' },
    { key: 'roleKey', header: 'Peran', format: (r) => roleLabel(r.roleKey) },
    { key: 'module', header: 'Modul' },
    { key: 'action', header: 'Aksi' },
    { key: 'entityType', header: 'Jenis Entitas' },
    { key: 'entityId', header: 'ID Entitas', format: (r) => r.entityId ?? '' },
    { key: 'reason', header: 'Alasan', format: (r) => r.reason ?? '' },
    {
      key: 'offlineAuthorized',
      header: 'Diotorisasi Offline',
      format: (r) => bool(r.offlineAuthorized),
    },
    {
      key: 'beforeValue',
      header: 'Sebelum',
      format: (r) => (r.beforeValue ? JSON.stringify(r.beforeValue) : ''),
    },
    {
      key: 'afterValue',
      header: 'Sesudah',
      format: (r) => (r.afterValue ? JSON.stringify(r.afterValue) : ''),
    },
  ];
}

/**
 * `Pengguna` (F10 users, CONTRACTS §4.2). EXPORT ONLY: `users` is not one of
 * the backend importer's nine entities (`ImportEntityName`) — creating a
 * login needs a password, a rank-checked role assignment, and a location
 * grant, none of which a bulk upsert-on-natural-key importer is built to
 * carry safely. Payroll's `employees` entity is a deliberately separate
 * concept (pay/HR data) and already has its own import; this is the login
 * record, and it stays hand-created one at a time.
 */
export function userIoColumns(): CsvColumn<UserRow>[] {
  return [
    { key: 'username', header: 'Username' },
    { key: 'name', header: 'Nama' },
    { key: 'roleKey', header: 'Peran', format: (r) => roleLabel(r.roleKey) },
    {
      key: 'locations',
      header: 'Lokasi',
      format: (r) => r.locations.map((l) => l.name).join(' | '),
    },
    { key: 'isActive', header: 'Status', format: (r) => (r.isActive ? 'aktif' : 'nonaktif') },
    {
      key: 'lastLoginAt',
      header: 'Login Terakhir',
      format: (r) => (r.lastLoginAt ? fmtDateTime(r.lastLoginAt) : ''),
    },
    { key: 'createdAt', header: 'Dibuat Pada', format: (r) => fmtDateTime(r.createdAt) },
  ];
}

/**
 * `Pengaturan` (F10 settings, CONTRACTS §4.20). EXPORT ONLY, and for a third,
 * different reason again: `settings` is a fixed, heterogeneous key/value
 * table (money, booleans, structured objects, two keys that reject a raw PUT
 * entirely — `payroll.statutory`, `approval.mode`), not a list of records a
 * natural-key upsert could make sense of. It is also not in
 * `ImportEntityName` at all.
 *
 * `rawSettingCell` is the reason this does NOT reuse `formatSettingValue`
 * (`./settings-format.ts`): that helper runs a money-kind value through
 * `formatMoney`, which prints `Rp200.000` — exactly the formatting CONTRACTS
 * §0 forbids in an exported cell. This writes the wire value as-is: a string
 * passes through untouched (so a money setting stays a verbatim decimal),
 * and only a genuinely structured value is JSON-stringified.
 */
function rawSettingCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

export function settingIoColumns(t: T): CsvColumn<Setting>[] {
  return [
    { key: 'key', header: 'Kunci' },
    {
      key: 'key',
      header: 'Nama',
      format: (r) => {
        const spec = specFor(r.key);
        return spec ? t(spec.labelKey) : r.key;
      },
    },
    { key: 'value', header: 'Nilai', format: (r) => rawSettingCell(r.value) },
    { key: 'updatedBy', header: 'Diperbarui Oleh', format: (r) => r.updatedBy ?? '' },
    { key: 'updatedAt', header: 'Diperbarui Pada', format: (r) => fmtDateTime(r.updatedAt) },
  ];
}
