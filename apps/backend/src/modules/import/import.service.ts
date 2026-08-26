import { BadRequestException, Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ItemStorageType } from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { ItemService } from '../item/item.service';
import { ItemCategoryService } from '../item/item-category.service';
import type { CreateItemDto, UpdateItemDto, CreateItemCategoryDto } from '../item/dto/item.dto';
import { ProductService } from '../product/product.service';
import type { CreateProductDto, UpdateProductDto } from '../product/dto/product.dto';
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
 * `import` — BFF bulk-import for the three master-data entities chosen for
 * value/risk (see `import.module.ts`'s header comment for why these three
 * and not `units`/`suppliers`/anything transactional).
 *
 * DELIBERATE DESIGN: every write in this service goes through the SAME
 * `ItemService`/`ItemCategoryService`/`ProductService` methods the regular
 * `/api/items`, `/api/items/categories`, `/api/products` endpoints already
 * call — never a parallel `INSERT`/`UPDATE`. That is what keeps a bulk-
 * imported row indistinguishable from a hand-typed one: same validation,
 * same sync-event payload shape (so an offline device pulling `items`/
 * `product_categories`/`products` sees no difference), same audit trail.
 * The only things this service owns are (1) resolving a sheet's human-
 * readable foreign keys (a category NAME, a unit CODE) to the ids those
 * services need, and (2) deciding create-vs-update from the natural key.
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
}
