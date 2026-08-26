import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_CONFLICT, ERR_NOT_FOUND, SyncEntity, type ProductCategory } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import { CreateProductCategoryDto, UpdateProductCategoryDto } from './dto/product-category.dto';

interface ProductCategoryRow {
  id: string;
  name: string;
  sort_order: number;
  is_active: boolean;
  product_count: string;
}

/**
 * POS menu categories (`product_categories`, migration 247) — CONTRACTS.md §4.5.
 * No RLS (§1.14 NONE), gated by `product.read`/`product.manage` at the API.
 *
 * This replaced a `SELECT DISTINCT products.category` over a free-text column,
 * so the shapes here are exactly the things that column could not do:
 * `sortOrder` (the till's category chip row was stuck alphabetical because
 * alphabetical was the only order available), `isActive` (a seasonal category
 * could not be retired without deleting the products under it), and rename
 * (`products.category` held a copy per row, so a rename meant re-editing every
 * product and a typo meant a fifth spelling of "Minuman" on the till).
 */
@Injectable()
export class ProductCategoryService {
  constructor(private readonly sync: SyncEmitService) {}

  private readonly baseSelect = `
    SELECT pc.id, pc.name, pc.sort_order, pc.is_active,
           (SELECT COUNT(*) FROM products p WHERE p.category_id = pc.id) AS product_count
      FROM product_categories pc`;

  private map(row: ProductCategoryRow): ProductCategory {
    return {
      id: row.id,
      name: row.name,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      productCount: Number(row.product_count),
    };
  }

  /**
   * `includeInactive` is for the back office only. The till and every product
   * form want the active list; an Owner editing master data needs to see a
   * retired category to rename or reactivate it.
   */
  async list(client: PoolClient, includeInactive = false): Promise<ProductCategory[]> {
    const res = await client.query<ProductCategoryRow>(
      `${this.baseSelect}
        ${includeInactive ? '' : 'WHERE pc.is_active = true'}
        ORDER BY pc.sort_order ASC, pc.name ASC`,
    );
    return res.rows.map((r) => this.map(r));
  }

  private async getRawById(client: PoolClient, id: string): Promise<ProductCategoryRow> {
    const res = await client.query<ProductCategoryRow>(`${this.baseSelect} WHERE pc.id = $1`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Product category not found' });
    return res.rows[0];
  }

  /**
   * Name uniqueness is checked case-INSENSITIVELY here even though the column's
   * own UNIQUE index is case-sensitive: "minuman" and "Minuman" are the same
   * category to everyone who reads the till, and letting both exist recreates
   * the duplicate-spelling problem this table was built to end.
   */
  private async assertNameFree(client: PoolClient, name: string, exceptId?: string): Promise<void> {
    const res = await client.query(
      `SELECT 1 FROM product_categories
        WHERE lower(name) = lower($1) AND ($2::uuid IS NULL OR id <> $2)`,
      [name, exceptId ?? null],
    );
    if (res.rowCount && res.rowCount > 0) {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Menu category "${name}" already exists`,
      });
    }
  }

  async create(
    client: PoolClient,
    dto: CreateProductCategoryDto,
    actorUserId: string,
  ): Promise<ProductCategory> {
    return withWrite(client, async () => {
      await this.assertNameFree(client, dto.name);

      const res = await client.query<{ id: string }>(
        `INSERT INTO product_categories (name, sort_order) VALUES ($1, COALESCE($2,0)) RETURNING id`,
        [dto.name, dto.sortOrder ?? null],
      );
      const category = this.map(await this.getRawById(client, res.rows[0]!.id));
      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCT_CATEGORIES,
        op: 'created',
        entityId: category.id,
        locationId: null,
        actorUserId,
        data: category,
      });
      return category;
    });
  }

  async update(
    client: PoolClient,
    id: string,
    dto: UpdateProductCategoryDto,
    actorUserId: string,
  ): Promise<ProductCategory> {
    return withWrite(client, async () => {
      const before = await this.getRawById(client, id);

      if (dto.name !== undefined && dto.name.toLowerCase() !== before.name.toLowerCase()) {
        await this.assertNameFree(client, dto.name, id);
      }

      if (dto.isActive === false) {
        this.assertNoProductsAttached(before, 'deactivate');
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.sortOrder !== undefined) set('sort_order', dto.sortOrder);
      if (dto.isActive !== undefined) set('is_active', dto.isActive);

      if (sets.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE product_categories SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
      }

      const category = this.map(await this.getRawById(client, id));
      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCT_CATEGORIES,
        op: 'updated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: category,
      });
      return category;
    });
  }

  /**
   * Applies an explicit order to the whole list (`PUT .../categories/order`).
   *
   * `sort_order` is rewritten as position × 10 rather than 0,1,2 so a later
   * single-row nudge can be slotted between two neighbours without rewriting
   * the list again — the same spacing migration 247's backfill seeds.
   *
   * Ids not in the payload keep their current `sort_order`, which is what makes
   * this safe to call with just the visible page of a filtered list.
   */
  async reorder(
    client: PoolClient,
    ids: readonly string[],
    actorUserId: string,
  ): Promise<ProductCategory[]> {
    return withWrite(client, async () => {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM product_categories WHERE id = ANY($1::uuid[])`,
        [ids],
      );
      const foundIds = new Set(found.rows.map((r) => r.id));
      const missing = ids.filter((id) => !foundIds.has(id));
      if (missing.length > 0) {
        throw new NotFoundException({
          code: ERR_NOT_FOUND,
          message: `Product category not found: ${missing.join(', ')}`,
        });
      }

      for (const [index, id] of ids.entries()) {
        await client.query(`UPDATE product_categories SET sort_order = $1 WHERE id = $2`, [
          index * 10,
          id,
        ]);
      }

      // One event per row: `PRODUCT_CATEGORIES` is a per-entity pull entity in
      // the authority matrix, so a device reconciles rows, not lists.
      const categories = await this.list(client, true);
      for (const id of ids) {
        const category = categories.find((c) => c.id === id);
        if (!category) continue;
        await this.sync.emit(client, {
          entity: SyncEntity.PRODUCT_CATEGORIES,
          op: 'updated',
          entityId: id,
          locationId: null,
          actorUserId,
          data: category,
        });
      }
      return categories.filter((c) => c.isActive);
    });
  }

  /**
   * Soft delete, matching every other master-data surface (`is_active = false`,
   * never a row removal — a past sale's product must keep resolving its
   * category name for reporting).
   */
  async deactivate(
    client: PoolClient,
    id: string,
    actorUserId: string,
  ): Promise<{ id: string; deactivated: true }> {
    return withWrite(client, async () => {
      const before = await this.getRawById(client, id);
      this.assertNoProductsAttached(before, 'delete');

      await client.query(`UPDATE product_categories SET is_active = false WHERE id = $1`, [id]);
      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCT_CATEGORIES,
        op: 'deactivated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: { id, deactivated: true },
      });
      return { id, deactivated: true };
    });
  }

  /**
   * Retiring a category that still has products under it would leave those
   * products pointing at something the till's chip row no longer offers — they
   * would stay sellable but unreachable by category filter, which reads as
   * "my products disappeared". Refuse and say how many are in the way; moving
   * them is the caller's decision, not something to do silently for them.
   *
   * The count deliberately includes INACTIVE products: a deactivated seasonal
   * product still has to have somewhere to come back to.
   */
  private assertNoProductsAttached(row: ProductCategoryRow, verb: string): void {
    if (Number(row.product_count) === 0) return;
    throw new BadRequestException({
      code: 'ERR_VALIDATION',
      message: `Cannot ${verb} "${row.name}" — ${row.product_count} product(s) still use it. Move them to another category first.`,
    });
  }
}
