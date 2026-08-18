import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import {
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  formatCloudDocNumber,
  type Money,
  type Paginated,
  type UUID,
} from '@mimi/shared';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { StorageService } from '../../kernel/storage/storage.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { PaymentVerificationsService } from '../accounting/payment-verifications.service';
import { withWrite } from './db-tx';
import type { CompleteJobDto, CreateJobDto, VerifyJobDto } from './dto/job.dto';
import { pgDateToIso, pgDateToIsoOrNull } from './pg-date.util';
import { ASSET_CENTRAL_ROLES, assertAssetLocationScope } from './scope.util';

/** `document_counters.doc_type` for maintenance jobs — no CHECK constraint restricts the value (migration 007). */
const JOB_DOC_PREFIX = 'MJ';

export type JobStatus = 'scheduled' | 'due' | 'in_progress' | 'done' | 'verified' | 'skipped';

export interface JobDto {
  id: UUID;
  jobNumber: string;
  assetName: string;
  type: 'scheduled' | 'corrective';
  status: JobStatus;
  dueDate: string | null;
  assignedToName: string | null;
  completedAt: string | null;
  cost: Money | null;
  proofUrls: string[];
}

interface JobJoinRow {
  id: string;
  job_number: string;
  asset_id: string;
  asset_name: string;
  asset_location_id: string;
  schedule_id: string | null;
  schedule_interval_type: string | null;
  schedule_interval_value: number | null;
  type: string;
  status: string;
  due_date: unknown;
  assigned_to_name: string | null;
  completed_at: unknown;
  cost: string | null;
  notes: string | null;
  payment_verification_id: string | null;
}

const JOB_SELECT = `
  SELECT j.id, j.job_number, j.asset_id, a.name AS asset_name, a.location_id AS asset_location_id,
         j.schedule_id, ms.interval_type AS schedule_interval_type, ms.interval_value AS schedule_interval_value,
         j.type, j.status, j.due_date, e.name AS assigned_to_name, j.completed_at, j.cost, j.notes,
         j.payment_verification_id
    FROM maintenance_jobs j
    JOIN assets a ON a.id = j.asset_id
    LEFT JOIN employees e ON e.id = j.assigned_to
    LEFT JOIN maintenance_schedules ms ON ms.id = j.schedule_id`;

/**
 * FR-PMS-02/04 — `maintenance_jobs`/`service_history` (block 070-079, NO
 * RLS — migration 074, "API-gated only"). Same scope-gating discipline as
 * `schedules.service.ts`: resolve+404 the owning asset (RLS-scoped) first,
 * then `assertAssetLocationScope` as defense-in-depth.
 *
 * Proof evidence (FR-PMS-04, wajib bukti servis): neither `maintenance_jobs`
 * nor `service_history` has an attachment-id column. `attachments` itself
 * carries `entity_type`/`entity_id` (kernel/storage) — `complete()` stamps
 * every `proofAttachmentIds` row with `entity_type='maintenance_job'`,
 * `entity_id=<jobId>` so `Job.proofUrls`/history's `proofUrls` can look them
 * back up later. A judgment call (flagged in the module report): the
 * contract names `proofUrls` on both `Job` and the history row but the
 * schema has no dedicated join table for it.
 */
@Injectable()
export class JobsService {
  constructor(
    private readonly storage: StorageService,
    private readonly syncEmit: SyncEmitService,
    private readonly paymentVerifications: PaymentVerificationsService,
  ) {}

  private async resolveProofUrls(
    client: PoolClient,
    user: JwtAccessPayload,
    locationScope: string[] | null,
    jobId: string,
  ): Promise<string[]> {
    const res = await client.query<{ id: string }>(
      `SELECT id FROM attachments WHERE entity_type = 'maintenance_job' AND entity_id = $1 ORDER BY created_at ASC`,
      [jobId],
    );
    const urls = await Promise.all(
      res.rows.map(async (r) => {
        try {
          const { url } = await this.storage.getUrl(client, user, locationScope, r.id);
          return url;
        } catch {
          return null;
        }
      }),
    );
    return urls.filter((u): u is string => u !== null);
  }

  private async map(
    client: PoolClient,
    row: JobJoinRow,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<JobDto> {
    return {
      id: row.id,
      jobNumber: row.job_number,
      assetName: row.asset_name,
      type: row.type as 'scheduled' | 'corrective',
      status: row.status as JobStatus,
      dueDate: pgDateToIsoOrNull(row.due_date),
      assignedToName: row.assigned_to_name,
      completedAt: row.completed_at ? new Date(row.completed_at as string).toISOString() : null,
      cost: row.cost,
      proofUrls:
        row.status === 'done' || row.status === 'verified'
          ? await this.resolveProofUrls(client, user, locationScope, row.id)
          : [],
    };
  }

  private async requireJob(client: PoolClient, jobId: string): Promise<JobJoinRow> {
    const res = await client.query<JobJoinRow>(`${JOB_SELECT} WHERE j.id = $1`, [jobId]);
    const row = res.rows[0];
    if (!row) throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Job not found' });
    return row;
  }

  async list(
    client: PoolClient,
    query: {
      locationId?: string;
      status?: string;
      assetId?: string;
      page?: number;
      pageSize?: number;
    },
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<Paginated<JobDto>> {
    if (
      query.locationId &&
      !ASSET_CENTRAL_ROLES.has(user.roleKey) &&
      locationScope !== null &&
      !locationScope.includes(query.locationId)
    ) {
      return { rows: [], total: 0, page: query.page ?? 1, pageSize: query.pageSize ?? 50 };
    }

    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 50;
    const where: string[] = [];
    const params: unknown[] = [];

    if (query.locationId) {
      params.push(query.locationId);
      where.push(`a.location_id = $${params.length}`);
    } else if (!ASSET_CENTRAL_ROLES.has(user.roleKey) && locationScope !== null) {
      params.push(locationScope);
      where.push(`a.location_id = ANY($${params.length}::uuid[])`);
    }
    if (query.status) {
      params.push(query.status);
      where.push(`j.status = $${params.length}`);
    }
    if (query.assetId) {
      params.push(query.assetId);
      where.push(`j.asset_id = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM maintenance_jobs j JOIN assets a ON a.id = j.asset_id ${whereSql}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(pageSize, (page - 1) * pageSize);
    const rowsRes = await client.query<JobJoinRow>(
      `${JOB_SELECT} ${whereSql} ORDER BY j.due_date ASC NULLS LAST, j.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    const rows = await Promise.all(
      rowsRes.rows.map((r) => this.map(client, r, user, locationScope)),
    );
    return { rows, total, page, pageSize };
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

  async create(
    client: PoolClient,
    actorUserId: UUID,
    assetId: string,
    assetLocationId: string,
    dto: CreateJobDto,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<JobDto> {
    assertAssetLocationScope(user, locationScope, assetLocationId);
    return withWrite(client, async () => {
      const jobNumber = await this.nextJobNumber(client);
      // A corrective job reported now is immediately actionable — 'due', not the table default
      // 'scheduled' (which is reserved for a schedule's future cycle) — a judgment call, flagged in
      // the module report; the contract does not name an initial status for this endpoint.
      const res = await client.query<{ id: string }>(
        `INSERT INTO maintenance_jobs (job_number, asset_id, type, status, due_date, assigned_to, notes)
         VALUES ($1,$2,'corrective','due', CURRENT_DATE, $3, $4)
         RETURNING id`,
        [jobNumber, assetId, dto.assignedToEmployeeId ?? null, dto.description],
      );
      const id = res.rows[0]!.id;
      const row = await this.requireJob(client, id);
      const job = await this.map(client, row, user, locationScope);

      await this.syncEmit.emit(client, {
        entity: 'maintenance_jobs',
        op: 'created',
        entityId: id,
        locationId: assetLocationId,
        actorUserId,
        data: { id, assetId, scheduleId: null, type: 'corrective', dueDate: job.dueDate },
      });

      return job;
    });
  }

  async start(
    client: PoolClient,
    jobId: string,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<JobDto> {
    const row = await this.requireJob(client, jobId);
    assertAssetLocationScope(user, locationScope, row.asset_location_id);
    if (row.status !== 'due' && row.status !== 'scheduled') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Job ${row.job_number} is '${row.status}' — cannot start`,
      });
    }
    return withWrite(client, async () => {
      await client.query(`UPDATE maintenance_jobs SET status = 'in_progress' WHERE id = $1`, [
        jobId,
      ]);
      const updated = await this.requireJob(client, jobId);
      // No 'started' op exists in the sync-protocol registry for `maintenance_jobs` (only 'created'/
      // 'completed') — no sync event emitted here, matching the registry's actual vocabulary.
      return this.map(client, updated, user, locationScope);
    });
  }

  async complete(
    client: PoolClient,
    actorUserId: UUID,
    jobId: string,
    dto: CompleteJobDto,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<JobDto> {
    const row = await this.requireJob(client, jobId);
    assertAssetLocationScope(user, locationScope, row.asset_location_id);
    if (row.status !== 'in_progress' && row.status !== 'due') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Job ${row.job_number} is '${row.status}' — cannot complete`,
      });
    }

    return withWrite(client, async () => {
      const cost = dto.cost ?? null;

      await client.query(
        `UPDATE maintenance_jobs SET status = 'done', completed_by = $2, completed_at = NOW(), cost = $3, notes = COALESCE($4, notes) WHERE id = $1`,
        [jobId, actorUserId, cost, dto.notes ?? null],
      );

      // Link the already-uploaded proof attachments to this job — see class doc comment.
      await client.query(
        `UPDATE attachments SET entity_type = 'maintenance_job', entity_id = $2, kind = COALESCE(NULLIF(kind, ''), 'service_proof')
          WHERE id = ANY($1::uuid[])`,
        [dto.proofAttachmentIds, jobId],
      );

      const description = dto.notes ?? row.notes ?? 'Servis selesai';
      await client.query(
        `INSERT INTO service_history (asset_id, job_id, service_date, description, vendor, cost, condition_after, odometer_km, recorded_by)
         VALUES ($1,$2,CURRENT_DATE,$3,$4,$5,$6,$7,$8)`,
        [
          row.asset_id,
          jobId,
          description,
          dto.vendor ?? null,
          cost ?? '0',
          dto.conditionAfter,
          dto.odometerKm ?? null,
          actorUserId,
        ],
      );

      // Roll the owning schedule's next cycle forward, per this ticket's spec: next_due_at = CURRENT
      // next_due_at + interval (not today + interval), last_done_at = today.
      if (row.schedule_id) {
        await client.query(
          `UPDATE maintenance_schedules
              SET last_done_at = CURRENT_DATE,
                  next_due_at = (next_due_at + (interval_value || ' ' || interval_type)::interval)::date
            WHERE id = $1`,
          [row.schedule_id],
        );
      }

      // FR-ACCT-04: cost > 0 opens a pending payment_verifications row. `payment_verifications`'
      // own RLS (migration 095) is central-role-only for INSERT — `PaymentVerificationsService
      // .createSystemVerification` is the escalated-insert path that module already built for
      // exactly this cross-module shape (see its own doc comment).
      if (cost && Number(cost) > 0) {
        const pvId = await this.paymentVerifications.createSystemVerification(
          client,
          { role: user.roleKey, userId: actorUserId, locationIds: locationScope ?? [] },
          {
            refType: 'maintenance_job',
            refId: jobId,
            payeeType: 'other',
            payeeId: null,
            amount: cost,
            locationId: row.asset_location_id,
            submittedBy: actorUserId,
            notes: dto.vendor ? `Vendor: ${dto.vendor}` : null,
          },
        );
        await client.query(
          `UPDATE maintenance_jobs SET payment_verification_id = $2 WHERE id = $1`,
          [jobId, pvId],
        );
      }

      const updated = await this.requireJob(client, jobId);
      const job = await this.map(client, updated, user, locationScope);

      await this.syncEmit.emit(client, {
        entity: 'maintenance_jobs',
        op: 'completed',
        entityId: jobId,
        locationId: row.asset_location_id,
        actorUserId,
        data: {
          proofAttachmentIds: dto.proofAttachmentIds,
          cost: cost ?? undefined,
          vendor: dto.vendor ?? undefined,
          conditionAfter: dto.conditionAfter,
          odometerKm: dto.odometerKm ?? undefined,
          notes: dto.notes ?? undefined,
        },
      });

      // FR-PMS-01/04: the asset's own condition tracks the just-recorded service outcome.
      await client.query(`UPDATE assets SET condition = $2 WHERE id = $1`, [
        row.asset_id,
        dto.conditionAfter,
      ]);

      return job;
    });
  }

  async verify(
    client: PoolClient,
    actorUserId: UUID,
    jobId: string,
    dto: VerifyJobDto,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<JobDto> {
    const row = await this.requireJob(client, jobId);
    assertAssetLocationScope(user, locationScope, row.asset_location_id);
    if (row.status !== 'done') {
      throw new ConflictException({
        code: ERR_CONFLICT,
        message: `Job ${row.job_number} is '${row.status}' — cannot verify`,
      });
    }
    return withWrite(client, async () => {
      await client.query(
        `UPDATE maintenance_jobs SET status = 'verified', verified_by = $2, verified_at = NOW(), notes = COALESCE($3, notes) WHERE id = $1`,
        [jobId, actorUserId, dto.note ?? null],
      );
      const updated = await this.requireJob(client, jobId);
      // No 'verified' op exists in the sync-protocol registry either — same reasoning as start().
      return this.map(client, updated, user, locationScope);
    });
  }

  async history(
    client: PoolClient,
    assetLocationId: string,
    assetId: string,
    page: number,
    pageSize: number,
    user: JwtAccessPayload,
    locationScope: string[] | null,
  ): Promise<
    Paginated<{
      serviceDate: string;
      description: string;
      vendor: string | null;
      cost: Money;
      conditionAfter: string;
      odometerKm: number | null;
      recordedBy: string;
      proofUrls: string[];
    }>
  > {
    assertAssetLocationScope(user, locationScope, assetLocationId);

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM service_history WHERE asset_id = $1`,
      [assetId],
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    const res = await client.query<{
      service_date: unknown;
      description: string;
      vendor: string | null;
      cost: string;
      condition_after: string;
      odometer_km: number | null;
      recorded_by_name: string;
      job_id: string | null;
    }>(
      `SELECT sh.service_date, sh.description, sh.vendor, sh.cost, sh.condition_after, sh.odometer_km, sh.job_id,
              u.name AS recorded_by_name
         FROM service_history sh
         JOIN users u ON u.id = sh.recorded_by
        WHERE sh.asset_id = $1
        ORDER BY sh.service_date DESC, sh.created_at DESC
        LIMIT $2 OFFSET $3`,
      [assetId, pageSize, (page - 1) * pageSize],
    );

    const rows = await Promise.all(
      res.rows.map(async (r) => ({
        serviceDate: pgDateToIso(r.service_date),
        description: r.description,
        vendor: r.vendor,
        cost: r.cost,
        conditionAfter: r.condition_after,
        odometerKm: r.odometer_km,
        recordedBy: r.recorded_by_name,
        proofUrls: r.job_id
          ? await this.resolveProofUrls(client, user, locationScope, r.job_id)
          : [],
      })),
    );

    return { rows, total, page, pageSize };
  }
}
