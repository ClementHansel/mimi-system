import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_NOT_FOUND,
  SyncEntity,
  type Money,
  type Paginated,
  type Temp,
  type UUID,
} from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import { CreateItemDto, ListItemsQueryDto, UpdateItemDto } from './dto/item.dto';

export interface ItemRow {
  id: string;
  sku: string;
  name: string;
  category_id: string | null;
  category_name: string | null;
  base_unit_id: string;
  base_unit_code: string;
  storage_type: string;
  is_sellable: boolean;
  shelf_life_days: number | null;
  temp_min: string | null;
  temp_max: string | null;
  avg_cost: string;
  last_purchase_cost: string;
  barcode: string | null;
  is_active: boolean;
}

export interface Item {
  id: UUID;
  sku: string;
  name: string;
  categoryId: UUID | null;
  categoryName: string | null;
  baseUnit: { id: UUID; code: string };
  storageType: 'frozen' | 'chilled' | 'dry';
  isSellable: boolean;
  shelfLifeDays: number | null;
  tempMin: Temp | null;
  tempMax: Temp | null;
  avgCost?: Money;
  lastPurchaseCost?: Money;
  barcode: string | null;
  isActive: boolean;
}

/**
 * M04 `item` — stockable items (bahan baku), CONTRACTS.md §4.4. `avgCost`/
 * `lastPurchaseCost` are column-level filtered by the caller's
 * `supplier.price.read` grant (FR-SUP-06/D-20) — `includeCost` is resolved by
 * the controller from `can(user.roleKey, 'supplier.price.read')`, never by
 * this service, so the permission check stays in exactly one place
 * (`PermissionsGuard`'s own RBAC matrix lookup).
 *
 * `items`/`item_categories` carry no RLS (§1.14 NONE) — every query still
 * runs on the request's own `PoolClient` (see `request-db-client.ts`)
 * because `mimi_app` itself holds no table grants at all.
 */
@Injectable()
export class ItemService {
  constructor(private readonly sync: SyncEmitService) {}

  private map(row: ItemRow, includeCost: boolean): Item {
    const item: Item = {
      id: row.id,
      sku: row.sku,
      name: row.name,
      categoryId: row.category_id,
      categoryName: row.category_name,
      baseUnit: { id: row.base_unit_id, code: row.base_unit_code },
      storageType: row.storage_type as 'frozen' | 'chilled' | 'dry',
      isSellable: row.is_sellable,
      shelfLifeDays: row.shelf_life_days,
      tempMin: row.temp_min,
      tempMax: row.temp_max,
      barcode: row.barcode,
      isActive: row.is_active,
    };
    if (includeCost) {
      item.avgCost = row.avg_cost;
      item.lastPurchaseCost = row.last_purchase_cost;
    }
    return item;
  }

  private readonly baseSelect = `
    SELECT i.id, i.sku, i.name, i.category_id, c.name AS category_name,
           i.base_unit_id, u.code AS base_unit_code, i.storage_type, i.is_sellable,
           i.shelf_life_days, i.temp_min, i.temp_max, i.avg_cost, i.last_purchase_cost,
           i.barcode, i.is_active
    FROM items i
    LEFT JOIN item_categories c ON c.id = i.category_id
    JOIN units u ON u.id = i.base_unit_id`;

  async list(
    client: PoolClient,
    query: ListItemsQueryDto,
    includeCost: boolean,
  ): Promise<Paginated<Item>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(`(i.name ILIKE $${params.length} OR i.sku ILIKE $${params.length})`);
    }
    if (query.categoryId) {
      params.push(query.categoryId);
      where.push(`i.category_id = $${params.length}`);
    }
    if (query.storageType) {
      params.push(query.storageType);
      where.push(`i.storage_type = $${params.length}`);
    }
    if (query.active !== undefined) {
      params.push(query.active);
      where.push(`i.is_active = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM items i ${whereSql}`,
      params,
    );
    const total = parseInt(countRes.rows[0]!.count, 10);

    params.push(pageSize, (page - 1) * pageSize);
    const rowsRes = await client.query<ItemRow>(
      `${this.baseSelect} ${whereSql} ORDER BY i.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: rowsRes.rows.map((r) => this.map(r, includeCost)), total, page, pageSize };
  }

  async getById(client: PoolClient, id: string, includeCost: boolean): Promise<Item> {
    const res = await client.query<ItemRow>(`${this.baseSelect} WHERE i.id = $1`, [id]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Item not found' });
    return this.map(res.rows[0], includeCost);
  }

  async create(client: PoolClient, dto: CreateItemDto, actorUserId: string): Promise<Item> {
    return withWrite(client, async () => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO items (sku, name, category_id, base_unit_id, storage_type, is_sellable, shelf_life_days, temp_min, temp_max, barcode)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6,false), $7,$8,$9,$10)
         RETURNING id`,
        [
          dto.sku,
          dto.name,
          dto.categoryId ?? null,
          dto.baseUnitId,
          dto.storageType,
          dto.isSellable ?? null,
          dto.shelfLifeDays ?? null,
          dto.tempMin ?? null,
          dto.tempMax ?? null,
          dto.barcode ?? null,
        ],
      );
      const id = res.rows[0]!.id;
      const item = await this.getById(client, id, true);
      await this.sync.emit(client, {
        entity: SyncEntity.ITEMS,
        op: 'created',
        entityId: id,
        locationId: null,
        actorUserId,
        data: item,
      });
      return item;
    });
  }

  async update(
    client: PoolClient,
    id: string,
    dto: UpdateItemDto,
    actorUserId: string,
  ): Promise<Item> {
    return withWrite(client, async () => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.sku !== undefined) set('sku', dto.sku);
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.categoryId !== undefined) set('category_id', dto.categoryId);
      if (dto.baseUnitId !== undefined) set('base_unit_id', dto.baseUnitId);
      if (dto.storageType !== undefined) set('storage_type', dto.storageType);
      if (dto.isSellable !== undefined) set('is_sellable', dto.isSellable);
      if (dto.shelfLifeDays !== undefined) set('shelf_life_days', dto.shelfLifeDays);
      if (dto.tempMin !== undefined) set('temp_min', dto.tempMin);
      if (dto.tempMax !== undefined) set('temp_max', dto.tempMax);
      if (dto.barcode !== undefined) set('barcode', dto.barcode);

      if (sets.length > 0) {
        params.push(id);
        const res = await client.query(
          `UPDATE items SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
        if (res.rowCount === 0)
          throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Item not found' });
      } else {
        await this.getById(client, id, true);
      }

      const item = await this.getById(client, id, true);
      await this.sync.emit(client, {
        entity: SyncEntity.ITEMS,
        op: 'updated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: item,
      });
      return item;
    });
  }

  async deactivate(
    client: PoolClient,
    id: string,
    actorUserId: string,
  ): Promise<{ id: string; deactivated: true }> {
    return withWrite(client, async () => {
      const res = await client.query(`UPDATE items SET is_active = false WHERE id = $1`, [id]);
      if (res.rowCount === 0)
        throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Item not found' });
      await this.sync.emit(client, {
        entity: SyncEntity.ITEMS,
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
