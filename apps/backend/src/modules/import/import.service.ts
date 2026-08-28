import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AccountType, AssetCategory, ItemStorageType } from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { ItemService } from '../item/item.service';
import { ItemCategoryService } from '../item/item-category.service';
import type { CreateItemDto, UpdateItemDto, CreateItemCategoryDto } from '../item/dto/item.dto';
import { ProductService } from '../product/product.service';
import type { CreateProductDto, UpdateProductDto } from '../product/dto/product.dto';
import { ChartOfAccountsService } from '../accounting/chart-of-accounts.service';
import type { CreateAccountDto, UpdateAccountDto } from '../accounting/dto/accounting.dto';
import { EmployeesService } from '../hr/employees/employees.service';
import type { CreateEmployeeDto, UpdateEmployeeDto } from '../hr/dto/employee.dto';
import { ShiftsService } from '../hr/shifts/shifts.service';
import type { CreateShiftDto, UpdateShiftDto } from '../hr/dto/shift.dto';
import { AssetsService } from '../asset/assets.service';
import type { CreateAssetDto, UpdateAssetDto } from '../asset/dto/asset.dto';
import { ComponentsService } from '../payroll/components/components.service';
import type { CreateComponentDto, UpdateComponentDto } from '../payroll/dto/payroll.dto';
import { SupplierService } from '../supplier/supplier.service';
import type { CreateSupplierDto, UpdateSupplierDto } from '../supplier/supplier.service';
import { ContractsService } from '../hr/contracts/contracts.service';
import type { CreateContractDto, UpdateContractDto } from '../hr/dto/contract.dto';
import {
  buildTemplate,
  entityDef,
  parseCsv,
  stripGuidanceRows,
  validate,
  type ImportEntityDef,
  type ImportEntityName,
  type ValidatedRow,
} from './import-schema';

export type RowOutcome = 'would-create' | 'would-update' | 'error';

export interface PreviewRowResult {
  line: number;
  status: RowOutcome;
  /** The row's natural-key value (sku/code/name), even when it errored — lets the UI show "row 7 (BPP01): …" instead of just a line number. `null` only when the row failed before the natural key column could be read. */
  naturalKey: string | null;
  errors: { column?: string; message: string }[];
}

export interface PreviewResult {
  entity: ImportEntityName;
  /**
   * Header/structural problems (unknown column, missing required column).
   * Non-empty ONLY when the file's shape itself is wrong — in that case
   * `rows` is always empty; there is nothing per-row to report yet.
   */
  fileErrors: { column?: string; message: string }[];
  totalDataRows: number;
  createCount: number;
  updateCount: number;
  errorCount: number;
  rows: PreviewRowResult[];
}

export interface CommitResult {
  entity: ImportEntityName;
  inserted: number;
  updated: number;
}

interface RowPlan {
  line: number;
  naturalKey: string | null;
  error?: { column?: string; message: string };
  existingId?: string | null;
  /** Only present when the row is error-free. Performs the actual write (create or update) and reports which it did. */
  apply?: (actorUserId: string) => Promise<'created' | 'updated'>;
}

/**
 * `import` — BFF bulk-import for eight master/reference-data entities chosen
 * for value/risk (see `import.module.ts`'s header comment for the full
 * per-entity reasoning, and why `units`/`suppliers`/anything transactional
 * are NOT here).
 *
 * DELIBERATE DESIGN: every write in this service goes through the SAME
 * `ItemService`/`ItemCategoryService`/`ProductService`/`ChartOfAccountsService`/
 * `EmployeesService`/`ShiftsService`/`AssetsService`/`ComponentsService`
 * methods the regular hand-typed screens already call — never a parallel
 * `INSERT`/`UPDATE`. That is what keeps a bulk-imported row indistinguishable
 * from a hand-typed one: same validation, same sync-event payload shape (so
 * an offline device pulling `items`/`product_categories`/`products`/
 * `employees`/`work_shifts`/`assets` sees no difference — `chart_of_accounts`/
 * `salary_components` are class X, never synced at all, by both the real
 * screens and this one), same audit trail. The only things this service owns
 * are (1) resolving a sheet's human-readable foreign keys (a category NAME, a
 * unit CODE, a location CODE, an employee CODE) to the ids those services
 * need, and (2) deciding create-vs-update from the natural key.
 *
 * `preview` and `commit` share ALL of this — `commit` is `preview` with
 * `write: true`, plus the atomicity rule: it re-validates the whole file
 * (never trusts a client-supplied "I already previewed this") and refuses to
 * call a single write if any row is bad. Every write happens on the
 * request's own RLS-scoped `client` — see `request-db-client.ts`.
 */
@Injectable()
export class ImportService {
  constructor(
    private readonly items: ItemService,
    private readonly itemCategories: ItemCategoryService,
    private readonly products: ProductService,
    private readonly chartOfAccounts: ChartOfAccountsService,
    private readonly employees: EmployeesService,
    private readonly shifts: ShiftsService,
    private readonly assets: AssetsService,
    private readonly salaryComponents: ComponentsService,
    private readonly suppliers: SupplierService,
    private readonly contracts: ContractsService,
  ) {}

  permissionFor(entityName: ImportEntityName): string {
    return entityDef(entityName).permission;
  }

  template(entityName: ImportEntityName): string {
    return buildTemplate(entityDef(entityName));
  }

  async preview(
    client: PoolClient,
    entityName: ImportEntityName,
    csvText: string,
  ): Promise<PreviewResult> {
    const plan = await this.plan(client, entityName, csvText);
    if (!plan.headerOk) {
      return {
        entity: entityName,
        fileErrors: plan.fileErrors,
        totalDataRows: 0,
        createCount: 0,
        updateCount: 0,
        errorCount: 0,
        rows: [],
      };
    }

    const rows: PreviewRowResult[] = plan.rowPlans.map((p) => ({
      line: p.line,
      status: p.error ? 'error' : p.existingId ? 'would-update' : 'would-create',
      naturalKey: p.naturalKey,
      errors: p.error ? [p.error] : [],
    }));

    return {
      entity: entityName,
      fileErrors: [],
      totalDataRows: rows.length,
      createCount: rows.filter((r) => r.status === 'would-create').length,
      updateCount: rows.filter((r) => r.status === 'would-update').length,
      errorCount: rows.filter((r) => r.status === 'error').length,
      rows,
    };
  }

  /**
   * All-or-nothing: re-runs the exact same validation `preview` did, and
   * writes NOTHING if a single row is bad. Every accepted row's write
   * (`apply`) runs on `client` — the caller's own `withWrite`-wrapped
   * transaction is what `ItemService.create`/`update` etc. already open per
   * call, so "one transaction" here means "the same client, sequentially",
   * not one that this service opens itself: those services self-commit
   * (BE-TXN-ROLLBACK is the reason every module here follows that one
   * pattern), so this service does the abort check BEFORE calling any of
   * them rather than trying to roll a partial batch back afterward.
   */
  async commit(
    client: PoolClient,
    entityName: ImportEntityName,
    csvText: string,
    actorUserId: string,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<CommitResult> {
    const plan = await this.plan(client, entityName, csvText, { user, locationScope });
    if (!plan.headerOk) {
      throw new BadRequestException({
        code: 'ERR_VALIDATION',
        message: 'Berkas tidak valid — periksa nama kolom pada header',
        details: plan.fileErrors,
      });
    }
    const bad = plan.rowPlans.filter((p) => p.error);
    if (bad.length > 0) {
      throw new BadRequestException({
        code: 'ERR_VALIDATION',
        message: `${bad.length} dari ${plan.rowPlans.length} baris tidak valid — TIDAK ADA yang disimpan`,
        details: bad.map((p) => ({ line: p.line, naturalKey: p.naturalKey, ...p.error })),
      });
    }
    if (plan.rowPlans.length === 0) {
      return { entity: entityName, inserted: 0, updated: 0 };
    }

    let inserted = 0;
    let updated = 0;
    for (const row of plan.rowPlans) {
      // `plan.headerOk` + the `bad.length` guard above mean every row here has
      // `apply` set — this loop never silently skips a row.
      const outcome = await row.apply!(actorUserId);
      if (outcome === 'created') inserted++;
      else updated++;
      // BUG FOUND WHILE ADDING THIS ROUND'S FIVE NEW ENTITIES, reproduced live
      // against the real database, and confirmed to ALSO break every
      // previously-shipped entity (`item_categories`/`items`/`products`) —
      // any commit of 2+ successful rows, for ANY entity this module has ever
      // supported, silently failed row 2 onward with a raw
      // "permission denied for table X" from `pg`, never even reaching this
      // service's own error handling.
      //
      // WHY: every domain service's mutating method self-commits — `withWrite`
      // (each module's own `db-tx.ts`) does its own `BEGIN`/`COMMIT`, per the
      // repo-wide "one call, one COMMIT" convention (BE-TXN-ROLLBACK) that
      // matches every OTHER controller in the app, which calls exactly ONE
      // mutating service method per request. `RlsContextGuard` sets
      // `SET LOCAL ROLE app_user` + `app.user_id`/`app.role`/`app.location_ids`
      // via `set_config(..., true)` — both `LOCAL`/`is_local`, DELIBERATELY
      // scoped to the CURRENT transaction (see that guard's own header: this is
      // what stops one request's session context leaking to the next request on
      // a pooled connection). Postgres reverts BOTH automatically at COMMIT —
      // which row.apply()'s OWN `withWrite` just did. `client`'s login role
      // (`mimi_app`) holds ZERO direct table grants (D-21/D-22 — every real
      // grant is on `app_user`), so the very next statement on this connection,
      // still inside THIS method, runs as bare `mimi_app` and is refused outright.
      //
      // This loop is the ONE place in the whole app that calls more than one
      // self-committing mutation on the same request/client — every other
      // module's `withWrite` convention was never wrong for its own single-call
      // callers. The fix belongs here: re-open a transaction and re-establish
      // the exact same session context `RlsContextGuard` set at request start
      // (reusing `actorUserId`/`user`/`locationScope`, already in hand — no
      // extra DB read, unlike that guard's own `ScopeService.resolveLocationIds`
      // phase 2, which only needed running once, before this method was ever
      // called), so the NEXT row's `apply()` (or `RlsCleanupInterceptor`'s
      // final, always-safe `ROLLBACK`) runs under the right role again.
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [actorUserId]);
      await client.query(`SELECT set_config('app.role', $1, true)`, [user.roleKey]);
      await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
        locationScope === null ? '' : locationScope.join(','),
      ]);
    }
    return { entity: entityName, inserted, updated };
  }

  // ── shared planning ────────────────────────────────────────────────────────

  private async plan(
    client: PoolClient,
    entityName: ImportEntityName,
    csvText: string,
    // Used again now that `products` is back: `ProductService.create`/`update`
    // take a caller identity, so a product row cannot be WRITTEN without one.
    // Still optional, because `preview` plans every row and writes none.
    write?: { user: JwtAccessPayload; locationScope: string[] | null },
  ): Promise<
    | { headerOk: true; rowPlans: RowPlan[] }
    | { headerOk: false; fileErrors: { column?: string; message: string }[] }
  > {
    const def = entityDef(entityName);
    const csv = stripGuidanceRows(parseCsv(csvText));
    const result = validate(def, csv);
    if (!result.headerOk) {
      return {
        headerOk: false,
        fileErrors: result.errors.map((e) => ({ column: e.column, message: e.message })),
      };
    }

    // Row-level format errors (bad enum, missing required cell, duplicate key,
    // …) never made it into `result.rows` — fold them back in by line number
    // so the final per-row list covers every data line, not just the good ones.
    const formatErrorsByLine = new Map<number, { column?: string; message: string }>();
    for (const e of result.errors)
      formatErrorsByLine.set(e.line, { column: e.column, message: e.message });

    const rowPlans: RowPlan[] = [];
    for (const row of result.rows) {
      const built = await this.buildRowPlan(client, def, row, write);
      rowPlans.push(built);
    }
    // Merge in the lines that never reached `buildRowPlan` because they failed
    // schema validation — sorted by line so the UI shows the file top-to-bottom.
    for (const [line, error] of formatErrorsByLine) {
      rowPlans.push({ line, naturalKey: null, error });
    }
    rowPlans.sort((a, b) => a.line - b.line);

    return { headerOk: true, rowPlans };
  }

  private async buildRowPlan(
    client: PoolClient,
    def: ImportEntityDef,
    row: ValidatedRow,
    write?: { user: JwtAccessPayload; locationScope: string[] | null },
  ): Promise<RowPlan> {
    switch (def.name) {
      case 'item_categories':
        return this.planItemCategory(client, row);
      case 'items':
        return this.planItem(client, row);
      case 'products':
        return this.planProduct(client, row, write);
      case 'chart_of_accounts':
        return this.planChartOfAccount(client, row);
      case 'employees':
        return this.planEmployee(client, row);
      case 'work_shifts':
        return this.planWorkShift(client, row);
      case 'assets':
        return this.planAsset(client, row, write);
      case 'salary_components':
        return this.planSalaryComponent(client, row);
      case 'suppliers':
        return this.planSupplier(client, row);
      case 'employment_contracts':
        return this.planContract(client, row);
      /* istanbul ignore next -- exhaustiveness guard, `def.name` is the closed `ImportEntityName` union */
      default:
        throw new Error(`unhandled import entity "${(def as ImportEntityDef).name}"`);
    }
  }

  private async findExisting(
    client: PoolClient,
    table: string,
    column: string,
    value: string,
  ): Promise<string | null> {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM ${table} WHERE lower(${column}) = lower($1)`,
      [value],
    );
    return res.rows[0]?.id ?? null;
  }

  private async planItemCategory(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const name = row.values.name!;
    const existingId = await this.findExisting(client, 'item_categories', 'name', name);
    const sortOrder = row.values.sort_order != null ? Number(row.values.sort_order) : undefined;
    return {
      line: row.line,
      naturalKey: name,
      existingId,
      apply: async (actorUserId) => {
        if (existingId) {
          await this.itemCategories.update(client, existingId, { name, sortOrder }, actorUserId);
          return 'updated';
        }
        const dto: CreateItemCategoryDto = { name, sortOrder };
        await this.itemCategories.create(client, dto, actorUserId);
        return 'created';
      },
    };
  }

  private async planItem(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const sku = row.values.sku!;
    const baseUnitCode = row.values.base_unit!;
    const unitRes = await client.query<{ id: string }>(
      `SELECT id FROM units WHERE lower(code) = lower($1)`,
      [baseUnitCode],
    );
    if (!unitRes.rows[0]) {
      return {
        line: row.line,
        naturalKey: sku,
        error: {
          column: 'base_unit',
          message: `Satuan "${baseUnitCode}" tidak ditemukan — buat dulu di Master Data > Satuan`,
        },
      };
    }
    const baseUnitId = unitRes.rows[0].id;

    let categoryId: string | undefined;
    if (row.values.category) {
      const found = await this.findExisting(client, 'item_categories', 'name', row.values.category);
      if (!found) {
        return {
          line: row.line,
          naturalKey: sku,
          error: {
            column: 'category',
            message: `Kategori item "${row.values.category}" tidak ditemukan — buat dulu di Master Data > Kategori Item`,
          },
        };
      }
      categoryId = found;
    }

    const existingId = await this.findExisting(client, 'items', 'sku', sku);
    const isSellable =
      row.values.is_sellable != null ? row.values.is_sellable === 'true' : undefined;
    const shelfLifeDays =
      row.values.shelf_life_days != null ? Number(row.values.shelf_life_days) : undefined;

    return {
      line: row.line,
      naturalKey: sku,
      existingId,
      apply: async (actorUserId) => {
        if (existingId) {
          const dto: UpdateItemDto = {
            sku,
            name: row.values.name!,
            categoryId,
            baseUnitId,
            storageType: row.values.storage_type as ItemStorageType,
            isSellable,
            shelfLifeDays,
            barcode: row.values.barcode ?? undefined,
          };
          await this.items.update(client, existingId, dto, actorUserId);
          return 'updated';
        }
        const dto: CreateItemDto = {
          sku,
          name: row.values.name!,
          categoryId,
          baseUnitId,
          storageType: row.values.storage_type as ItemStorageType,
          isSellable,
          shelfLifeDays,
          barcode: row.values.barcode ?? undefined,
        };
        await this.items.create(client, dto, actorUserId);
        return 'created';
      },
    };
  }

  /**
   * A menu product row. The sheet names its category ("Ayam"); this resolves it
   * to the `product_categories` id `CreateProductDto` wants (migration 247).
   *
   * A missing category FAILS THE ROW with its line and column rather than
   * creating the category on the fly: `product_categories` drives the till's
   * chip row and its ordering, so a typo in a spreadsheet must not silently
   * add a fifth spelling of "Minuman" to the cashier's screen. Create it in
   * Master Data first, deliberately.
   */
  private async planProduct(
    client: PoolClient,
    row: ValidatedRow,
    write?: { user: JwtAccessPayload; locationScope: string[] | null },
  ): Promise<RowPlan> {
    const code = row.values.code!;
    const categoryName = row.values.category!;
    const categoryId = await this.findExisting(client, 'product_categories', 'name', categoryName);
    if (!categoryId) {
      return {
        line: row.line,
        naturalKey: code,
        error: {
          column: 'category',
          message: `Kategori menu "${categoryName}" tidak ditemukan — buat dulu di Master Data > Kategori Menu POS`,
        },
      };
    }

    const existingId = await this.findExisting(client, 'products', 'code', code);
    const sortOrder = row.values.sort_order != null ? Number(row.values.sort_order) : undefined;
    // `ProductService.create`/`update` need a `user`/`locationScope` pair only
    // to resolve `photoUrl` (never set from an import row) — `preview` never
    // calls them at all, so it never needs to supply one.
    const actingUser = write?.user;
    const locationScope = write?.locationScope ?? null;

    return {
      line: row.line,
      naturalKey: code,
      existingId,
      apply: async (actorUserId) => {
        if (!actingUser) throw new Error('planProduct.apply called without a caller identity');
        if (existingId) {
          const dto: UpdateProductDto = {
            code,
            name: row.values.name!,
            categoryId,
            price: row.values.price!,
            sortOrder,
          };
          await this.products.update(
            client,
            existingId,
            dto,
            actorUserId,
            actingUser,
            locationScope,
          );
          return 'updated';
        }
        const dto: CreateProductDto = {
          code,
          name: row.values.name!,
          categoryId,
          price: row.values.price!,
          sortOrder,
        };
        await this.products.create(client, dto, actorUserId, actingUser, locationScope);
        return 'created';
      },
    };
  }

  /**
   * A chart-of-accounts row. `code` is the natural key; `type`/`normal_balance`/
   * `parent_code`/`is_postable` are all CREATE-ONLY in the real domain service —
   * `ChartOfAccountsService.update`'s own `UpdateAccountDto` carries only
   * `name`/`isActive` (accounting.dto.ts), so those four fields cannot be
   * changed via this route any more than they can via `PATCH
   * /api/accounting/coa/:id`. A row that tries to change one of them on an
   * EXISTING account FAILS the row naming the column, rather than silently
   * keeping the old value — the same "never silently drop what the sheet
   * explicitly said" rule `planProduct`'s missing-category failure follows.
   */
  private async planChartOfAccount(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const code = row.values.code!;
    const name = row.values.name!;
    const type = row.values.type! as AccountType;
    const normalBalance = row.values.normal_balance! as 'debit' | 'credit';
    const isPostable =
      row.values.is_postable != null ? row.values.is_postable === 'true' : undefined;

    let parentId: string | undefined;
    if (row.values.parent_code) {
      const found = await this.findExisting(
        client,
        'chart_of_accounts',
        'code',
        row.values.parent_code,
      );
      if (!found) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'parent_code',
            message: `Akun induk "${row.values.parent_code}" tidak ditemukan — buat dulu akun induknya, atau urutkan baris induk lebih dulu di berkas ini`,
          },
        };
      }
      parentId = found;
    }

    const existing = await this.chartOfAccounts.findByCode(client, code);
    if (existing) {
      if (existing.type !== type) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'type',
            message: `Akun "${code}" sudah ada dengan type "${existing.type}" — type tidak dapat diubah lagi setelah akun dibuat`,
          },
        };
      }
      if (existing.normal_balance !== normalBalance) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'normal_balance',
            message: `Akun "${code}" sudah ada dengan normal_balance "${existing.normal_balance}" — tidak dapat diubah lagi setelah akun dibuat`,
          },
        };
      }
      if ((parentId ?? null) !== existing.parent_id) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'parent_code',
            message: `Akun induk untuk "${code}" tidak dapat diubah lagi setelah akun dibuat`,
          },
        };
      }
      if (isPostable !== undefined && isPostable !== existing.is_postable) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'is_postable',
            message: `"is_postable" untuk akun "${code}" tidak dapat diubah lagi setelah akun dibuat`,
          },
        };
      }
    }

    return {
      line: row.line,
      naturalKey: code,
      existingId: existing?.id ?? null,
      apply: async () => {
        if (existing) {
          const dto: UpdateAccountDto = { name };
          await this.chartOfAccounts.update(client, existing.id, dto);
          return 'updated';
        }
        const dto: CreateAccountDto = { code, name, type, normalBalance, parentId, isPostable };
        await this.chartOfAccounts.create(client, dto);
        return 'created';
      },
    };
  }

  /**
   * An employee roster row. `employee_number` is the natural key. Deliberately
   * NOT on the sheet: `userId` (links the row to a LOGIN account — the one
   * genuinely credential-adjacent field `CreateEmployeeDto` has, excluded per
   * this ticket's brief) and the three bank-account columns (payroll
   * disbursement details — safer typed once per employee on the real screen
   * than copy-pasted through a spreadsheet column). `employmentStatus` is also
   * left off: a bulk import is the wrong place to (accidentally) terminate
   * someone.
   *
   * `position`/`location`/`base_salary` double as both the employee's current
   * profile AND `employments` (position/salary HISTORY, CONTRACTS §1.7) — on
   * an existing employee, `EmployeesService.update` only appends a new
   * `employments` row when the caller sends `employmentChange`, so this only
   * sends one when position/location/salary actually DIFFER from the
   * employee's current open employment row. Re-committing the same file twice
   * must not append a second identical history row each time.
   */
  private async planEmployee(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const employeeNumber = row.values.employee_number!;
    const locationCode = row.values.location!;
    const locationId = await this.findExisting(client, 'locations', 'code', locationCode);
    if (!locationId) {
      return {
        line: row.line,
        naturalKey: employeeNumber,
        error: { column: 'location', message: `Lokasi "${locationCode}" tidak ditemukan` },
      };
    }

    const existingRes = await client.query<{
      id: string;
      position: string;
      location_id: string;
      base_salary: string | null;
    }>(
      `SELECT e.id, e.position, e.location_id, em.base_salary::text AS base_salary
         FROM employees e
         LEFT JOIN employments em ON em.employee_id = e.id AND em.end_date IS NULL
        WHERE lower(e.employee_number) = lower($1)`,
      [employeeNumber],
    );
    const existing = existingRes.rows[0];

    const name = row.values.name!;
    const position = row.values.position!;
    const baseSalary = row.values.base_salary!;
    const joinDate = row.values.join_date!;
    const nik = row.values.nik ?? undefined;
    const phone = row.values.phone ?? undefined;
    const email = row.values.email ?? undefined;

    return {
      line: row.line,
      naturalKey: employeeNumber,
      existingId: existing?.id ?? null,
      apply: async (actorUserId) => {
        if (existing) {
          const changed =
            existing.position !== position ||
            existing.location_id !== locationId ||
            Number(existing.base_salary ?? 0) !== Number(baseSalary);
          const dto: UpdateEmployeeDto = {
            name,
            nik,
            phone,
            email,
            ...(changed
              ? {
                  employmentChange: {
                    position,
                    locationId,
                    baseSalary,
                    // No effective-date column on the sheet — recorded as effective TODAY,
                    // the same "date of the action" convention `PUT .../roster` already uses.
                    startDate: new Date().toISOString().slice(0, 10),
                  },
                }
              : {}),
          };
          await this.employees.update(client, actorUserId, existing.id, dto);
          return 'updated';
        }
        const dto: CreateEmployeeDto = {
          employeeNumber,
          name,
          nik,
          phone,
          email,
          joinDate,
          position,
          locationId,
          baseSalary,
        };
        await this.employees.create(client, actorUserId, dto);
        return 'created';
      },
    };
  }

  /**
   * A shift-template row (`work_shifts` — the roster's reusable "Pagi"/"Sore"/
   * "Malam" definitions, not `shift_assignments`). `name` is the display
   * natural key, but `location` is PART OF THE ROW'S IDENTITY too — two
   * different outlets are allowed a shift both named "Pagi" (`import-schema.ts`'s
   * `dedupeColumns` on this entity handles the intra-file half of that; this
   * lookup handles the against-the-database half, matching `(name, location)`
   * with `IS NOT DISTINCT FROM` so a blank `location` column correctly means
   * "the GLOBAL Pagi shift", not "any Pagi shift". Because `location`
   * resolves the row's identity rather than being a bystander attribute (contrast
   * `planEmployee`'s `nik`/`phone`, which restrictively transitions to `undefined`
   * when blank), it is always WRITTEN as resolved, not skipped when blank.
   */
  private async planWorkShift(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const name = row.values.name!;
    let locationId: string | null = null;
    if (row.values.location) {
      const found = await this.findExisting(client, 'locations', 'code', row.values.location);
      if (!found) {
        return {
          line: row.line,
          naturalKey: name,
          error: { column: 'location', message: `Lokasi "${row.values.location}" tidak ditemukan` },
        };
      }
      locationId = found;
    }

    const existingRes = await client.query<{ id: string }>(
      `SELECT id FROM work_shifts WHERE lower(name) = lower($1) AND location_id IS NOT DISTINCT FROM $2`,
      [name, locationId],
    );
    const existingId = existingRes.rows[0]?.id ?? null;

    const startTime = row.values.start_time!;
    const endTime = row.values.end_time!;
    const breakMinutes =
      row.values.break_minutes != null ? Number(row.values.break_minutes) : undefined;

    return {
      line: row.line,
      naturalKey: name,
      existingId,
      apply: async (actorUserId) => {
        if (existingId) {
          const dto: UpdateShiftDto = { locationId, name, startTime, endTime, breakMinutes };
          await this.shifts.updateShift(client, actorUserId, existingId, dto);
          return 'updated';
        }
        const dto: CreateShiftDto = {
          locationId: locationId ?? undefined,
          name,
          startTime,
          endTime,
          breakMinutes,
        };
        await this.shifts.createShift(client, actorUserId, dto);
        return 'created';
      },
    };
  }

  /**
   * An asset-register row. `asset_number` is the natural key — always
   * required here even though `CreateAssetDto.assetNumber` is optional
   * (auto-generated when omitted): a bulk import needs a deterministic
   * natural key to decide create-vs-update, so letting the server mint one
   * would turn every re-commit of the same file into a fresh duplicate row.
   *
   * `condition`/`status` are deliberately NOT on the sheet — those are
   * lifecycle/operational transitions (retiring an asset emits a DIFFERENT
   * sync op, `assets.retired`, only when `UpdateAssetDto.status` transitions
   * TO `'retired'` — see `AssetsService.update`), closer to the transactional
   * things this ticket's brief rules out than to master data. A brand-new
   * asset gets the DB default `condition='good'`/`status='active'`;
   * lifecycle changes stay on the real Aset screen.
   *
   * `assigned_to` resolves against `employees.employee_number` — leaving it
   * blank on an UPDATE row does NOT clear an existing PIC assignment
   * (`UpdateAssetDto.assignedToEmployeeId` has no way to express "clear" —
   * it is `string | undefined`, never `null` — a pre-existing limitation of
   * that DTO, not something this importer works around).
   */
  private async planAsset(
    client: PoolClient,
    row: ValidatedRow,
    write?: { user: JwtAccessPayload; locationScope: string[] | null },
  ): Promise<RowPlan> {
    const assetNumber = row.values.asset_number!;
    const locationCode = row.values.location!;
    const locationId = await this.findExisting(client, 'locations', 'code', locationCode);
    if (!locationId) {
      return {
        line: row.line,
        naturalKey: assetNumber,
        error: { column: 'location', message: `Lokasi "${locationCode}" tidak ditemukan` },
      };
    }

    let assignedTo: string | undefined;
    if (row.values.assigned_to) {
      const found = await this.findExisting(
        client,
        'employees',
        'employee_number',
        row.values.assigned_to,
      );
      if (!found) {
        return {
          line: row.line,
          naturalKey: assetNumber,
          error: {
            column: 'assigned_to',
            message: `Karyawan dengan kode "${row.values.assigned_to}" tidak ditemukan`,
          },
        };
      }
      assignedTo = found;
    }

    const existingId = await this.findExisting(client, 'assets', 'asset_number', assetNumber);

    const name = row.values.name!;
    const category = row.values.category! as AssetCategory;
    const serialNumber = row.values.serial_number ?? undefined;
    const brand = row.values.brand ?? undefined;
    const model = row.values.model ?? undefined;
    const purchaseDate = row.values.purchase_date ?? undefined;
    const purchasePrice = row.values.purchase_price ?? undefined;

    return {
      line: row.line,
      naturalKey: assetNumber,
      existingId,
      apply: async (actorUserId) => {
        if (!write?.user) throw new Error('planAsset.apply called without a caller identity');
        if (existingId) {
          const dto: UpdateAssetDto = {
            name,
            category,
            locationId,
            serialNumber,
            brand,
            model,
            purchaseDate,
            purchasePrice,
            assignedToEmployeeId: assignedTo,
          };
          await this.assets.update(
            client,
            actorUserId,
            existingId,
            dto,
            write.user,
            write.locationScope,
          );
          return 'updated';
        }
        const dto: CreateAssetDto = {
          assetNumber,
          name,
          category,
          locationId,
          serialNumber,
          brand,
          model,
          purchaseDate,
          purchasePrice,
          assignedToEmployeeId: assignedTo,
        };
        await this.assets.create(client, actorUserId, dto, write.user, write.locationScope);
        return 'created';
      },
    };
  }

  /**
   * A salary-component row. `code` is the natural key. `type`/`calc_method`
   * are CREATE-ONLY (`UpdateComponentDto` has neither field — payroll.dto.ts)
   * — a row that tries to change either on an existing component FAILS
   * naming the column, same immutability rule `planChartOfAccount` follows.
   * The 16 seeded SYSTEM components additionally cannot have `name` changed
   * at all (`ComponentsService.update` throws `ForbiddenException` if
   * `dto.name !== undefined` on a system row, REGARDLESS of whether the value
   * actually changed) — this plan reads `is_system` up front and only ever
   * includes `name` in the update DTO when the row is not system, so a
   * re-import of an unchanged system row's own name never trips that guard.
   */
  private async planSalaryComponent(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const code = row.values.code!;
    const name = row.values.name!;
    const type = row.values.type! as 'earning' | 'deduction';
    const calcMethod = row.values.calc_method! as
      'fixed' | 'per_day' | 'per_hour' | 'formula' | 'manual';
    const defaultAmount = row.values.default_amount ?? undefined;

    const existingRes = await client.query<{
      id: string;
      is_system: boolean;
      type: string;
      calc_method: string;
      name: string;
    }>(
      `SELECT id, is_system, type, calc_method, name FROM salary_components WHERE lower(code) = lower($1)`,
      [code],
    );
    const existing = existingRes.rows[0];

    if (existing) {
      if (existing.type !== type) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'type',
            message: `Komponen "${code}" sudah ada dengan type "${existing.type}" — tidak dapat diubah lagi setelah komponen dibuat`,
          },
        };
      }
      if (existing.calc_method !== calcMethod) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'calc_method',
            message: `Komponen "${code}" sudah ada dengan calc_method "${existing.calc_method}" — tidak dapat diubah lagi setelah komponen dibuat`,
          },
        };
      }
      if (existing.is_system && existing.name !== name) {
        return {
          line: row.line,
          naturalKey: code,
          error: {
            column: 'name',
            message: `Komponen "${code}" adalah komponen bawaan sistem — namanya tidak dapat diubah`,
          },
        };
      }
    }

    return {
      line: row.line,
      naturalKey: code,
      existingId: existing?.id ?? null,
      apply: async () => {
        if (existing) {
          const dto: UpdateComponentDto = {
            defaultAmount,
            ...(existing.is_system ? {} : { name }),
          };
          await this.salaryComponents.update(client, existing.id, dto);
          return 'updated';
        }
        const dto: CreateComponentDto = { code, name, type, calcMethod, defaultAmount };
        await this.salaryComponents.create(client, dto);
        return 'created';
      },
    };
  }

  /**
   * `suppliers` — the supplier RECORD (contact, terms, bank), upserted on
   * `code`. Prices are not here: a supplier's per-item price lives in
   * `supplier_items` with an append-only history row per change (FR-SUP-04),
   * a different natural key and a different sheet.
   *
   * Every optional column is passed as `null` when the cell is BLANK on an
   * update, not omitted. That is the difference between "clear the phone
   * number" and "leave it alone", and on a round trip — export, edit in Excel,
   * import back — a cleared cell means the operator cleared it. `code` and
   * `name` are required by the schema so they can never arrive blank.
   */
  private async planSupplier(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const code = row.values.code!;
    const name = row.values.name!;

    // `?? null` (not `?? undefined`): see the doc comment — blank means clear.
    const optional = {
      contactName: row.values.contact_name ?? null,
      phone: row.values.phone ?? null,
      email: row.values.email ?? null,
      address: row.values.address ?? null,
      paymentTermsDays:
        row.values.payment_terms_days != null ? Number(row.values.payment_terms_days) : null,
      bankName: row.values.bank_name ?? null,
      bankAccount: row.values.bank_account ?? null,
      bankAccountName: row.values.bank_account_name ?? null,
    };
    // A tri-state, unlike the rest: absent leaves the flag alone, and on a
    // CREATE it must fall back to the safe default rather than to `null` —
    // D-20 makes this the flag that exposes a supplier to outlet roles.
    const outletVisible =
      row.values.outlet_visible != null ? row.values.outlet_visible === 'true' : undefined;

    const existingId = await this.findExisting(client, 'suppliers', 'code', code);

    return {
      line: row.line,
      naturalKey: code,
      existingId,
      apply: async (actorUserId) => {
        if (existingId) {
          const dto: UpdateSupplierDto = {
            name,
            ...optional,
            ...(outletVisible !== undefined ? { outletVisible } : {}),
          };
          await this.suppliers.update(client, existingId, dto, actorUserId);
          return 'updated';
        }
        const dto: CreateSupplierDto = {
          code,
          name,
          ...optional,
          outletVisible: outletVisible ?? false,
        };
        await this.suppliers.create(client, dto, actorUserId);
        return 'created';
      },
    };
  }

  /**
   * `employment_contracts` row (W7's CRUD/import/export follow-up). See
   * `import-schema.ts`'s doc comment on this entity for the full reasoning —
   * summarized here: `contract_number` only ever SELECTS a row to update; a
   * genuinely new contract always gets the real system-generated number from
   * `ContractsService.create` (never the sheet's value, which — for a create
   * row — is either blank or a number that does not exist yet and is
   * discarded), and there is NO status/signature column at all — every
   * imported contract lands as `draft` and can only ever be activated through
   * `POST /hr/contracts/:id/sign` + an explicit status update on the real
   * screen, exactly like a hand-typed one.
   */
  private async planContract(client: PoolClient, row: ValidatedRow): Promise<RowPlan> {
    const contractNumber = row.values.contract_number!;
    const employeeNumber = row.values.employee!;
    const employeeRes = await client.query<{ id: string }>(
      `SELECT id FROM employees WHERE lower(employee_number) = lower($1)`,
      [employeeNumber],
    );
    if (!employeeRes.rows[0]) {
      return {
        line: row.line,
        naturalKey: contractNumber,
        error: { column: 'employee', message: `Karyawan "${employeeNumber}" tidak ditemukan` },
      };
    }
    const employeeId = employeeRes.rows[0].id;

    let locationId: string | undefined;
    if (row.values.location) {
      const found = await this.findExisting(client, 'locations', 'code', row.values.location);
      if (!found) {
        return {
          line: row.line,
          naturalKey: contractNumber,
          error: { column: 'location', message: `Lokasi "${row.values.location}" tidak ditemukan` },
        };
      }
      locationId = found;
    }

    const contractType = row.values.contract_type as CreateContractDto['contractType'];
    const endDate = row.values.end_date ?? undefined;
    // Same rule `ContractsService.assertTermMatchesType` and migration 230's
    // CHECK both enforce — checked here too so a bad row fails with a LINE
    // NUMBER in the preview instead of an opaque constraint-violation from
    // the eventual INSERT/UPDATE.
    if (contractType === 'pkwtt' && endDate) {
      return {
        line: row.line,
        naturalKey: contractNumber,
        error: {
          column: 'end_date',
          message: 'Kontrak pkwtt (permanen) tidak boleh punya tanggal berakhir',
        },
      };
    }
    if (contractType !== 'pkwtt' && !endDate) {
      return {
        line: row.line,
        naturalKey: contractNumber,
        error: {
          column: 'end_date',
          message: `Kontrak ${contractType} wajib punya tanggal berakhir`,
        },
      };
    }

    const existingId = await this.findExisting(
      client,
      'employment_contracts',
      'contract_number',
      contractNumber,
    );

    const position = row.values.position!;
    const startDate = row.values.start_date!;
    const baseSalary = row.values.base_salary ?? undefined;
    const signedAt = row.values.signed_at ?? undefined;
    const notes = row.values.notes ?? undefined;

    return {
      line: row.line,
      naturalKey: contractNumber,
      existingId,
      apply: async (actorUserId) => {
        if (existingId) {
          const dto: UpdateContractDto = {
            contractType,
            position,
            locationId,
            baseSalary,
            startDate,
            endDate: endDate ?? null,
            signedAt,
            notes,
          };
          await this.contracts.update(client, existingId, dto);
          return 'updated';
        }
        const dto: CreateContractDto = {
          employeeId,
          contractType,
          position,
          locationId,
          baseSalary,
          startDate,
          endDate,
          signedAt,
          notes,
        };
        await this.contracts.create(client, actorUserId, dto);
        return 'created';
      },
    };
  }
}
