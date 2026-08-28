/**
 * Integration tests for `ImportService` against the live database — same
 * harness `modules/item`/`modules/product` already use
 * (`modules/location/test-support/live-db`). Named `.integration.test.ts`
 * (not `.spec.ts`) to match this repo's other `*.integration.test.ts` files
 * (e.g. `modules/pos/pos-shift-flow.integration.test.ts`) rather than the
 * `*.integration.spec.ts` files that predate that convention — either
 * pattern is picked up by `vitest run` the same way.
 *
 * What this file is actually here to prove (the ticket's own list):
 *   1. a clean preview reports every row as would-create/would-update with
 *      zero errors;
 *   2. a bad enum value AND a missing required header column each name the
 *      exact offending column;
 *   3. commit is atomic — one bad row in a batch writes NOTHING, even for
 *      the rows that were individually fine.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { BadRequestException } from '@nestjs/common';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StorageService } from '../../kernel/storage/storage.service';
import { ItemService } from '../item/item.service';
import { ItemCategoryService } from '../item/item-category.service';
import { ProductService } from '../product/product.service';
import { PackageService } from '../product/package.service';
import { ChartOfAccountsService } from '../accounting/chart-of-accounts.service';
import { EmployeesService } from '../hr/employees/employees.service';
import { ShiftsService } from '../hr/shifts/shifts.service';
import { AssetsService } from '../asset/assets.service';
import { ContractsService } from '../hr/contracts/contracts.service';
import { ComponentsService } from '../payroll/components/components.service';
import { SupplierService } from '../supplier/supplier.service';
import { ImportService } from './import.service';
import {
  getAppPool,
  getOwnerPool,
  loadFixtures,
  nextCode,
  withRollback,
  type Fixtures,
} from '../location/test-support/live-db';

// Constructed the way production wires them. `ConflictDetectorService` takes
// (events, conflicts) — passing only `conflictsRepo` used to land it in the
// `events` slot and leave `conflicts` undefined, so these suites exercised a
// mis-wired detector while still going green (Linear MA-184).
const eventsRepo = new SyncEventsRepository(getAppPool());
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
const sync = new SyncEmitService(eventsRepo, conflictDetector);
const itemService = new ItemService(sync);
const itemCategoryService = new ItemCategoryService(sync);
const eventBus = new EventBus();
const storage = new StorageService(new ConfigService());
const packageService = new PackageService(sync);
const productService = new ProductService(sync, eventBus, storage, packageService);
const chartOfAccountsService = new ChartOfAccountsService();
const employeesService = new EmployeesService(sync);
const shiftsService = new ShiftsService(sync);
const assetsService = new AssetsService(storage, sync);
const componentsService = new ComponentsService();
// The REAL service, no sync stub — which is the point of the `suppliers` block
// below: this construction is exactly what used to make every supplier write throw.
const supplierService = new SupplierService();
const contractsService = new ContractsService();
const importService = new ImportService(
  itemService,
  itemCategoryService,
  productService,
  chartOfAccountsService,
  employeesService,
  shiftsService,
  assetsService,
  componentsService,
  supplierService,
  contractsService,
);

const ACTOR = '00000000-0000-0000-0000-0000000000aa';
const SYSTEM_USER: JwtAccessPayload = {
  sub: ACTOR,
  username: 'system',
  roleKey: 'owner',
  locationIds: [],
};

async function cleanupCategories(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM item_categories WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupItems(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM unit_conversions WHERE item_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM items WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupChartOfAccounts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM chart_of_accounts WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupEmployees(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM employments WHERE employee_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM employees WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupWorkShifts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM work_shifts WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupAssets(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM assets WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupSalaryComponents(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM salary_components WHERE id = ANY($1::uuid[])`, [ids]);
}

async function cleanupSuppliers(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  // This importer never writes the child tables, but delete them first anyway:
  // a future column that did would otherwise turn cleanup into a foreign-key
  // failure that leaves rows behind to poison the next run.
  await pool.query(`DELETE FROM supplier_price_history WHERE supplier_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM supplier_items WHERE supplier_id = ANY($1::uuid[])`, [ids]);
  await pool.query(`DELETE FROM suppliers WHERE id = ANY($1::uuid[])`, [ids]);
}

/**
 * `chart_of_accounts.code` is `VARCHAR(10)` (real account codes are short:
 * "1101") — `nextCode()`'s `${prefix}${Date.now()}${seq}` shape is nearly 20
 * characters and overflows it. Short and still collision-safe within one
 * test run: a fixed leading digit unlikely to collide with the seeded chart
 * (migration 090's seed starts at "1000") + a monotonic counter.
 */
let coaSeq = 0;
function nextAccountCode(): string {
  coaSeq += 1;
  return `9${coaSeq}`;
}

async function cleanupProducts(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const pool = getOwnerPool();
  await pool.query(`DELETE FROM sync_events WHERE entity_id = ANY($1::uuid[])`, [ids]);
  await pool.query(
    `DELETE FROM recipe_lines WHERE recipe_id = ANY(SELECT id FROM recipes WHERE product_id = ANY($1::uuid[]))`,
    [ids],
  );
  await pool.query(`DELETE FROM recipes WHERE product_id = ANY($1::uuid[])`, [ids]);
  await pool.query(
    `DELETE FROM product_package_lines WHERE package_product_id = ANY($1::uuid[]) OR member_product_id = ANY($1::uuid[])`,
    [ids],
  );
  await pool.query(`DELETE FROM products WHERE id = ANY($1::uuid[])`, [ids]);
}

/** Byte-for-byte what `GET /import/:entity/preview`'s multipart body decodes to before reaching the service — the service takes the decoded text, not a `File`. */
const csv = (...lines: string[]) => lines.join('\r\n') + '\r\n';

describe('ImportService (live database)', () => {
  let fixtures: Fixtures;
  let warehouseCode: string;
  const createdCategoryIds: string[] = [];
  const createdItemIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdAccountIds: string[] = [];
  const createdEmployeeIds: string[] = [];
  const createdShiftIds: string[] = [];
  const createdAssetIds: string[] = [];
  const createdComponentIds: string[] = [];
  const createdSupplierIds: string[] = [];

  afterAll(async () => {
    await cleanupAssets(createdAssetIds);
    await cleanupItems(createdItemIds);
    await cleanupProducts(createdProductIds);
    await cleanupCategories(createdCategoryIds);
    await cleanupWorkShifts(createdShiftIds);
    await cleanupEmployees(createdEmployeeIds);
    await cleanupChartOfAccounts(createdAccountIds);
    await cleanupSalaryComponents(createdComponentIds);
    await cleanupSuppliers(createdSupplierIds);
  });

  it('loads fixtures', async () => {
    fixtures = await loadFixtures();
    expect(fixtures.baseUnitId).toBeTruthy();
    const loc = await getOwnerPool().query<{ code: string }>(
      `SELECT code FROM locations WHERE id = $1`,
      [fixtures.warehouseId],
    );
    warehouseCode = loc.rows[0]!.code;
    expect(warehouseCode).toBeTruthy();
  });

  describe('preview — clean file', () => {
    it('reports every row as would-create with zero errors, and writes nothing', async () => {
      const name = nextCode('ImportCat');
      const body = csv('name,sort_order', `${name},5`);

      const result = await withRollback((client) =>
        importService.preview(client, 'item_categories', body),
      );

      expect(result.fileErrors).toEqual([]);
      expect(result.errorCount).toBe(0);
      expect(result.createCount).toBe(1);
      expect(result.rows[0]).toMatchObject({ status: 'would-create', naturalKey: name });

      const found = await getOwnerPool().query(`SELECT 1 FROM item_categories WHERE name = $1`, [
        name,
      ]);
      expect(found.rowCount).toBe(0); // preview must never write
    });

    it('reports would-update for a row whose natural key already exists', async () => {
      const created = await withRollback((client) =>
        itemCategoryService.create(client, { name: nextCode('ImportCat') }, ACTOR),
      );
      createdCategoryIds.push(created.id);

      const body = csv('name,sort_order', `${created.name},9`);
      const result = await withRollback((client) =>
        importService.preview(client, 'item_categories', body),
      );

      expect(result.rows[0]).toMatchObject({ status: 'would-update', naturalKey: created.name });
      expect(result.updateCount).toBe(1);
    });
  });

  describe('preview — required-column and enum failures name the exact column', () => {
    it('a missing required header column ("base_unit") is a file-level error naming that column', async () => {
      const body = csv('sku,name,storage_type', 'BPP01,Dada Ayam,frozen');
      const result = await withRollback((client) => importService.preview(client, 'items', body));

      expect(result.rows).toEqual([]);
      expect(result.fileErrors.some((e) => e.column === 'base_unit')).toBe(true);
    });

    it('a bad enum value is a row-level error naming the "storage_type" column', async () => {
      const body = csv(
        'sku,name,base_unit,storage_type',
        `${nextCode('SKU')},Dada Ayam,kg,lukewarm`,
      );
      const result = await withRollback((client) => importService.preview(client, 'items', body));

      expect(result.fileErrors).toEqual([]);
      expect(result.errorCount).toBe(1);
      expect(result.rows[0]!.errors[0]).toMatchObject({ column: 'storage_type' });
      expect(result.rows[0]!.errors[0]!.message).toMatch(/frozen, chilled, dry/);
    });

    it('an unresolvable foreign key (unknown base_unit code) is a row-level error naming "base_unit"', async () => {
      const body = csv(
        'sku,name,base_unit,storage_type',
        `${nextCode('SKU')},Dada Ayam,NOSUCHUNIT,frozen`,
      );
      const result = await withRollback((client) => importService.preview(client, 'items', body));

      expect(result.errorCount).toBe(1);
      expect(result.rows[0]!.errors[0]).toMatchObject({ column: 'base_unit' });
    });
  });

  describe('commit — atomicity', () => {
    it('refuses a header-invalid file without writing anything', async () => {
      // Missing the only required column ("name") — a genuine header failure,
      // not just a row full of optional-column defaults.
      const body = csv('sort_order', '5');
      await expect(
        withRollback((client) =>
          importService.commit(client, 'item_categories', body, ACTOR, SYSTEM_USER, null),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('a batch with ONE bad row writes NOTHING — not even the row that was individually valid', async () => {
      const goodName = nextCode('ImportCatGood');
      const body = csv(
        'name,sort_order',
        `${goodName},5`,
        // Second row is bad: sort_order is not a whole number.
        `${nextCode('ImportCatBad')},not-a-number`,
      );

      await expect(
        withRollback((client) =>
          importService.commit(client, 'item_categories', body, ACTOR, SYSTEM_USER, null),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      // The row that on its own would have been perfectly valid must not
      // exist either — that is the whole point of "all or nothing".
      const found = await getOwnerPool().query(`SELECT 1 FROM item_categories WHERE name = $1`, [
        goodName,
      ]);
      expect(found.rowCount).toBe(0);
    });

    it('commits a clean single-row batch and reports one insert', async () => {
      const name = nextCode('ImportCatCommit');
      const body = csv('name,sort_order', `${name},7`);

      const result = await withRollback((client) =>
        importService.commit(client, 'item_categories', body, ACTOR, SYSTEM_USER, null),
      );
      expect(result).toEqual({ entity: 'item_categories', inserted: 1, updated: 0 });

      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM item_categories WHERE name = $1`,
        [name],
      );
      expect(row.rows).toHaveLength(1);
      createdCategoryIds.push(row.rows[0]!.id);
    });

    it('commits an item that resolves its category and base_unit FKs by name/code', async () => {
      const sku = nextCode('SKU');
      const body = csv('sku,name,base_unit,storage_type', `${sku},Import Test Item,kg,dry`);

      const result = await withRollback((client) =>
        importService.commit(client, 'items', body, ACTOR, SYSTEM_USER, null),
      );
      expect(result).toEqual({ entity: 'items', inserted: 1, updated: 0 });

      const row = await getOwnerPool().query<{ id: string; base_unit_id: string }>(
        `SELECT id, base_unit_id FROM items WHERE sku = $1`,
        [sku],
      );
      expect(row.rows).toHaveLength(1);
      createdItemIds.push(row.rows[0]!.id);
    });

    it('a second commit of the same sku UPDATES rather than duplicating (upsert on the natural key)', async () => {
      const sku = nextCode('SKU');
      await withRollback((client) =>
        importService.commit(
          client,
          'items',
          csv('sku,name,base_unit,storage_type', `${sku},First Name,kg,dry`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      const first = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM items WHERE sku = $1`,
        [sku],
      );
      createdItemIds.push(first.rows[0]!.id);

      const result = await withRollback((client) =>
        importService.commit(
          client,
          'items',
          csv('sku,name,base_unit,storage_type', `${sku},Renamed,kg,dry`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      expect(result).toEqual({ entity: 'items', inserted: 0, updated: 1 });

      const after = await getOwnerPool().query<{ id: string; name: string }>(
        `SELECT id, name FROM items WHERE sku = $1`,
        [sku],
      );
      expect(after.rows).toHaveLength(1); // still exactly one row — not a duplicate
      expect(after.rows[0]!.name).toBe('Renamed');
    });
  });

  describe('chart_of_accounts', () => {
    it('preview reports would-create and writes nothing; commit creates; a second commit updates the name only', async () => {
      const code = nextAccountCode();
      const body = csv('code,name,type,normal_balance', `${code},Kas Cabang,asset,debit`);

      const preview = await withRollback((client) =>
        importService.preview(client, 'chart_of_accounts', body),
      );
      expect(preview.errorCount).toBe(0);
      expect(preview.rows[0]).toMatchObject({ status: 'would-create', naturalKey: code });
      const notYet = await getOwnerPool().query(`SELECT 1 FROM chart_of_accounts WHERE code = $1`, [
        code,
      ]);
      expect(notYet.rowCount).toBe(0);

      const created = await withRollback((client) =>
        importService.commit(client, 'chart_of_accounts', body, ACTOR, SYSTEM_USER, null),
      );
      expect(created).toEqual({ entity: 'chart_of_accounts', inserted: 1, updated: 0 });
      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM chart_of_accounts WHERE code = $1`,
        [code],
      );
      createdAccountIds.push(row.rows[0]!.id);

      const renamed = csv('code,name,type,normal_balance', `${code},Kas Cabang Baru,asset,debit`);
      const updated = await withRollback((client) =>
        importService.commit(client, 'chart_of_accounts', renamed, ACTOR, SYSTEM_USER, null),
      );
      expect(updated).toEqual({ entity: 'chart_of_accounts', inserted: 0, updated: 1 });
      const after = await getOwnerPool().query<{ name: string }>(
        `SELECT name FROM chart_of_accounts WHERE code = $1`,
        [code],
      );
      expect(after.rows[0]!.name).toBe('Kas Cabang Baru');
    });

    it('fails the row naming "type" when an update tries to change the immutable account type', async () => {
      const code = nextAccountCode();
      await withRollback((client) =>
        importService.commit(
          client,
          'chart_of_accounts',
          csv('code,name,type,normal_balance', `${code},Kas,asset,debit`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM chart_of_accounts WHERE code = $1`,
        [code],
      );
      createdAccountIds.push(row.rows[0]!.id);

      const preview = await withRollback((client) =>
        importService.preview(
          client,
          'chart_of_accounts',
          csv('code,name,type,normal_balance', `${code},Kas,liability,credit`),
        ),
      );
      expect(preview.errorCount).toBe(1);
      expect(preview.rows[0]!.errors[0]).toMatchObject({ column: 'type' });
    });

    it('an unresolvable parent_code fails the row naming "parent_code"', async () => {
      const result = await withRollback((client) =>
        importService.preview(
          client,
          'chart_of_accounts',
          csv(
            'code,name,type,normal_balance,parent_code',
            `${nextAccountCode()},Sub Akun,asset,debit,NOSUCHPARENT`,
          ),
        ),
      );
      expect(result.errorCount).toBe(1);
      expect(result.rows[0]!.errors[0]).toMatchObject({ column: 'parent_code' });
    });
  });

  describe('employees', () => {
    it('preview writes nothing; commit creates; a second commit with a changed salary UPDATES and records new employment history, not a duplicate row', async () => {
      const employeeNumber = nextCode('EMP');
      const body = csv(
        'employee_number,name,position,location,join_date,base_salary',
        `${employeeNumber},Budi Santoso,Kasir,${warehouseCode},2026-01-15,3500000`,
      );

      const preview = await withRollback((client) =>
        importService.preview(client, 'employees', body),
      );
      expect(preview.errorCount).toBe(0);
      expect(preview.rows[0]).toMatchObject({ status: 'would-create' });
      const notYet = await getOwnerPool().query(
        `SELECT 1 FROM employees WHERE employee_number = $1`,
        [employeeNumber],
      );
      expect(notYet.rowCount).toBe(0);

      const created = await withRollback((client) =>
        importService.commit(client, 'employees', body, ACTOR, SYSTEM_USER, null),
      );
      expect(created).toEqual({ entity: 'employees', inserted: 1, updated: 0 });
      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM employees WHERE employee_number = $1`,
        [employeeNumber],
      );
      const employeeId = row.rows[0]!.id;
      createdEmployeeIds.push(employeeId);

      // Re-committing the IDENTICAL file must not append a second `employments` row.
      const unchanged = await withRollback((client) =>
        importService.commit(client, 'employees', body, ACTOR, SYSTEM_USER, null),
      );
      expect(unchanged).toEqual({ entity: 'employees', inserted: 0, updated: 1 });
      const historyAfterNoop = await getOwnerPool().query(
        `SELECT COUNT(*)::int AS n FROM employments WHERE employee_id = $1`,
        [employeeId],
      );
      expect(historyAfterNoop.rows[0]!.n).toBe(1);

      // A changed base_salary DOES append a new employment row (position/salary history).
      const raised = csv(
        'employee_number,name,position,location,join_date,base_salary',
        `${employeeNumber},Budi Santoso,Kasir,${warehouseCode},2026-01-15,4000000`,
      );
      await withRollback((client) =>
        importService.commit(client, 'employees', raised, ACTOR, SYSTEM_USER, null),
      );
      const historyAfterRaise = await getOwnerPool().query(
        `SELECT COUNT(*)::int AS n FROM employments WHERE employee_id = $1`,
        [employeeId],
      );
      expect(historyAfterRaise.rows[0]!.n).toBe(2);
    });

    it('an unresolvable location code fails the row naming "location"', async () => {
      const result = await withRollback((client) =>
        importService.preview(
          client,
          'employees',
          csv(
            'employee_number,name,position,location,join_date,base_salary',
            `${nextCode('EMP')},Budi,Kasir,NOSUCHLOC,2026-01-15,3500000`,
          ),
        ),
      );
      expect(result.errorCount).toBe(1);
      expect(result.rows[0]!.errors[0]).toMatchObject({ column: 'location' });
    });
  });

  describe('work_shifts', () => {
    it('preview writes nothing; commit creates; a second commit UPDATES the same (name, location) shift', async () => {
      const name = nextCode('Shift');
      const body = csv(
        'name,location,start_time,end_time,break_minutes',
        `${name},${warehouseCode},07:00,15:00,60`,
      );

      const preview = await withRollback((client) =>
        importService.preview(client, 'work_shifts', body),
      );
      expect(preview.errorCount).toBe(0);
      expect(preview.rows[0]).toMatchObject({ status: 'would-create' });

      const created = await withRollback((client) =>
        importService.commit(client, 'work_shifts', body, ACTOR, SYSTEM_USER, null),
      );
      expect(created).toEqual({ entity: 'work_shifts', inserted: 1, updated: 0 });
      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM work_shifts WHERE name = $1 AND location_id = (SELECT id FROM locations WHERE code = $2)`,
        [name, warehouseCode],
      );
      createdShiftIds.push(row.rows[0]!.id);

      const updated = await withRollback((client) =>
        importService.commit(
          client,
          'work_shifts',
          csv(
            'name,location,start_time,end_time,break_minutes',
            `${name},${warehouseCode},08:00,16:00,30`,
          ),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      expect(updated).toEqual({ entity: 'work_shifts', inserted: 0, updated: 1 });
      const after = await getOwnerPool().query<{ start_time: string }>(
        `SELECT start_time FROM work_shifts WHERE id = $1`,
        [row.rows[0]!.id],
      );
      expect(String(after.rows[0]!.start_time)).toMatch(/^08:00/);
    });

    it('a global shift (blank location) and a location-scoped shift sharing the same name commit as TWO separate rows', async () => {
      const name = nextCode('Shift');
      const body = csv(
        'name,location,start_time,end_time',
        `${name},,07:00,15:00`,
        `${name},${warehouseCode},08:00,16:00`,
      );

      const result = await withRollback((client) =>
        importService.commit(client, 'work_shifts', body, ACTOR, SYSTEM_USER, null),
      );
      expect(result).toEqual({ entity: 'work_shifts', inserted: 2, updated: 0 });

      const rows = await getOwnerPool().query<{ id: string; location_id: string | null }>(
        `SELECT id, location_id FROM work_shifts WHERE name = $1`,
        [name],
      );
      expect(rows.rows).toHaveLength(2);
      createdShiftIds.push(...rows.rows.map((r) => r.id));
      expect(rows.rows.some((r) => r.location_id === null)).toBe(true);
      expect(rows.rows.some((r) => r.location_id !== null)).toBe(true);
    });
  });

  describe('assets', () => {
    it('preview writes nothing; commit creates; a second commit UPDATES rather than duplicating', async () => {
      const assetNumber = nextCode('AST');
      const body = csv(
        'asset_number,name,category,location',
        `${assetNumber},Freezer Box 200L,equipment,${warehouseCode}`,
      );

      const preview = await withRollback((client) => importService.preview(client, 'assets', body));
      expect(preview.errorCount).toBe(0);
      expect(preview.rows[0]).toMatchObject({ status: 'would-create' });
      const notYet = await getOwnerPool().query(`SELECT 1 FROM assets WHERE asset_number = $1`, [
        assetNumber,
      ]);
      expect(notYet.rowCount).toBe(0);

      const created = await withRollback((client) =>
        importService.commit(client, 'assets', body, ACTOR, SYSTEM_USER, null),
      );
      expect(created).toEqual({ entity: 'assets', inserted: 1, updated: 0 });
      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM assets WHERE asset_number = $1`,
        [assetNumber],
      );
      createdAssetIds.push(row.rows[0]!.id);

      const renamed = csv(
        'asset_number,name,category,location',
        `${assetNumber},Freezer Box 300L,equipment,${warehouseCode}`,
      );
      const updated = await withRollback((client) =>
        importService.commit(client, 'assets', renamed, ACTOR, SYSTEM_USER, null),
      );
      expect(updated).toEqual({ entity: 'assets', inserted: 0, updated: 1 });
      const after = await getOwnerPool().query<{ name: string }>(
        `SELECT name FROM assets WHERE asset_number = $1`,
        [assetNumber],
      );
      expect(after.rows).toHaveLength(1); // still exactly one row — not a duplicate
      expect(after.rows[0]!.name).toBe('Freezer Box 300L');
    });

    it('an unknown category is a row-level error naming "category"', async () => {
      const result = await withRollback((client) =>
        importService.preview(
          client,
          'assets',
          csv(
            'asset_number,name,category,location',
            `${nextCode('AST')},Truk,truk,${warehouseCode}`,
          ),
        ),
      );
      expect(result.errorCount).toBe(1);
      expect(result.rows[0]!.errors[0]).toMatchObject({ column: 'category' });
    });
  });

  describe('salary_components', () => {
    it('commit is atomic: ONE bad row (unknown calc_method) writes nothing, not even the row that was individually valid', async () => {
      const goodCode = nextCode('COMP');
      const body = csv(
        'code,name,type,calc_method',
        `${goodCode},Tunjangan Transport,earning,fixed`,
        // Second row is bad: calc_method is not one of the allowed values.
        `${nextCode('COMP')},Potongan Kasbon,deduction,unknown_method`,
      );

      await expect(
        withRollback((client) =>
          importService.commit(client, 'salary_components', body, ACTOR, SYSTEM_USER, null),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      const found = await getOwnerPool().query(`SELECT 1 FROM salary_components WHERE code = $1`, [
        goodCode,
      ]);
      expect(found.rowCount).toBe(0);
    });

    it('commits a clean row, then a second commit UPDATES default_amount rather than duplicating', async () => {
      const code = nextCode('COMP');
      const body = csv(
        'code,name,type,calc_method,default_amount',
        `${code},Tunjangan Transport,earning,fixed,100000`,
      );

      const created = await withRollback((client) =>
        importService.commit(client, 'salary_components', body, ACTOR, SYSTEM_USER, null),
      );
      expect(created).toEqual({ entity: 'salary_components', inserted: 1, updated: 0 });
      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM salary_components WHERE code = $1`,
        [code],
      );
      createdComponentIds.push(row.rows[0]!.id);

      const raised = csv(
        'code,name,type,calc_method,default_amount',
        `${code},Tunjangan Transport,earning,fixed,150000`,
      );
      const updated = await withRollback((client) =>
        importService.commit(client, 'salary_components', raised, ACTOR, SYSTEM_USER, null),
      );
      expect(updated).toEqual({ entity: 'salary_components', inserted: 0, updated: 1 });
      const after = await getOwnerPool().query<{ default_amount: string }>(
        `SELECT default_amount FROM salary_components WHERE code = $1`,
        [code],
      );
      expect(Number(after.rows[0]!.default_amount)).toBe(150000);
    });

    it('fails a row naming "type" when it tries to change an existing component\'s immutable type', async () => {
      const code = nextCode('COMP');
      await withRollback((client) =>
        importService.commit(
          client,
          'salary_components',
          csv('code,name,type,calc_method', `${code},Tunjangan Transport,earning,fixed`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      const row = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM salary_components WHERE code = $1`,
        [code],
      );
      createdComponentIds.push(row.rows[0]!.id);

      const preview = await withRollback((client) =>
        importService.preview(
          client,
          'salary_components',
          csv('code,name,type,calc_method', `${code},Tunjangan Transport,deduction,fixed`),
        ),
      );
      expect(preview.errorCount).toBe(1);
      expect(preview.rows[0]!.errors[0]).toMatchObject({ column: 'type' });
    });
  });

  /**
   * THE REGRESSION THIS BLOCK EXISTS FOR (2026-08-27). `suppliers` could not be
   * imported at all until now, and not because of anything in this module:
   * `SupplierService.create`/`update` called `SyncEmitService.emit` for an
   * entity that is class `X` with an empty `ops` list in the authority matrix
   * (FR-SUP-06 — supplier pricing must never reach a device), and
   * `canOriginate` rejects an unknown op before the cloud-tier exemption, so
   * the call threw on every write. The hand-typed "Add Supplier" screen failed
   * identically. It stayed hidden because every test in
   * `supplier.integration.spec.ts` passed a no-op `emit` stub.
   *
   * This suite builds `SupplierService` for real, so these cases fail against
   * the old code with "suppliers.created is not a known op for this entity"
   * and pass against the fix.
   */
  describe('suppliers', () => {
    it('creates a supplier through the real service — the write that used to throw on sync emit', async () => {
      const code = nextCode('SUP');
      const body = csv(
        'code,name,contact_name,phone,payment_terms_days,bank_name,outlet_visible',
        `${code},PT Ayam Jaya,Budi,+62-812-3456789,30,BCA,tidak`,
      );

      const result = await withRollback((client) =>
        importService.commit(client, 'suppliers', body, ACTOR, SYSTEM_USER, null),
      );
      expect(result).toEqual({ entity: 'suppliers', inserted: 1, updated: 0 });

      const row = await getOwnerPool().query<{
        id: string;
        name: string;
        contact_name: string;
        payment_terms_days: number;
        outlet_visible: boolean;
      }>(
        `SELECT id, name, contact_name, payment_terms_days, outlet_visible
           FROM suppliers WHERE code = $1`,
        [code],
      );
      expect(row.rowCount).toBe(1);
      createdSupplierIds.push(row.rows[0]!.id);
      expect(row.rows[0]!.name).toBe('PT Ayam Jaya');
      expect(row.rows[0]!.contact_name).toBe('Budi');
      expect(row.rows[0]!.payment_terms_days).toBe(30);
      expect(row.rows[0]!.outlet_visible).toBe(false);
    });

    it('defaults outlet_visible to FALSE when the column is blank', async () => {
      // D-20: this flag is what exposes a supplier to outlet roles. A blank
      // cell must never open that up by accident.
      const code = nextCode('SUP');
      const created = await withRollback((client) =>
        importService.commit(
          client,
          'suppliers',
          csv('code,name', `${code},PT Sayur Segar`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      expect(created).toEqual({ entity: 'suppliers', inserted: 1, updated: 0 });
      const row = await getOwnerPool().query<{ id: string; outlet_visible: boolean }>(
        `SELECT id, outlet_visible FROM suppliers WHERE code = $1`,
        [code],
      );
      createdSupplierIds.push(row.rows[0]!.id);
      expect(row.rows[0]!.outlet_visible).toBe(false);
    });

    it('a second commit UPDATES on code rather than duplicating', async () => {
      const code = nextCode('SUP');
      await withRollback((client) =>
        importService.commit(
          client,
          'suppliers',
          csv('code,name,payment_terms_days', `${code},PT Ayam Jaya,30`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      const first = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM suppliers WHERE code = $1`,
        [code],
      );
      createdSupplierIds.push(first.rows[0]!.id);

      const updated = await withRollback((client) =>
        importService.commit(
          client,
          'suppliers',
          csv('code,name,payment_terms_days', `${code},PT Ayam Jaya Sejahtera,45`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      expect(updated).toEqual({ entity: 'suppliers', inserted: 0, updated: 1 });

      const after = await getOwnerPool().query<{
        id: string;
        name: string;
        payment_terms_days: number;
      }>(`SELECT id, name, payment_terms_days FROM suppliers WHERE code = $1`, [code]);
      // Still ONE row, same id — an upsert, not a second insert.
      expect(after.rowCount).toBe(1);
      expect(after.rows[0]!.id).toBe(first.rows[0]!.id);
      expect(after.rows[0]!.name).toBe('PT Ayam Jaya Sejahtera');
      expect(after.rows[0]!.payment_terms_days).toBe(45);
    });

    it('commits TWO rows — the multi-row path, on an entity whose service self-commits', async () => {
      // Exercises re-establishing the RLS session context between rows (see
      // `import.service.ts`'s commit loop): row 1 committing reverts
      // `SET LOCAL ROLE`, and without the fix row 2 fails "permission denied".
      const a = nextCode('SUP');
      const b = nextCode('SUP');
      const result = await withRollback((client) =>
        importService.commit(
          client,
          'suppliers',
          csv('code,name', `${a},Supplier A`, `${b},Supplier B`),
          ACTOR,
          SYSTEM_USER,
          null,
        ),
      );
      expect(result).toEqual({ entity: 'suppliers', inserted: 2, updated: 0 });
      const rows = await getOwnerPool().query<{ id: string }>(
        `SELECT id FROM suppliers WHERE code = ANY($1::text[])`,
        [[a, b]],
      );
      expect(rows.rowCount).toBe(2);
      createdSupplierIds.push(...rows.rows.map((r) => r.id));
    });

    it('rejects a row with no code, and writes NEITHER row', async () => {
      const good = nextCode('SUP');
      await expect(
        withRollback((client) =>
          importService.commit(
            client,
            'suppliers',
            csv('code,name', `${good},Supplier Baik`, `,Supplier Tanpa Kode`),
            ACTOR,
            SYSTEM_USER,
            null,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const found = await getOwnerPool().query(`SELECT 1 FROM suppliers WHERE code = $1`, [good]);
      expect(found.rowCount).toBe(0);
    });
  });
});
