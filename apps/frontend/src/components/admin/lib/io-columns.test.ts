/**
 * Pins the export columns to the BULK IMPORTER's columns.
 *
 * WHY THIS TEST EXISTS: "export it, fix it in a spreadsheet, import it back" is
 * the bulk edit people actually perform, and it only works while an exported
 * file is a valid import file. The two definitions live on opposite sides of a
 * package boundary — `apps/backend/src/modules/import/import-schema.ts` and
 * `io-columns.ts` — so the compiler cannot connect them. Without this, an
 * importer column renamed on the backend shows up as an import that rejects
 * every row with "kolom tidak dikenal", days later, in someone's hands.
 *
 * The expected lists below are transcribed from `IMPORT_ENTITIES`. Changing an
 * importer column means changing them here too — which is the point: the
 * failure names the entity and the exact header that drifted.
 */
import { describe, expect, it } from 'vitest';
import type { CsvColumn } from '@/lib/export/csv';
import { toCsv } from '@/lib/export/csv';
import { translate } from '@/lib/i18n';
import {
  ITEM_CATEGORY_IO_COLUMNS,
  ITEM_IO_COLUMNS,
  PRODUCT_IO_COLUMNS,
  auditIoColumns,
  userIoColumns,
  settingIoColumns,
} from './io-columns';
import type { AuditRow, Item, ItemCategory, Product, Setting, UserRow } from '../types';

const t = translate;

/** Verbatim from `IMPORT_ENTITIES` in `apps/backend/src/modules/import/import-schema.ts`. */
const IMPORTER_COLUMNS = {
  item_categories: ['name', 'sort_order'],
  items: [
    'sku',
    'name',
    'category',
    'base_unit',
    'storage_type',
    'is_sellable',
    'shelf_life_days',
    'barcode',
  ],
  products: ['code', 'name', 'category', 'price', 'sort_order'],
} as const;

function headers<T>(columns: CsvColumn<T>[]): string[] {
  return columns.map((c) => c.header);
}

describe('master-data export columns match the importer', () => {
  it('items', () => {
    expect(headers(ITEM_IO_COLUMNS)).toEqual([...IMPORTER_COLUMNS.items]);
  });

  it('item_categories', () => {
    expect(headers(ITEM_CATEGORY_IO_COLUMNS)).toEqual([...IMPORTER_COLUMNS.item_categories]);
  });

  it('products', () => {
    expect(headers(PRODUCT_IO_COLUMNS)).toEqual([...IMPORTER_COLUMNS.products]);
  });
});

describe('exported VALUES are in the shape the importer parses', () => {
  it('an item exports its category by NAME and unit by CODE, not by id', () => {
    const item = {
      id: 'i1',
      sku: 'BHN001',
      name: 'Dada Ayam',
      categoryId: 'cat-uuid',
      categoryName: 'Ayam Mentah',
      baseUnit: { id: 'unit-uuid', code: 'kg' },
      storageType: 'frozen',
      isSellable: false,
      shelfLifeDays: 7,
      barcode: null,
      isActive: true,
    } as Item;

    const csv = toCsv([item], ITEM_IO_COLUMNS);
    const [, row] = csv.trim().split('\n');

    // An id in either cell would fail every row: the importer resolves
    // `category` against `item_categories.name` and `base_unit` against
    // `units.code`.
    expect(row).toContain('Ayam Mentah');
    expect(row).toContain('kg');
    expect(row).not.toContain('cat-uuid');
    expect(row).not.toContain('unit-uuid');
    // `boolean` kind accepts ya/tidak; `true`/`false` is not in its vocabulary.
    expect(row).toContain('tidak');
    // An absent optional stays EMPTY, so a re-import leaves it alone instead of
    // writing the literal string "null".
    expect(row).not.toContain('null');
  });

  it('a product exports a raw decimal price — no Rp, no thousands separator', () => {
    const product = {
      id: 'p1',
      code: 'PRD001',
      name: 'Ayam Geprek',
      category: 'Ayam',
      categoryId: 'pc-uuid',
      price: '18500.00',
      photoUrl: null,
      photoPath: null,
      sortOrder: 10,
      isActive: true,
      kind: 'product',
      hasRecipe: true,
    } as Product;

    const csv = toCsv([product], PRODUCT_IO_COLUMNS);
    const [, row] = csv.trim().split('\n');

    expect(row).toContain('18500.00');
    expect(row).not.toContain('Rp');
    expect(row).not.toContain('18.500');
    // The joined category NAME, never the FK.
    expect(row).toContain('Ayam');
    expect(row).not.toContain('pc-uuid');
  });

  it('a category exports name and sort order only', () => {
    const category = {
      id: 'c1',
      name: 'Bumbu',
      parentId: null,
      sortOrder: 20,
    } as ItemCategory;

    const csv = toCsv([category], ITEM_CATEGORY_IO_COLUMNS);
    expect(csv.trim().split('\n')[1]).toBe('Bumbu,20');
  });
});

/**
 * `auditIoColumns`/`userIoColumns`/`settingIoColumns` are EXPORT ONLY — none
 * of them mirrors an importer entity, so these tests pin behavior (blanks
 * stay blank, money stays verbatim) rather than a cross-package header
 * contract like the describe blocks above.
 */
describe('auditIoColumns', () => {
  const row: AuditRow = {
    id: 'a1',
    userId: 'u1',
    userName: 'Budi',
    roleKey: 'finance_staff',
    module: 'accounting',
    action: 'accounting.journal.post',
    entityType: 'journal_entries',
    entityId: null,
    beforeValue: null,
    afterValue: { amount: '125000.00' },
    reason: null,
    offlineAuthorized: true,
    occurredAt: '2026-08-01T10:00:00Z',
  };

  it('writes blanks, never "null", for a login-style row with no entity/reason', () => {
    const csv = toCsv([row], auditIoColumns());
    expect(csv).not.toContain('null');
  });

  it('serializes afterValue as JSON without reformatting a money field inside it', () => {
    const csv = toCsv([row], auditIoColumns());
    // Verbatim decimal string, not `Rp125.000` — this column passes the raw
    // object straight through `JSON.stringify`, it does not re-render it.
    expect(csv).toContain('125000.00');
    expect(csv).not.toContain('Rp');
  });

  it('writes ya/tidak for the offline-authorized flag', () => {
    const csv = toCsv([row], auditIoColumns());
    const dataRow = csv.trim().split('\n')[1];
    expect(dataRow).toContain('ya');
  });
});

describe('userIoColumns', () => {
  it('joins multiple locations and writes a blank (not "Belum pernah") for no last login', () => {
    const user: UserRow = {
      id: 'u1',
      username: 'budi',
      name: 'Budi Santoso',
      email: null,
      phone: null,
      roleKey: 'outlet_staff',
      roleName: 'Staf Outlet',
      locations: [
        { id: 'l1', name: 'Outlet A' },
        { id: 'l2', name: 'Outlet B' },
      ],
      isActive: true,
      lastLoginAt: null,
      createdAt: '2026-01-01T00:00:00Z',
    };
    const csv = toCsv([user], userIoColumns());
    const row = csv.trim().split('\n')[1];
    expect(row).toContain('Outlet A | Outlet B');
    expect(row).toContain('aktif');
    expect(csv).not.toContain('null');
  });
});

describe('settingIoColumns', () => {
  it('passes a string (money) value through verbatim — no Rp, no thousands separator', () => {
    const setting: Setting = {
      key: 'finance.void_threshold',
      value: '200000.00',
      description: 'x',
      updatedBy: null,
      updatedAt: '2026-08-01T00:00:00Z',
    };
    const csv = toCsv([setting], settingIoColumns(t));
    expect(csv).toContain('200000.00');
    expect(csv).not.toContain('Rp');
  });

  it('JSON-stringifies a structured (object) value rather than dropping it', () => {
    const setting: Setting = {
      key: 'hr.overtime',
      value: { ratePerHour: '15000.00', minMinutes: 30 },
      description: 'x',
      updatedBy: 'Budi',
      updatedAt: '2026-08-01T00:00:00Z',
    };
    const csv = toCsv([setting], settingIoColumns(t));
    expect(csv).toContain('15000.00');
    expect(csv).not.toContain('Rp');
  });
});
