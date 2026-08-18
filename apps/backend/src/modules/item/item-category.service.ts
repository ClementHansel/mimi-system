import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_NOT_FOUND, SyncEntity, type UUID } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import { CreateItemCategoryDto, UpdateItemCategoryDto } from './dto/item.dto';

export interface ItemCategoryRow {
  id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface ItemCategory {
  id: UUID;
  name: string;
  parentId: UUID | null;
  sortOrder: number;
}

/**
 * Item categories (`item_categories`) — CONTRACTS.md §4.4. No RLS (§1.14
 * NONE), API-gated only. No DELETE endpoint in the contract — categories are
 * created/updated but never soft-deleted through this surface.
 */
@Injectable()
export class ItemCategoryService {
  constructor(private readonly sync: SyncEmitService) {}

  private map(row: ItemCategoryRow): ItemCategory {
    return { id: row.id, name: row.name, parentId: row.parent_id, sortOrder: row.sort_order };
  }

  async list(client: PoolClient): Promise<ItemCategory[]> {
    const res = await client.query<ItemCategoryRow>(
      `SELECT * FROM item_categories WHERE is_active = true ORDER BY sort_order ASC, name ASC`,
    );
    return res.rows.map((r) => this.map(r));
  }

  private async getRawById(client: PoolClient, id: string): Promise<ItemCategoryRow> {
    const res = await client.query<ItemCategoryRow>(`SELECT * FROM item_categories WHERE id = $1`, [
      id,
    ]);
    if (!res.rows[0])
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Item category not found' });
    return res.rows[0];
  }

  async create(
    client: PoolClient,
    dto: CreateItemCategoryDto,
    actorUserId: string,
  ): Promise<ItemCategory> {
    return withWrite(client, async () => {
      const res = await client.query<ItemCategoryRow>(
        `INSERT INTO item_categories (name, parent_id, sort_order) VALUES ($1,$2, COALESCE($3,0)) RETURNING *`,
        [dto.name, dto.parentId ?? null, dto.sortOrder ?? null],
      );
      const category = this.map(res.rows[0]!);
      await this.sync.emit(client, {
        entity: SyncEntity.ITEM_CATEGORIES,
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
    dto: UpdateItemCategoryDto,
    actorUserId: string,
  ): Promise<ItemCategory> {
    return withWrite(client, async () => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.parentId !== undefined) set('parent_id', dto.parentId);
      if (dto.sortOrder !== undefined) set('sort_order', dto.sortOrder);

      if (sets.length > 0) {
        params.push(id);
        const res = await client.query(
          `UPDATE item_categories SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
        if (res.rowCount === 0)
          throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Item category not found' });
      } else {
        await this.getRawById(client, id);
      }

      const category = this.map(await this.getRawById(client, id));
      await this.sync.emit(client, {
        entity: SyncEntity.ITEM_CATEGORIES,
        op: 'updated',
        entityId: id,
        locationId: null,
        actorUserId,
        data: category,
      });
      return category;
    });
  }
}
