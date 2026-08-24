import { describe, it, expect } from 'vitest';
import {
  buildTemplate,
  entityDef,
  parseCsv,
  stripGuidanceRows,
  validate,
  IMPORT_ENTITIES,
} from './import-schema';

/**
 * Pure unit tests for the BFF importer's schema layer — no database. Mirrors
 * `database/import-schema.test.ts`'s intent (the whole job is refusing bad
 * data before it reaches a connection), adapted for this file's two
 * divergences: Indonesian messages and the explicit `headerOk` flag.
 */
describe('IMPORT_ENTITIES', () => {
  it('covers exactly item_categories, items, products — in that dependency order', () => {
    expect(IMPORT_ENTITIES.map((e) => e.name)).toEqual(['item_categories', 'items', 'products']);
  });

  it('every column carries a non-empty Indonesian hint (the template guidance row depends on this)', () => {
    for (const entity of IMPORT_ENTITIES) {
      for (const column of entity.columns) {
        expect(column.hint.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('buildTemplate', () => {
  it('derives the header row from the schema, not a hardcoded string', () => {
    const csv = buildTemplate(entityDef('items'));
    const [headerLine] = csv.split('\r\n');
    expect(headerLine).toBe(
      'sku,name,category,base_unit,storage_type,is_sellable,shelf_life_days,barcode',
    );
  });

  it('the guidance row starts every cell with "#" and lists enum values for storage_type', () => {
    const csv = buildTemplate(entityDef('items'));
    const lines = csv.split('\r\n');
    const guidanceCells = parseCsv(lines[0] + '\n' + lines[1]).rows[0]!.values;
    for (const cell of guidanceCells) expect(cell.startsWith('#')).toBe(true);
    const storageTypeCell = guidanceCells[4]!;
    expect(storageTypeCell).toMatch(/frozen/);
    expect(storageTypeCell).toMatch(/chilled/);
    expect(storageTypeCell).toMatch(/dry/);
  });

  it('round-trips through parseCsv + stripGuidanceRows to zero data rows (an untouched download imports nothing)', () => {
    const csv = buildTemplate(entityDef('item_categories'));
    const stripped = stripGuidanceRows(parseCsv(csv));
    expect(stripped.rows).toHaveLength(0);
  });
});

describe('stripGuidanceRows', () => {
  it('drops only rows whose first cell starts with "#", keeping real data intact', () => {
    const csv = parseCsv('name,sort_order\n#wajib,#opsional\nAyam,10\n');
    const stripped = stripGuidanceRows(csv);
    expect(stripped.rows).toHaveLength(1);
    expect(stripped.rows[0]!.values).toEqual(['Ayam', '10']);
  });
});

describe('validate — headerOk', () => {
  it('is true and rows are populated for a clean file', () => {
    const result = validate(entityDef('item_categories'), parseCsv('name,sort_order\nAyam,10\n'));
    expect(result.headerOk).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.values).toEqual({ name: 'Ayam', sort_order: '10' });
  });

  it('is false — and rows is empty — when a required column is missing from the header', () => {
    // The "missing required column" case named in the ticket: must report the
    // exact column, and must not fall through to per-row validation.
    const result = validate(entityDef('items'), parseCsv('sku,name\nBPP01,Dada Ayam\n'));
    expect(result.headerOk).toBe(false);
    expect(result.rows).toEqual([]);
    expect(result.errors.some((e) => e.column === 'base_unit' && /wajib/.test(e.message))).toBe(
      true,
    );
    expect(result.errors.some((e) => e.column === 'storage_type')).toBe(true);
  });

  it('names a misspelled header instead of silently dropping the column', () => {
    const result = validate(
      entityDef('items'),
      parseCsv('sku,name,base_unit,storage_type,katgori\nBPP01,Dada Ayam,kg,frozen,Ayam\n'),
    );
    expect(result.headerOk).toBe(false);
    expect(result.errors.some((e) => e.message.includes('Kolom tidak dikenal "katgori"'))).toBe(
      true,
    );
  });

  it('stays headerOk=true even when every data row fails — a bad file body is not a bad header', () => {
    const result = validate(
      entityDef('items'),
      parseCsv('sku,name,base_unit,storage_type\nBPP01,Dada Ayam,kg,lukewarm\n'),
    );
    expect(result.headerOk).toBe(true);
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });
});

describe("validate — the ticket's two required cases", () => {
  it('reports the exact column for a bad enum value (storage_type)', () => {
    const result = validate(
      entityDef('items'),
      parseCsv('sku,name,base_unit,storage_type\nBPP01,Dada Ayam,kg,lukewarm\n'),
    );
    expect(result.errors[0]).toMatchObject({ line: 2, column: 'storage_type' });
    expect(result.errors[0]!.message).toMatch(/frozen, chilled, dry/);
  });

  it('reports the exact column for a missing required cell (name left blank)', () => {
    const result = validate(
      entityDef('items'),
      parseCsv('sku,name,base_unit,storage_type\nBPP01,,kg,frozen\n'),
    );
    expect(result.errors[0]).toMatchObject({ line: 2, column: 'name' });
    expect(result.errors[0]!.message).toMatch(/wajib diisi/);
  });
});

describe('validate — decimals and duplicates', () => {
  it('normalises price to 2dp and accepts the Indonesian comma separator', () => {
    const result = validate(
      entityDef('products'),
      parseCsv('code,name,category,price\nP1,Ayam,Ayam,"18500,5"\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.values.price).toBe('18500.50');
  });

  it('refuses to guess between two rows sharing a natural key', () => {
    const result = validate(
      entityDef('item_categories'),
      parseCsv('name,sort_order\nAyam,1\nayam,2\n'),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/sudah muncul di baris 2/);
  });

  it('leaves an empty optional cell NULL rather than an empty string (so update never blanks an existing value)', () => {
    const result = validate(
      entityDef('items'),
      parseCsv('sku,name,base_unit,storage_type,category\nBPP01,Dada Ayam,kg,frozen,\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.values.category).toBeNull();
  });
});
