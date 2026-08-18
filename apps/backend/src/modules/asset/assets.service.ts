import { NotFoundException } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_NOT_FOUND,
  formatCloudDocNumber,
  type AssetCategory,
  type AssetCondition,
  type AssetStatus,
  type Money,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { StorageService } from '../../kernel/storage/storage.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import type { CreateAssetDto, UpdateAssetDto } from './dto/asset.dto';
import { pgDateToIsoOrNull } from './pg-date.util';
import type { JobDto } from './jobs.service';
import type { ScheduleDto } from './schedules.service';

/** `document_counters.doc_type` for this module — no CHECK constraint restricts the value (migration 007), so a fresh prefix needs no migration. */
const ASSET_DOC_PREFIX = 'AST';

export interface AssetRow {
  id: string;
  asset_number: string;
  name: string;
  category: string;
  location_id: string;
  location_name: string;
  serial_number: string | null;
  brand: string | null;
  model: string | null;
  purchase_date: unknown;
  purchase_price: string | null;
  vehicle_id: string | null;
  condition: string;
  status: string;
  assigned_to: string | null;
  assigned_to_name: string | null;
  photo_attachment_id: string | null;
}

export interface AssetDto {
  id: UUID;
  assetNumber: string;
  name: string;
  category: AssetCategory;
  locationName: string;
  serialNumber: string | null;
  brand: string | null;
  model: string | null;
  purchaseDate: string | null;
  purchasePrice?: Money;
  condition: AssetCondition;
  status: AssetStatus;
  assignedToName: string | null;
  photoUrl: string | null;
}

const ASSET_SELECT = `
  SELECT a.id, a.asset_number, a.name, a.category, a.location_id, l.name AS location_name,
         a.serial_number, a.brand, a.model, a.purchase_date, a.purchase_price, a.vehicle_id,
         a.condition, a.status, a.assigned_to, e.name AS assigned_to_name, a.photo_attachment_id
    FROM assets a
    JOIN locations l ON l.id = a.location_id
    LEFT JOIN employees e ON e.id = a.assigned_to`;

/**
 * M16 `asset` — asset register (CONTRACTS.md §4.16, FR-PMS-01). `assets`
 * itself IS RLS-scoped (`assets_loc`, migration 074) — every query below runs
 * on the caller's own `req.dbClient`, so Postgres itself narrows list/read to
 * the caller's location scope; no manual gating is needed for THIS table
 * (unlike `maintenance_schedules`/`jobs`/`service_history`, see `scope.util.ts`).
 */
@Injectable()
export class AssetsService {
  constructor(
    private readonly storage: StorageService,
    private readonly syncEmit: SyncEmitService,
  ) {}

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
      return null; // Missing/inaccessible attachment — degrade to no photo rather than fail the whole response.
    }
  }

  private async map(
    client: PoolClient,
    row: AssetRow,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<AssetDto> {
    return {
      id: row.id,
      assetNumber: row.asset_number,
      name: row.name,
      category: row.category as AssetCategory,
      locationName: row.location_name,
      serialNumber: row.serial_number,
      brand: row.brand,
      model: row.model,
      purchaseDate: pgDateToIsoOrNull(row.purchase_date),
      ...(row.purchase_price !== null ? { purchasePrice: row.purchase_price } : {}),
      condition: row.condition as AssetCondition,
      status: row.status as AssetStatus,
      assignedToName: row.assigned_to_name,
      photoUrl: await this.resolvePhotoUrl(client, user, locationScope, row.photo_attachment_id),
    };
  }

  async list(
    client: PoolClient,
    query: {
      locationId?: string;
      category?: string;
      status?: string;
      condition?: string;
      q?: string;
      page?: number;
      pageSize?: number;
    },
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<Paginated<AssetDto>> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.locationId) {
      params.push(query.locationId);
      where.push(`a.location_id = $${params.length}`);
    }
    if (query.category) {
      params.push(query.category);
      where.push(`a.category = $${params.length}`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`a.status = $${params.length}`);
    }
    if (query.condition) {
      params.push(query.condition);
      where.push(`a.condition = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q}%`);
      where.push(`(a.name ILIKE $${params.length} OR a.asset_number ILIKE $${params.length})`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM assets a ${whereSql}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(pageSize, (page - 1) * pageSize);
    const rowsRes = await client.query<AssetRow>(
      `${ASSET_SELECT} ${whereSql} ORDER BY a.name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const rows = await Promise.all(
      rowsRes.rows.map((r) => this.map(client, r, user, locationScope)),
    );
    return { rows, total, page, pageSize };
  }

  private async getRawById(client: PoolClient, id: string): Promise<AssetRow> {
    const res = await client.query<AssetRow>(`${ASSET_SELECT} WHERE a.id = $1`, [id]);
    const row = res.rows[0];
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Asset not found' });
    return row;
  }

  /** Also used by `schedules.service.ts`/`jobs.service.ts` to resolve+scope-check the owning asset before touching an un-RLS'd child table. */
  async getAssetLocationId(client: PoolClient, id: string): Promise<string> {
    return (await this.getRawById(client, id)).location_id;
  }

  async getById(
    client: PoolClient,
    id: string,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<AssetDto & { schedules: ScheduleDto[]; openJobs: JobDto[] }> {
    const row = await this.getRawById(client, id);
    const dto = await this.map(client, row, user, locationScope);

    const schedulesRes = await client.query<{
      id: string;
      name: string;
      interval_type: string;
      interval_value: number;
      last_done_at: unknown;
      next_due_at: unknown;
      reminder_days_before: number;
      is_active: boolean;
    }>(
      `SELECT id, name, interval_type, interval_value, last_done_at, next_due_at, reminder_days_before, is_active
         FROM maintenance_schedules WHERE asset_id = $1 ORDER BY next_due_at ASC`,
      [id],
    );

    const jobsRes = await client.query<{
      id: string;
      job_number: string;
      type: string;
      status: string;
      due_date: unknown;
      assigned_to_name: string | null;
      completed_at: unknown;
      cost: string | null;
    }>(
      `SELECT j.id, j.job_number, j.type, j.status, j.due_date, e.name AS assigned_to_name, j.completed_at, j.cost
         FROM maintenance_jobs j
         LEFT JOIN employees e ON e.id = j.assigned_to
        WHERE j.asset_id = $1 AND j.status IN ('scheduled','due','in_progress')
        ORDER BY j.due_date ASC NULLS LAST`,
      [id],
    );

    return {
      ...dto,
      schedules: schedulesRes.rows.map((s) => ({
        id: s.id,
        name: s.name,
        intervalType: s.interval_type as 'days' | 'months',
        lastDoneAt: pgDateToIsoOrNull(s.last_done_at),
        nextDueAt: pgDateToIsoOrNull(s.next_due_at)!,
        intervalValue: s.interval_value,
        reminderDaysBefore: s.reminder_days_before,
        isActive: s.is_active,
      })),
      openJobs: jobsRes.rows.map((j) => ({
        id: j.id,
        jobNumber: j.job_number,
        assetName: dto.name,
        type: j.type as 'scheduled' | 'corrective',
        status: j.status as JobDto['status'],
        dueDate: pgDateToIsoOrNull(j.due_date),
        assignedToName: j.assigned_to_name,
        completedAt: j.completed_at ? new Date(j.completed_at as string).toISOString() : null,
        cost: j.cost,
        proofUrls: [], // Only completed jobs carry proof — an open job never has any yet.
      })),
    };
  }

  private async nextAssetNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [ASSET_DOC_PREFIX, period],
    );
    return formatCloudDocNumber(ASSET_DOC_PREFIX, period, res.rows[0]!.last_number);
  }

  async create(
    client: PoolClient,
    actorUserId: UUID,
    dto: CreateAssetDto,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<AssetDto> {
    return withWrite(client, async () => {
      const assetNumber = dto.assetNumber?.trim() || (await this.nextAssetNumber(client));

      const res = await client.query<{ id: string }>(
        `INSERT INTO assets (asset_number, name, category, location_id, serial_number, brand, model, purchase_date, purchase_price, vehicle_id, assigned_to, photo_attachment_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING id`,
        [
          assetNumber,
          dto.name,
          dto.category,
          dto.locationId,
          dto.serialNumber ?? null,
          dto.brand ?? null,
          dto.model ?? null,
          dto.purchaseDate ?? null,
          dto.purchasePrice ?? null,
          dto.vehicleId ?? null,
          dto.assignedToEmployeeId ?? null,
          dto.photoAttachmentId ?? null,
        ],
      );
      const id = res.rows[0]!.id;
      const asset = await this.map(client, await this.getRawById(client, id), user, locationScope);

      await this.syncEmit.emit(client, {
        entity: 'assets',
        op: 'created',
        entityId: id,
        locationId: dto.locationId,
        actorUserId,
        data: {
          id,
          assetNumber: asset.assetNumber,
          name: asset.name,
          category: asset.category,
          locationId: dto.locationId,
          serialNumber: asset.serialNumber ?? undefined,
          brand: asset.brand ?? undefined,
          model: asset.model ?? undefined,
          purchaseDate: asset.purchaseDate ?? undefined,
          condition: asset.condition,
        },
      });

      return asset;
    });
  }

  async update(
    client: PoolClient,
    actorUserId: UUID,
    id: string,
    dto: UpdateAssetDto,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<AssetDto> {
    return withWrite(client, async () => {
      const before = await this.getRawById(client, id);

      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };

      if (dto.name !== undefined) set('name', dto.name);
      if (dto.category !== undefined) set('category', dto.category);
      if (dto.locationId !== undefined) set('location_id', dto.locationId);
      if (dto.serialNumber !== undefined) set('serial_number', dto.serialNumber);
      if (dto.brand !== undefined) set('brand', dto.brand);
      if (dto.model !== undefined) set('model', dto.model);
      if (dto.purchaseDate !== undefined) set('purchase_date', dto.purchaseDate);
      if (dto.purchasePrice !== undefined) set('purchase_price', dto.purchasePrice);
      if (dto.vehicleId !== undefined) set('vehicle_id', dto.vehicleId);
      if (dto.condition !== undefined) set('condition', dto.condition);
      if (dto.status !== undefined) set('status', dto.status);
      if (dto.assignedToEmployeeId !== undefined) set('assigned_to', dto.assignedToEmployeeId);
      if (dto.photoAttachmentId !== undefined) set('photo_attachment_id', dto.photoAttachmentId);

      if (sets.length > 0) {
        params.push(id);
        const res = await client.query(
          `UPDATE assets SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
        if (res.rowCount === 0)
          throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Asset not found' });
      }

      const updatedRow = await this.getRawById(client, id);
      const asset = await this.map(client, updatedRow, user, locationScope);

      if (dto.status === 'retired' && before.status !== 'retired') {
        await this.syncEmit.emit(client, {
          entity: 'assets',
          op: 'retired',
          entityId: id,
          locationId: updatedRow.location_id,
          actorUserId,
          data: { id },
        });
      } else {
        await this.syncEmit.emit(client, {
          entity: 'assets',
          op: 'updated',
          entityId: id,
          locationId: updatedRow.location_id,
          actorUserId,
          data: {
            id,
            assetNumber: asset.assetNumber,
            name: asset.name,
            category: asset.category,
            locationId: updatedRow.location_id,
            serialNumber: asset.serialNumber ?? undefined,
            brand: asset.brand ?? undefined,
            model: asset.model ?? undefined,
            purchaseDate: asset.purchaseDate ?? undefined,
            condition: asset.condition,
          },
        });
      }

      return asset;
    });
  }
}
