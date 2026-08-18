import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { ERR_FORBIDDEN, ERR_NOT_FOUND, type UUID } from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withWrite } from './db-tx';
import type { CreateScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
import { pgDateToIso, pgDateToIsoOrNull } from './pg-date.util';
import { ASSET_CENTRAL_ROLES, assertAssetLocationScope } from './scope.util';

export interface ScheduleDto {
  id: UUID;
  name: string;
  intervalType: 'days' | 'months';
  intervalValue: number;
  lastDoneAt: string | null;
  nextDueAt: string;
  reminderDaysBefore: number;
  isActive: boolean;
}

interface ScheduleRow {
  id: string;
  asset_id: string;
  name: string;
  interval_type: string;
  interval_value: number;
  last_done_at: unknown;
  next_due_at: unknown;
  reminder_days_before: number;
  is_active: boolean;
}

export interface DueItem {
  jobId: UUID | null;
  scheduleId: UUID;
  assetId: UUID;
  assetName: string;
  locationName: string;
  name: string;
  dueDate: string;
  overdue: boolean;
}

/**
 * FR-PMS-02/03 — `maintenance_schedules` (block 070-079, NO RLS — migration
 * 074, "API-gated only"). Every read/write below resolves the owning
 * `assets` row FIRST (which IS RLS-scoped) to both 404 an invisible asset id
 * and get its `location_id`, then calls `assertAssetLocationScope` as
 * defense-in-depth — see `scope.util.ts`'s header for why both layers exist.
 */
@Injectable()
export class SchedulesService {
  constructor(private readonly syncEmit: SyncEmitService) {}

  private map(row: ScheduleRow): ScheduleDto {
    return {
      id: row.id,
      name: row.name,
      intervalType: row.interval_type as 'days' | 'months',
      intervalValue: row.interval_value,
      lastDoneAt: pgDateToIsoOrNull(row.last_done_at),
      nextDueAt: pgDateToIso(row.next_due_at),
      reminderDaysBefore: row.reminder_days_before,
      isActive: row.is_active,
    };
  }

  private async requireScheduleRow(client: PoolClient, scheduleId: string): Promise<ScheduleRow> {
    const res = await client.query<ScheduleRow>(
      'SELECT * FROM maintenance_schedules WHERE id = $1',
      [scheduleId],
    );
    const row = res.rows[0];
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Schedule not found' });
    return row;
  }

  async listForAsset(
    client: PoolClient,
    assetLocationId: string,
    assetId: string,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<ScheduleDto[]> {
    assertAssetLocationScope(user, locationScope, assetLocationId);
    const res = await client.query<ScheduleRow>(
      `SELECT * FROM maintenance_schedules WHERE asset_id = $1 ORDER BY next_due_at ASC`,
      [assetId],
    );
    return res.rows.map((r) => this.map(r));
  }

  async create(
    client: PoolClient,
    actorUserId: UUID,
    assetLocationId: string,
    assetId: string,
    dto: CreateScheduleDto,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<ScheduleDto> {
    assertAssetLocationScope(user, locationScope, assetLocationId);
    return withWrite(client, async () => {
      const res = await client.query<{ id: string }>(
        `INSERT INTO maintenance_schedules (asset_id, name, interval_type, interval_value, next_due_at, reminder_days_before)
         VALUES ($1,$2,$3,$4,$5, COALESCE($6, 7))
         RETURNING id`,
        [
          assetId,
          dto.name,
          dto.intervalType,
          dto.intervalValue,
          dto.nextDueAt,
          dto.reminderDaysBefore ?? null,
        ],
      );
      const row = await this.requireScheduleRow(client, res.rows[0]!.id);
      const schedule = this.map(row);

      // Only 'updated' is registered in the sync-protocol registry for `maintenance_schedules` —
      // used for BOTH create and update per this ticket's spec.
      await this.syncEmit.emit(client, {
        entity: 'maintenance_schedules',
        op: 'updated',
        entityId: schedule.id,
        locationId: assetLocationId,
        actorUserId,
        data: {
          id: schedule.id,
          assetId,
          name: schedule.name,
          intervalType: schedule.intervalType,
          intervalValue: schedule.intervalValue,
          nextDueAt: schedule.nextDueAt,
          reminderDaysBefore: schedule.reminderDaysBefore,
          isActive: schedule.isActive,
        },
      });

      return schedule;
    });
  }

  async update(
    client: PoolClient,
    actorUserId: UUID,
    scheduleId: string,
    dto: UpdateScheduleDto,
    resolveAssetLocationId: (assetId: string) => Promise<string>,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<ScheduleDto> {
    const before = await this.requireScheduleRow(client, scheduleId);
    const assetLocationId = await resolveAssetLocationId(before.asset_id);
    assertAssetLocationScope(user, locationScope, assetLocationId);

    return withWrite(client, async () => {
      const sets: string[] = [];
      const params: unknown[] = [];
      const set = (col: string, val: unknown) => {
        params.push(val);
        sets.push(`${col} = $${params.length}`);
      };

      if (dto.name !== undefined) set('name', dto.name);
      if (dto.intervalType !== undefined) set('interval_type', dto.intervalType);
      if (dto.intervalValue !== undefined) set('interval_value', dto.intervalValue);
      if (dto.nextDueAt !== undefined) set('next_due_at', dto.nextDueAt);
      if (dto.lastDoneAt !== undefined) set('last_done_at', dto.lastDoneAt);
      if (dto.reminderDaysBefore !== undefined) set('reminder_days_before', dto.reminderDaysBefore);
      if (dto.isActive !== undefined) set('is_active', dto.isActive);

      if (sets.length > 0) {
        params.push(scheduleId);
        await client.query(
          `UPDATE maintenance_schedules SET ${sets.join(', ')} WHERE id = $${params.length}`,
          params,
        );
      }

      const row = await this.requireScheduleRow(client, scheduleId);
      const schedule = this.map(row);

      await this.syncEmit.emit(client, {
        entity: 'maintenance_schedules',
        op: 'updated',
        entityId: schedule.id,
        locationId: assetLocationId,
        actorUserId,
        data: {
          id: schedule.id,
          assetId: row.asset_id,
          name: schedule.name,
          intervalType: schedule.intervalType,
          intervalValue: schedule.intervalValue,
          nextDueAt: schedule.nextDueAt,
          reminderDaysBefore: schedule.reminderDaysBefore,
          isActive: schedule.isActive,
        },
      });

      return schedule;
    });
  }

  /**
   * `GET /api/assets/maintenance/due` — a READ of the current due/overdue
   * picture the sweep (`maintenance-due-sweep.service.ts`) maintains; this
   * method never creates a job itself. `maintenance_schedules`/
   * `maintenance_jobs` carry no RLS, so a scoped (non-central) caller with no
   * explicit `locationId` filter is restricted here to their own
   * `locationScope`; an explicit `locationId` outside that scope 403s.
   */
  async due(
    client: PoolClient,
    windowDays: number,
    locationIdFilter: string | undefined,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<DueItem[]> {
    if (
      locationIdFilter &&
      !ASSET_CENTRAL_ROLES.has(user.roleKey) &&
      locationScope !== null &&
      !locationScope.includes(locationIdFilter)
    ) {
      throw new ForbiddenException({
        code: ERR_FORBIDDEN,
        message: 'Not assigned to that location',
      });
    }

    const params: unknown[] = [windowDays];
    let where = `ms.is_active = true AND ms.next_due_at <= (CURRENT_DATE + ($1 || ' days')::interval)`;

    if (locationIdFilter) {
      params.push(locationIdFilter);
      where += ` AND a.location_id = $${params.length}`;
    } else if (!ASSET_CENTRAL_ROLES.has(user.roleKey) && locationScope !== null) {
      params.push(locationScope);
      where += ` AND a.location_id = ANY($${params.length}::uuid[])`;
    }

    const res = await client.query<{
      schedule_id: string;
      asset_id: string;
      asset_name: string;
      location_name: string;
      name: string;
      next_due_at: unknown;
      job_id: string | null;
    }>(
      `SELECT ms.id AS schedule_id, ms.asset_id, a.name AS asset_name, l.name AS location_name,
              ms.name, ms.next_due_at, j.id AS job_id
         FROM maintenance_schedules ms
         JOIN assets a ON a.id = ms.asset_id
         JOIN locations l ON l.id = a.location_id
         LEFT JOIN LATERAL (
           SELECT mj.id FROM maintenance_jobs mj
            WHERE mj.schedule_id = ms.id AND mj.status IN ('due','in_progress')
            ORDER BY mj.created_at DESC LIMIT 1
         ) j ON true
        WHERE ${where}
        ORDER BY ms.next_due_at ASC`,
      params,
    );

    const today = pgDateToIso(new Date());
    return res.rows.map((r) => {
      const dueDate = pgDateToIso(r.next_due_at);
      return {
        jobId: r.job_id,
        scheduleId: r.schedule_id,
        assetId: r.asset_id,
        assetName: r.asset_name,
        locationName: r.location_name,
        name: r.name,
        dueDate,
        overdue: dueDate < today,
      };
    });
  }
}
