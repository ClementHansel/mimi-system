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
import type { Item, ItemCategory, Product } from '../types';

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
