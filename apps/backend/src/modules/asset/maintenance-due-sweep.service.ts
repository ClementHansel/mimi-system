import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { formatCloudDocNumber, type UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { SYSTEM_CENTRAL_ROLE, SYSTEM_SENTINEL_USER_ID, withSystemContext } from '../../common/database/system-context';
import { NotificationService } from '../../kernel/notification/notification.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { pgDateToIso } from './pg-date.util';

/** Roles the ticket names as `asset.job.execute` holders (matches `@mimi/shared` RBAC matrix — kept as a literal list here rather than deriving it, since this is a background sweep with no `PermissionKey` import boundary of its own). */
const JOB_EXECUTE_ROLES = ['manager', 'kepala_gudang', 'supervisor', 'leader_outlet'];

/** 6h — "before due" reminder semantics loosely matching a daily sweep, without waiting a full day for the first check after a schedule crosses its reminder window (no `@nestjs/schedule` dependency exists in this workspace — same `setInterval` pattern as `StalenessSweepService`/`LowStockDetectorService`). */
export const MAINTENANCE_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** `document_counters.doc_type` for scheduler-born jobs — same counter series `jobs.service.ts` uses, so job numbers are globally sequential regardless of which path created them. */
const JOB_DOC_PREFIX = 'MJ';

interface DueScheduleRow {
  id: UUID;
  asset_id: UUID;
  name: string;
  next_due_at: unknown;
  asset_name: string;
  location_id: UUID;
  location_name: string;
  assigned_user_id: UUID | null;
}

/**
 * FR-PMS-02/03 — the daily maintenance-due sweep: for every active schedule
 * within its `reminder_days_before` window, ensures exactly one
 * `maintenance_jobs` row (`type='scheduled'`, `status='due'`) exists for the
 * CURRENT cycle and sends the `maintenance_due` notification. `GET
 * /api/assets/maintenance/due` (`schedules.service.ts#due`) only READS the
 * picture this sweep maintains — it never creates a job itself.
 *
 * DATABASE_POOL INJECTION (the one exception this ticket's hard constraint
 * allows): this service runs off its own timer, not behind any HTTP
 * request — there is no `request.dbClient` to borrow (see
 * `common/database/system-context.ts`'s doc comment, "background/
 * event-driven" case, and `LowStockDetectorService`/`StalenessSweepService`,
 * the two existing templates for exactly this shape). Every other
 * controller/service in this module takes `request.dbClient` — this is the
 * ONLY provider in `modules/asset/**` that injects `DATABASE_POOL` directly,
 * and only because it has no request to inherit a client from.
 */
@Injectable()
export class MaintenanceDueSweepService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MaintenanceDueSweepService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly syncEmit: SyncEmitService,
    private readonly notifications: NotificationService,
  ) {}

  onApplicationBootstrap(): void {
    void this.runSweep().catch((err) => this.logger.error(`initial maintenance-due sweep failed: ${(err as Error).message}`));
    this.timer = setInterval(() => {
      void this.runSweep().catch((err) => this.logger.error(`maintenance-due sweep tick failed: ${(err as Error).message}`));
    }, MAINTENANCE_SWEEP_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests — runs one sweep pass synchronously, without waiting on the interval. */
  async runSweep(): Promise<void> {
    await withSystemContext(this.pool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
      const dueRes = await client.query<DueScheduleRow>(
        `SELECT ms.id, ms.asset_id, ms.name, ms.next_due_at, a.name AS asset_name, a.location_id, l.name AS location_name,
                e.user_id AS assigned_user_id
           FROM maintenance_schedules ms
           JOIN assets a ON a.id = ms.asset_id
           JOIN locations l ON l.id = a.location_id
           LEFT JOIN employees e ON e.id = a.assigned_to
          WHERE ms.is_active = true
            AND ms.next_due_at <= (CURRENT_DATE + (ms.reminder_days_before || ' days')::interval)
            AND NOT EXISTS (
              SELECT 1 FROM maintenance_jobs mj WHERE mj.schedule_id = ms.id AND mj.status IN ('due', 'in_progress')
            )`,
      );

      for (const row of dueRes.rows) {
        await this.createDueJobAndNotify(client, row).catch((err) =>
          this.logger.error(`maintenance-due handling failed for schedule ${row.id}: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
    });
  }

  private async nextJobNumber(client: PoolClient): Promise<string> {
    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const res = await client.query<{ last_number: number }>(
      `INSERT INTO document_counters (doc_type, period, last_number) VALUES ($1, $2, 1)
       ON CONFLICT (doc_type, period) DO UPDATE SET last_number = document_counters.last_number + 1
       RETURNING last_number`,
      [JOB_DOC_PREFIX, period],
    );
    return formatCloudDocNumber(JOB_DOC_PREFIX, period, res.rows[0]!.last_number);
  }

  private async createDueJobAndNotify(client: PoolClient, row: DueScheduleRow): Promise<void> {
    const jobNumber = await this.nextJobNumber(client);
    const dueDate = pgDateToIso(row.next_due_at);

    const jobRes = await client.query<{ id: UUID }>(
      `INSERT INTO maintenance_jobs (job_number, asset_id, schedule_id, type, status, due_date)
       VALUES ($1,$2,$3,'scheduled','due',$4)
       RETURNING id`,
      [jobNumber, row.asset_id, row.id, dueDate],
    );
    const jobId = jobRes.rows[0]!.id;

    await this.syncEmit
      .emit(client, {
        entity: 'maintenance_jobs',
        op: 'created',
        entityId: jobId,
        locationId: row.location_id,
        actorUserId: SYSTEM_SENTINEL_USER_ID,
        data: { id: jobId, assetId: row.asset_id, scheduleId: row.id, type: 'scheduled', dueDate },
      })
      .catch((err: Error) => this.logger.warn(`sync-emit for maintenance job ${jobId} failed (non-fatal): ${err.message}`));

    const recipientIds = await this.resolveRecipients(client, row.location_id, row.assigned_user_id);
    if (recipientIds.length === 0) {
      this.logger.warn(`maintenance_due for schedule ${row.id} (asset ${row.asset_id}) has no recipient to notify`);
      return;
    }

    await this.notifications.notify({
      templateKey: 'maintenance_due',
      userIds: recipientIds,
      locationId: row.location_id,
      params: { assetName: row.asset_name, locationName: row.location_name, dueDate },
    });
  }

  /** The asset's assigned employee's user (if any) UNION every active user at the location holding `asset.job.execute` (manager/kepala_gudang/supervisor/leader_outlet — CONTRACTS.md §3). */
  private async resolveRecipients(client: PoolClient, locationId: UUID, assignedUserId: UUID | null): Promise<UUID[]> {
    const res = await client.query<{ id: UUID }>(
      `SELECT DISTINCT u.id
         FROM users u
         JOIN roles r ON r.id = u.role_id
         JOIN user_locations ul ON ul.user_id = u.id
        WHERE ul.location_id = $1 AND u.is_active = true AND r.key = ANY($2::varchar[])`,
      [locationId, JOB_EXECUTE_ROLES],
    );
    const ids = new Set(res.rows.map((r) => r.id));
    if (assignedUserId) ids.add(assignedUserId);
    return [...ids];
  }
}
