import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_AREA_HAS_STOCK, ERR_NOT_FOUND, SyncEntity, type UUID } from '@mimi/shared';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import { CreateStorageAreaDto, UpdateStorageAreaDto } from './dto/storage-area.dto';

export interface StorageAreaRow {
  id: string;
  location_id: string;
  code: string;
  name: string;
  type: string;
  temp_min: string | null;
  temp_max: string | null;
  sort_order: number;
  is_active: boolean;
}

export interface StorageArea {
  id: UUID;
  locationId: UUID;
  code: string;
  name: string;
  type: string;
  tempMin: string | null;
  tempMax: string | null;
  sortOrder: number;
  isActive: boolean;
}

/**
 * Storage areas inside a location (D-15) — typed `freezer/chiller/dry_store/
 * display/kitchen_line`, each with a temperature range. Stock is keyed by
 * `(location_id, storage_area_id, item_id)`; this service owns the master
 * data that key depends on but never writes `stock_balances` itself (D-07 —
 * that is `StockLedgerService`'s job, M07/`kernel/stock-ledger`).
 *
 * RLS `LOC` (§1.14) — every query runs on the request's own `PoolClient`
 * (see `request-db-client.ts`), never a fresh unscoped connection.
 */
@Injectable()
export class StorageAreaService {
  constructor(private readonly sync: SyncEmitService) {}

  private map(row: StorageAreaRow): StorageArea {
    return {
      id: row.id,
      locationId: row.location_id,
      code: row.code,
      name: row.name,
      type: row.type,
      tempMin: row.temp_min,
      tempMax: row.temp_max,
      sortOrder: row.sort_order,
      isActive: row.is_active,
    };
  }

  private async ensureLocationExists(client: PoolClient, locationId: string): Promise<void> {
    const res = await client.query(`SELECT 1 FROM locations WHERE id = $1`, [locationId]);
    if (res.rowCount === 0) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Location not found' });
  }

  async listForLocation(client: PoolClient, locationId: string, active?: boolean): Promise<StorageArea[]> {
    await this.ensureLocationExists(client, locationId);
    const params: unknown[] = [locationId];
    let where = 'location_id = $1';
    if (active !== undefined) {
      params.push(active);
      where += ` AND is_active = $${params.length}`;
    }
    const res = await client.query<StorageAreaRow>(
      `SELECT * FROM storage_areas WHERE ${where} ORDER BY sort_order ASC, code ASC`,
      params,
    );
    return res.rows.map((r) => this.map(r));
  }

  private async getRawById(client: PoolClient, locationId: string, areaId: string): Promise<StorageAreaRow> {
    const res = await client.query<StorageAreaRow>(
      `SELECT * FROM storage_areas WHERE id = $1 AND location_id = $2`,
      [areaId, locationId],
    );
    if (!res.rows[0]) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Storage area not found' });
    return res.rows[0];
  }

  async create(
    client: PoolClient,
    locationId: string,
    dto: CreateStorageAreaDto,
    actorUserId: string,
  ): Promise<StorageArea> {
    return withWrite(client, async () => {
      await this.ensureLocationExists(client, locationId);
      const res = await client.query<StorageAreaRow>(
        `INSERT INTO storage_areas (location_id, code, name, type, temp_min, temp_max, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, 0))
         RETURNING *`,
        [locationId, dto.code, dto.name, dto.type, dto.tempMin ?? null, dto.tempMax ?? null, dto.sortOrder ?? null],
      );
      const area = this.map(res.rows[0]!);
      await this.sync.emit(client, {
        entity: SyncEntity.STORAGE_AREAS,
        op: 'created',
        entityId: area.id,
        locationId,
        actorUserId,
        data: area,
      });
      return area;
    });
  }

  async update(
    client: PoolClient,
    locationId: string,
    areaId: string,
    dto: UpdateStorageAreaDto,
    actorUserId: string,
  ): Promise<StorageArea> {
    return withWrite(client, async () => {
      await this.getRawById(client, locationId, areaId); // 404 if missing
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };
      if (dto.code !== undefined) set('code', dto.code);
      if (dto.name !== undefined) set('name', dto.name);
      if (dto.type !== undefined) set('type', dto.type);
      if (dto.tempMin !== undefined) set('temp_min', dto.tempMin);
      if (dto.tempMax !== undefined) set('temp_max', dto.tempMax);
      if (dto.sortOrder !== undefined) set('sort_order', dto.sortOrder);

      if (sets.length > 0) {
        params.push(areaId, locationId);
        await client.query(
          `UPDATE storage_areas SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND location_id = $${params.length}`,
          params,
        );
      }

      const area = this.map(await this.getRawById(client, locationId, areaId));
      await this.sync.emit(client, {
        entity: SyncEntity.STORAGE_AREAS,
        op: 'updated',
        entityId: area.id,
        locationId,
        actorUserId,
        data: area,
      });
      return area;
    });
  }

  /** D-15: rejected `ERR_AREA_HAS_STOCK` if the area's stock balance ≠ 0 (any item). */
  async deactivate(
    client: PoolClient,
    locationId: string,
    areaId: string,
    actorUserId: string,
  ): Promise<{ id: string; deactivated: true }> {
    return withWrite(client, async () => {
      await this.getRawById(client, locationId, areaId); // 404 if missing

      const balance = await client.query<{ total: string }>(
        `SELECT COALESCE(SUM(qty_on_hand), 0) AS total FROM stock_balances WHERE storage_area_id = $1`,
        [areaId],
      );
      if (parseFloat(balance.rows[0]!.total) !== 0) {
        throw new BadRequestException({
          code: ERR_AREA_HAS_STOCK,
          message: 'Storage area has a non-zero stock balance and cannot be deactivated',
        });
      }

      await client.query(`UPDATE storage_areas SET is_active = false WHERE id = $1 AND location_id = $2`, [
        areaId,
        locationId,
      ]);
      await this.sync.emit(client, {
        entity: SyncEntity.STORAGE_AREAS,
        op: 'deactivated',
        entityId: areaId,
        locationId,
        actorUserId,
        data: { id: areaId, deactivated: true },
      });
      return { id: areaId, deactivated: true };
    });
  }
}
