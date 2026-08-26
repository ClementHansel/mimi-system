import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_NOT_FOUND,
  SyncEntity,
  compareMoney,
  type Paginated,
  type Product,
  type ProductKind,
  type ProductPackageLine,
} from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { EventBus } from '../../kernel/events/event-bus.service';
import { StorageService } from '../../kernel/storage/storage.service';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { PackageService } from './package.service';
import { withWrite } from './db-tx';
import { CreateProductDto, ListProductsQueryDto, UpdateProductDto } from './dto/product.dto';

export interface ProductRow {
  id: string;
  code: string;
  name: string;
  category: string;
  category_id: string;
  price: string;
  photo_attachment_id: string | null;
  sort_order: number;
  is_active: boolean;
  kind: ProductKind;
  has_recipe: boolean;
}

/** Re-exported from `@mimi/shared` so call sites keep importing `Product` from this module. */
export type { Product } from '@mimi/shared';

/**
 * M05 `product` — menu products (CONTRACTS.md §4.5). A `price` change emits
 * `product.price_changed` on the in-process `EventBus` (kernel/events) in
 * addition to the usual `products` sync event — `domain-events.ts`'s own
 * comment names this module as the emitter, consumed by future
 * reporting/accounting surfaces without importing this module directly.
 *
 * No RLS on `products` (§1.14 NONE) — every query still runs on the
 * request's own `PoolClient` (see `request-db-client.ts`) because `mimi_app`
 * itself holds no table grants at all.
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly sync: SyncEmitService,
    private readonly eventBus: EventBus,
    private readonly storage: StorageService,
    private readonly packages: PackageService,
  ) {}

  /**
   * `category` is the JOINED name, not a column on `products` any more
   * (migration 247 moved it to `product_categories` and dropped the free-text
   * copy) — the wire field keeps its name and type so the precached POS
   * catalog, the sync payload and `@mimi/shared`'s `Product` are unchanged,
   * while a rename now lands in exactly one row.
   */
  private readonly baseSelect = `
    SELECT p.id, p.code, p.name, pc.name AS category, p.category_id, p.price,
           p.photo_attachment_id, p.sort_order, p.is_active, p.kind,
           EXISTS (SELECT 1 FROM recipes r WHERE r.product_id = p.id AND r.is_active = true) AS has_recipe
    FROM products p
    JOIN product_categories pc ON pc.id = p.category_id`;

  /**
   * D-21/D-22: `StorageService.getUrl()` needs a role-switched `PoolClient`
   * (`mimi_app` holds no table grants of its own) — this module's own
   * request-scoped `client` (already `SET LOCAL ROLE app_user` by
   * `RlsContextGuard`) covers it, so this stays a local, no-extra-round-trip
   * presign rather than needing its own connection.
   */
  private async resolvePhotoUrl(
    client: PoolClient,
    user: JwtAccessPayload,
    locationScope: string[] | null,
    attachmentId: string | null,
  ): Promise<string | null> {
    if (!attachmentId) return null;
    try {
      const { url } = await this.storage.getUrl(client, user, locationScope, attachmentId);
      return url;
    } catch {
      return null; // Attachment missing/inaccessible — degrade to no photo rather than fail the whole response.
    }
  }

  private async map(
    client: PoolClient,
    row: ProductRow,
    user: JwtAccessPayload,
    locationScope: string[] | null,
    packageLines?: ProductPackageLine[],
  ): Promise<Product> {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      category: row.category,
      categoryId: row.category_id,
      price: row.price,
      photoUrl: await this.resolvePhotoUrl(client, user, locationScope, row.photo_attachment_id),
      // The stable, non-expiring address for the same image (see the field's
      // doc). Both are sent on this surface: a back-office form renders the
      // presigned url directly, while anything that CACHES a product — the
      // till, an offline device — must use the path or its image breaks the
      // moment the signature ages out.
      photoPath: row.photo_attachment_id ? `/products/${row.id}/photo` : null,
      sortOrder: row.sort_order,
      isActive: row.is_active,
      kind: row.kind,
      hasRecipe: row.has_recipe,
      // Omitted entirely for a plain product rather than sent as `[]` — same
      // convention `recipeLines` uses, so "is this a bundle" is one check.
      ...(row.kind === 'package' ? { packageLines: packageLines ?? [] } : {}),
    };
  }

  /**
   * Loads membership for whichever of `rows` are packages, in ONE query, then
   * maps every row. A menu is mostly plain products, so the extra query is
   * skipped entirely when no package is present on the page.
   */
  private async mapMany(
    client: PoolClient,
    rows: ProductRow[],
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<Product[]> {
    const packageIds = rows.filter((r) => r.kind === 'package').map((r) => r.id);
    const linesByPackage = await this.packages.getLinesForMany(client, packageIds);
    return Promise.all(
      rows.map((r) => this.map(client, r, user, locationScope, linesByPackage.get(r.id))),
    );
  }

  async list(
    client: PoolClient,
    query: ListProductsQueryDto,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<Paginated<Product>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(`(p.name ILIKE $${params.length} OR p.code ILIKE $${params.length})`);
    }
    if (query.categoryId) {
      params.push(query.categoryId);
      where.push(`p.category_id = $${params.length}`);
    }
    if (query.kind) {
      params.push(query.kind);
      where.push(`p.kind = $${params.length}`);
    }
    if (query.active !== undefined) {
      params.push(query.active);
      where.push(`p.is_active = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM products p ${whereSql}`,
      params,
    );
    const total = parseInt(countRes.rows[0]!.count, 10);

    params.push(pageSize, (page - 1) * pageSize);
    const rowsRes = await client.query<ProductRow>(
      `${this.baseSelect} ${whereSql} ORDER BY p.sort_order ASC, p.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const rows = await this.mapMany(client, rowsRes.rows, user, locationScope);
    return { rows, total, page, pageSize };
  }

  private async getRawById(client: PoolClient, id: string): Promise<ProductRow> {
    const res = await client.query<ProductRow>(`${this.baseSelect} WHERE p.id = $1`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Product not found' });
    return res.rows[0];
  }

  async getById(
    client: PoolClient,
    id: string,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<Product> {
    const row = await this.getRawById(client, id);
    const packageLines =
      row.kind === 'package' ? await this.packages.getLines(client, row.id) : undefined;
    return this.map(client, row, user, locationScope, packageLines);
  }

  /**
   * Just the `photo_attachment_id`, for the thumbnail route — which needs the
   * id and nothing else, and must not pay for a presigned url it is about to
   * throw away (`map()` resolves one for every row).
   */
  async getPhotoAttachmentId(client: PoolClient, id: string): Promise<string | null> {
    const res = await client.query<{ photo_attachment_id: string | null }>(
      `SELECT photo_attachment_id FROM products WHERE id = $1`,
      [id],
    );
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Product not found' });
    return res.rows[0].photo_attachment_id;
  }

  async create(
    client: PoolClient,
    dto: CreateProductDto,
    actorUserId: string,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<Product> {
    return withWrite(client, async () => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO products (code, name, category_id, price, photo_attachment_id, sort_order)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6,0))
         RETURNING id`,
        [
          dto.code,
          dto.name,
          dto.categoryId,
          dto.price,
          dto.photoAttachmentId ?? null,
          dto.sortOrder ?? null,
        ],
      );
      const id = res.rows[0]!.id;
      const product = await this.getById(client, id, user, locationScope);
      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCTS,
        op: 'created',
        entityId: id,
        locationId: null,
        actorUserId,
        data: product,
      });
      return product;
    });
  }

  async update(
    client: PoolClient,
    id: string,
    dto: UpdateProductDto,
    actorUserId: string,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<Product> {
    return withWrite(client, async () => {
      const before = await this.getRawById(client, id);

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.code !== undefined) set('code', dto.code);
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.categoryId !== undefined) set('category_id', dto.categoryId);
      if (dto.price !== undefined) set('price', dto.price);
      if (dto.photoAttachmentId !== undefined) set('photo_attachment_id', dto.photoAttachmentId);
      if (dto.sortOrder !== undefined) set('sort_order', dto.sortOrder);
      // Takes a product off the POS menu, or puts it back. `products.is_active`
      // has existed since migration 012 with nothing able to change it — a
      // sold-out or seasonal line could not be hidden from the till at all.
      if (dto.isActive !== undefined) set('is_active', dto.isActive);

      if (sets.length > 0) {
        params.push(id);
        await client.query(
          `UPDATE products SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
      }

      const product = await this.getById(client, id, user, locationScope);
      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCTS,
        op: 'updated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: product,
      });

      if (dto.price !== undefined && compareMoney(dto.price, before.price) !== 0) {
        await this.eventBus.publish('product.price_changed', {
          productId: id,
          oldPrice: before.price,
          newPrice: product.price,
          changedBy: actorUserId,
          occurredAt: new Date().toISOString(),
        });
      }

      return product;
    });
  }

  async deactivate(
    client: PoolClient,
    id: string,
    actorUserId: string,
  ): Promise<{ id: string; deactivated: true }> {
    return withWrite(client, async () => {
      const res = await client.query(`UPDATE products SET is_active = false WHERE id = $1`, [id]);
      if (res.rowCount === 0)
        throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Product not found' });
      await this.sync.emit(client, {
        entity: SyncEntity.PRODUCTS,
        op: 'deactivated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: { id, deactivated: true },
      });
      return { id, deactivated: true };
    });
  }
}
