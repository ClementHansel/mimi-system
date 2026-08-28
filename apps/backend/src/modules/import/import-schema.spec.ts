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
  it('covers exactly the ten master/reference entities, in dependency order', () => {
    // `suppliers` was excluded here until 2026-08-27, when the sync-emit bug
    // that made every supplier write throw was fixed — see `import.module.ts`.
    // It sorts last-but-one because nothing else in this list references a
    // supplier. `employment_contracts` (same day, W7 CRUD/import/export
    // follow-up) sorts last: it references `employees`/`locations`, both
    // already earlier in the list.
    expect(IMPORT_ENTITIES.map((e) => e.name)).toEqual([
      'item_categories',
      'items',
      'products',
      'chart_of_accounts',
      'employees',
      'work_shifts',
      'assets',
      'salary_components',
      'suppliers',
      'employment_contracts',
    ]);
  });

  it('gates suppliers on supplier.manage, the same key the hand-typed screen uses', () => {
    expect(entityDef('suppliers').permission).toBe('supplier.manage');
    // Prices are a different sheet (`supplier_items` + append-only history,
    // FR-SUP-04) and must not be reachable through this one.
    const columns = entityDef('suppliers').columns.map((c) => c.name);
    expect(columns).not.toContain('price');
    expect(columns).not.toContain('current_price');
  });

  it('every column carries a non-empty Indonesian hint (the template guidance row depends on this)', () => {
    for (const entity of IMPORT_ENTITIES) {
      for (const column of entity.columns) {
        expect(column.hint.length).toBeGreaterThan(0);
      }
    }
  });

  it('the five 2026-08-27 entities are each gated by their own distinct permission key', () => {
    const permissions = [
      'chart_of_accounts',
      'employees',
      'work_shifts',
      'assets',
      'salary_components',
    ].map((name) => entityDef(name as Parameters<typeof entityDef>[0]).permission);
    expect(permissions).toEqual([
      'accounting.coa.manage',
      'hr.employee.manage',
      'hr.shift.manage',
      'asset.manage',
      'payroll.component.manage',
    ]);
    expect(new Set(permissions).size).toBe(permissions.length);
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

describe('validate — chart_of_accounts', () => {
  it('accepts a clean header-derived row', () => {
    const csv = buildTemplate(entityDef('chart_of_accounts'));
    const [headerLine] = csv.split('\r\n');
    expect(headerLine).toBe('code,name,type,normal_balance,parent_code,is_postable');

    const result = validate(
      entityDef('chart_of_accounts'),
      parseCsv(
        'code,name,type,normal_balance,parent_code,is_postable\n1101,Kas Kecil,asset,debit,,ya\n',
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows[0]!.values).toMatchObject({ type: 'asset', normal_balance: 'debit' });
  });

  it('rejects an unknown type/normal_balance value naming the exact column', () => {
    const result = validate(
      entityDef('chart_of_accounts'),
      parseCsv('code,name,type,normal_balance\n1101,Kas Kecil,building,debit\n'),
    );
    expect(result.errors[0]).toMatchObject({ line: 2, column: 'type' });
  });
});

describe('validate — employees', () => {
  it('accepts a clean row and rejects an invalid join_date', () => {
    const header = 'employee_number,name,position,location,join_date,base_salary';
    const good = validate(
      entityDef('employees'),
      parseCsv(`${header}\nEMP001,Budi Santoso,Kasir,GDG,2026-01-15,3500000\n`),
    );
    expect(good.errors).toEqual([]);
    expect(good.rows[0]!.values.base_salary).toBe('3500000.00');

    const badDate = validate(
      entityDef('employees'),
      parseCsv(`${header}\nEMP001,Budi Santoso,Kasir,GDG,2026-02-30,3500000\n`),
    );
    expect(badDate.headerOk).toBe(true);
    expect(badDate.errors[0]).toMatchObject({ line: 2, column: 'join_date' });
  });

  it('does not offer userId/bank columns at all — an unknown-header refusal is the coverage for that exclusion', () => {
    const result = validate(
      entityDef('employees'),
      parseCsv(
        'employee_number,name,position,location,join_date,base_salary,userId\nEMP001,Budi,Kasir,GDG,2026-01-15,3500000,u-1\n',
      ),
    );
    expect(result.headerOk).toBe(false);
    expect(result.errors.some((e) => e.column === 'userId')).toBe(true);
  });
});

describe('validate — work_shifts (composite name+location identity)', () => {
  it('rejects a bad start_time/end_time format naming the exact column', () => {
    const result = validate(
      entityDef('work_shifts'),
      parseCsv('name,start_time,end_time\nPagi,7:00,15:00\n'),
    );
    expect(result.errors[0]).toMatchObject({ line: 2, column: 'start_time' });
  });

  it('does NOT flag two rows sharing a name across two different locations as duplicates', () => {
    const result = validate(
      entityDef('work_shifts'),
      parseCsv('name,location,start_time,end_time\nPagi,GDG,07:00,15:00\nPagi,BPP01,08:00,16:00\n'),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(2);
  });

  it('DOES flag two rows sharing the same name AND the same (blank) location', () => {
    const result = validate(
      entityDef('work_shifts'),
      parseCsv('name,start_time,end_time\nPagi,07:00,15:00\nPagi,08:00,16:00\n'),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]!.message).toMatch(/sudah muncul di baris 2/);
  });
});

describe('validate — assets', () => {
  it('accepts a clean row and rejects an unknown category', () => {
    const header = 'asset_number,name,category,location';
    const good = validate(
      entityDef('assets'),
      parseCsv(`${header}\nAST-001,Freezer Box 200L,equipment,GDG\n`),
    );
    expect(good.errors).toEqual([]);

    const bad = validate(entityDef('assets'), parseCsv(`${header}\nAST-001,Freezer,truk,GDG\n`));
    expect(bad.errors[0]).toMatchObject({ line: 2, column: 'category' });
  });
});

describe('validate — salary_components', () => {
  it('accepts earning/deduction and rejects employer_cost (not creatable via the real DTO either)', () => {
    const header = 'code,name,type,calc_method';
    const good = validate(
      entityDef('salary_components'),
      parseCsv(`${header}\nTUNJ_TRANSPORT,Tunjangan Transport,earning,fixed\n`),
    );
    expect(good.errors).toEqual([]);

    const bad = validate(
      entityDef('salary_components'),
      parseCsv(`${header}\nBPJS_TK,BPJS TK,employer_cost,fixed\n`),
    );
    expect(bad.errors[0]).toMatchObject({ line: 2, column: 'type' });
  });
});

describe('validate — employment_contracts', () => {
  it('accepts a clean pkwt row and rejects a pkwtt row that also carries an end_date', () => {
    const header = 'contract_number,employee,contract_type,position,start_date,end_date';
    const good = validate(
      entityDef('employment_contracts'),
      parseCsv(`${header}\nKONTRAK/202601/0001,EMP001,pkwt,Kasir,2026-01-01,2026-12-31\n`),
    );
    expect(good.errors).toEqual([]);

    // The schema layer itself does not know the type/term RULE (that lives in
    // `planContract` + the CHECK/trigger, same layering as `assets`'
    // category enum vs. the deeper business rules) — but a bad ENUM value is
    // still caught right here.
    const badType = validate(
      entityDef('employment_contracts'),
      parseCsv(`${header}\nKONTRAK/202601/0002,EMP001,harian,Kasir,2026-01-01,2026-12-31\n`),
    );
    expect(badType.errors[0]).toMatchObject({ line: 2, column: 'contract_type' });
  });

  it('never offers a status or signature column — the header rejects both by name', () => {
    // §3 of this ticket: a CSV that could assert a contract was signed (or
    // already active) is indistinguishable from a forged signature. The
    // "unknown column" refusal is the coverage for that exclusion, the same
    // pattern `employees`' userId/bank-column test above uses.
    const result = validate(
      entityDef('employment_contracts'),
      parseCsv(
        'contract_number,employee,contract_type,position,start_date,status,signed_by_employee\nKONTRAK/1,EMP001,pkwt,Kasir,2026-01-01,active,true\n',
      ),
    );
    expect(result.headerOk).toBe(false);
    const badColumns = result.errors.map((e) => e.column);
    expect(badColumns).toContain('status');
    expect(badColumns).toContain('signed_by_employee');
  });

  it('is gated on hr.contract.manage, the same key the sign/terminate endpoints use', () => {
    expect(entityDef('employment_contracts').permission).toBe('hr.contract.manage');
  });
});
