import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import {
  ApprovalDocumentType,
  ERR_NOT_FOUND,
  ERR_VALIDATION,
  LeaveStatus,
  LeaveType,
  type Paginated,
  type RoleKey,
  type UUID,
} from '@mimi/shared';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import type { ApproveLeaveDto, RejectLeaveDto, SubmitLeaveDto } from '../dto/leave.dto';
import { getLeaveQuotas } from '../hr-settings.util';
import { pgDateToIso } from '../pg-date.util';
import { withWrite } from '../db-tx';

export interface LeaveRow {
  id: UUID;
  employeeName: string;
  type: LeaveType;
  startDate: string;
  endDate: string;
  days: string;
  reason: string | null;
  status: LeaveStatus;
  attachmentId: string | null;
  decidedBy: string | null;
}

export interface LeaveQuota {
  annual: { total: number; used: number };
  marriage: { total: number; used: number };
}

const QUOTA_TYPES: readonly LeaveType[] = [LeaveType.ANNUAL, LeaveType.MARRIAGE];

/**
 * M14 `hr` — Leave / cuti & izin (F-HR-06, POUT-01/02/04). `leave_requests`
 * is class B — decisions route through `kernel/approvals` (D-08); step 1 is
 * the any-of {Supervisor, HR Admin} set `document-context.resolver.ts`
 * already encodes for `ApprovalDocumentType.LEAVE_REQUEST` (Manager gets in
 * via the engine's role-rank override, §5 preamble — no separate override
 * needed). `submit()` is given the employee's HOME location so a
 * Supervisor's "my pending approvals" (`GET /api/approvals/pending`)
 * actually surfaces it — CONTRACTS §5.10 / the kernel report both flag this.
 */
@Injectable()
export class LeavesService {
  constructor(
    private readonly approvals: ApprovalService,
    private readonly syncEmit: SyncEmitService,
  ) {}

  async list(
    client: PoolClient,
    locationId: string | undefined,
    status: LeaveStatus | undefined,
    type: LeaveType | undefined,
    employeeId: string | undefined,
    page = 1,
    pageSize = 50,
  ): Promise<Paginated<LeaveRow>> {
    const params: unknown[] = [];
    let where = '1=1';
    if (locationId) {
      params.push(locationId);
      where += ` AND e.location_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      where += ` AND lr.status = $${params.length}`;
    }
    if (type) {
      params.push(type);
      where += ` AND lr.type = $${params.length}`;
    }
    if (employeeId) {
      params.push(employeeId);
      where += ` AND lr.employee_id = $${params.length}`;
    }

    const countRes = await client.query<{ count: string }>(
      `SELECT COUNT(*) AS count FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id WHERE ${where}`,
      params,
    );
    const total = parseInt(countRes.rows[0]?.count ?? '0', 10);

    params.push(pageSize, (page - 1) * pageSize);
    const res = await client.query<Record<string, any>>(
      `SELECT lr.*, e.name AS employee_name, u.name AS decided_by_name
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN users u ON u.id = lr.decided_by
        WHERE ${where}
        ORDER BY lr.created_at DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    return { rows: res.rows.map(this.mapLeaveRow), total, page, pageSize };
  }

  async listMe(
    client: PoolClient,
    actorUserId: UUID,
    year?: string,
  ): Promise<{ rows: LeaveRow[]; quota: LeaveQuota }> {
    const employee = await this.resolveSelfEmployee(client, actorUserId);
    const params: unknown[] = [employee.id];
    let where = 'lr.employee_id = $1';
    if (year) {
      params.push(`${year}-01-01`, `${year}-12-31`);
      where += ` AND lr.start_date BETWEEN $2 AND $3`;
    }
    const res = await client.query<Record<string, any>>(
      `SELECT lr.*, e.name AS employee_name, u.name AS decided_by_name
         FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN users u ON u.id = lr.decided_by
        WHERE ${where}
        ORDER BY lr.start_date DESC`,
      params,
    );
    const quota = await this.getQuota(
      client,
      employee.id,
      year ?? String(new Date().getFullYear()),
    );
    return { rows: res.rows.map(this.mapLeaveRow), quota };
  }

  async submit(client: PoolClient, actorUserId: UUID, dto: SubmitLeaveDto): Promise<LeaveRow> {
    return withWrite(client, async () => {
      const leaveId = await this.insertAndSubmit(client, actorUserId, dto);

      const employee = await this.resolveSelfEmployee(client, actorUserId);
      await this.syncEmit.emit(client, {
        entity: 'leave_requests',
        op: 'submitted',
        entityId: leaveId,
        locationId: employee.locationId,
        actorUserId,
        data: {
          clientId: dto.clientId,
          type: dto.type,
          startDate: dto.startDate,
          endDate: dto.endDate,
          reason: dto.reason ?? null,
          attachmentId: dto.attachmentId ?? null,
        },
      });

      return this.getRowOrThrow(client, leaveId);
    });
  }

  /**
   * The shared core of `submit()` — no sync-event emission, so
   * `LeaveSyncProjector` can call this for an ALREADY-INGESTED
   * `leave_requests.submitted` fact without re-emitting a duplicate
   * cloud-origin event for something the device already pushed.
   *
   * `explicitId`: the offline path MUST use `event.entityId` (the DEVICE's
   * client-minted id, SYNC-PROTOCOL §2.1) as the row's primary key — a
   * later `leave_requests.cancelled`/`approved`/`rejected` fact references
   * the SAME `entityId`, so the row it decides must be the one this id
   * created. The online REST path has no such correlation need and mints
   * its own fresh id.
   */
  async insertAndSubmit(
    client: PoolClient,
    actorUserId: UUID,
    dto: SubmitLeaveDto,
    explicitId?: UUID,
  ): Promise<UUID> {
    const employee = await this.resolveSelfEmployee(client, actorUserId);

    const startDate = new Date(dto.startDate);
    const endDate = new Date(dto.endDate);
    if (
      Number.isNaN(startDate.getTime()) ||
      Number.isNaN(endDate.getTime()) ||
      endDate < startDate
    ) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'endDate must be on or after startDate',
      });
    }
    const days = Math.round((endDate.getTime() - startDate.getTime()) / 86_400_000) + 1;

    if (QUOTA_TYPES.includes(dto.type)) {
      const year = dto.startDate.slice(0, 4);
      const quota = await this.getQuota(client, employee.id, year);
      const bucket = dto.type === LeaveType.ANNUAL ? quota.annual : quota.marriage;
      if (bucket.used + days > bucket.total) {
        throw new BadRequestException({
          code: ERR_VALIDATION,
          message: `Requested ${days} day(s) exceeds remaining ${dto.type} quota (${bucket.total - bucket.used} of ${bucket.total} left)`,
          details: { quota: bucket, requestedDays: days },
        });
      }
    }

    // Idempotent replay (§2.2) — the exact same client_id already landed. Covers BOTH a retried REST
    // call and a re-projection sweep for the SAME `leave_requests.submitted` event.
    const existing = await client.query<{ id: UUID }>(
      'SELECT id FROM leave_requests WHERE client_id = $1',
      [dto.clientId],
    );
    if (existing.rows.length > 0) {
      return existing.rows[0]!.id;
    }

    const leaveId = explicitId ?? randomUUID();
    await client.query(
      `INSERT INTO leave_requests (id, employee_id, type, start_date, end_date, days, reason, attachment_id, client_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        leaveId,
        employee.id,
        dto.type,
        dto.startDate,
        dto.endDate,
        days,
        dto.reason ?? null,
        dto.attachmentId ?? null,
        dto.clientId,
      ],
    );

    // Ticket instruction: supply a REAL locationId here — the employee's home location — or the
    // supervisor's "my pending approvals" view will never show it (§5.10 / kernel report).
    const submitResult = await this.approvals.submit(client, {
      documentType: ApprovalDocumentType.LEAVE_REQUEST,
      documentId: leaveId,
      requestedBy: actorUserId,
      amount: null,
      locationId: employee.locationId,
    });

    await client.query('UPDATE leave_requests SET approval_id = $2 WHERE id = $1', [
      leaveId,
      submitResult.approvalId,
    ]);

    return leaveId;
  }

  async approve(
    client: PoolClient,
    actorUserId: UUID,
    actorRole: RoleKey,
    id: UUID,
    dto: ApproveLeaveDto,
  ): Promise<LeaveRow> {
    const leave = await this.requireLeave(client, id);

    return withWrite(client, async () => {
      const result = await this.approvals.approve(client, {
        documentType: ApprovalDocumentType.LEAVE_REQUEST,
        documentId: id,
        currentState: leave.status,
        actorUserId,
        actorRole,
        reason: dto.note ?? null,
      });

      await client.query(
        `UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = NOW() WHERE id = $1`,
        [id, result.nextState, actorUserId],
      );

      // POUT-01/02/04: an approved leave range marks `attendance.status` for those dates so payroll's
      // FR-HR-03 summary counts it as leave/sick/permission, not a silent absence.
      await client.query(
        `INSERT INTO attendance (employee_id, location_id, date, status)
         SELECT e.employee_id, e.loc, d::date, $4
           FROM (SELECT lr.employee_id, emp.location_id AS loc FROM leave_requests lr JOIN employees emp ON emp.id = lr.employee_id WHERE lr.id = $1) e
          CROSS JOIN LATERAL generate_series($2::date, $3::date, interval '1 day') AS d
         ON CONFLICT (employee_id, date) DO UPDATE SET status = EXCLUDED.status`,
        [id, leave.startDate, leave.endDate, this.attendanceStatusFor(leave.type)],
      );

      await this.syncEmit.emit(client, {
        entity: 'leave_requests',
        op: 'approved',
        entityId: id,
        locationId: null,
        actorUserId,
        data: { note: dto.note ?? undefined },
      });

      return this.getRowOrThrow(client, id);
    });
  }

  async reject(
    client: PoolClient,
    actorUserId: UUID,
    actorRole: RoleKey,
    id: UUID,
    dto: RejectLeaveDto,
  ): Promise<LeaveRow> {
    if (!dto.reason?.trim())
      throw new BadRequestException({ code: ERR_VALIDATION, message: 'reason is required' });
    const leave = await this.requireLeave(client, id);

    return withWrite(client, async () => {
      const result = await this.approvals.reject(client, {
        documentType: ApprovalDocumentType.LEAVE_REQUEST,
        documentId: id,
        currentState: leave.status,
        actorUserId,
        actorRole,
        reason: dto.reason,
      });

      await client.query(
        `UPDATE leave_requests SET status = $2, decided_by = $3, decided_at = NOW(), rejection_reason = $4 WHERE id = $1`,
        [id, result.nextState, actorUserId, dto.reason],
      );

      await this.syncEmit.emit(client, {
        entity: 'leave_requests',
        op: 'rejected',
        entityId: id,
        locationId: null,
        actorUserId,
        data: { reason: dto.reason },
      });

      return this.getRowOrThrow(client, id);
    });
  }

  async cancel(
    client: PoolClient,
    actorUserId: UUID,
    actorRole: RoleKey,
    id: UUID,
  ): Promise<LeaveRow> {
    return withWrite(client, async () => {
      const applied = await this.applyCancel(client, actorUserId, actorRole, id);
      if (applied) {
        await this.syncEmit.emit(client, {
          entity: 'leave_requests',
          op: 'cancelled',
          entityId: id,
          locationId: null,
          actorUserId,
          data: { id },
        });
      }
      return this.getRowOrThrow(client, id);
    });
  }

  /**
   * The shared core of `cancel()` — no sync-event emission (same reasoning
   * as `insertAndSubmit`'s doc comment). Returns `false` (a safe no-op,
   * NOT an error) when the leave is ALREADY cancelled — idempotency for a
   * re-projection sweep replaying the same `leave_requests.cancelled` fact,
   * since `ApprovalService.decide()` itself throws `ERR_APPROVAL_ALREADY_
   * DECIDED` on a non-pending approval rather than tolerating a replay.
   */
  async applyCancel(
    client: PoolClient,
    actorUserId: UUID,
    actorRole: RoleKey,
    id: UUID,
  ): Promise<boolean> {
    const leave = await this.requireLeave(client, id);
    if (leave.status === LeaveStatus.CANCELLED) return false; // idempotent replay — already applied

    if (leave.employeeUserId !== actorUserId) {
      throw new ForbiddenException({
        code: ERR_VALIDATION,
        message: 'Only the requesting employee may cancel this leave',
      });
    }
    if (leave.status !== LeaveStatus.PENDING) {
      throw new BadRequestException({
        code: ERR_VALIDATION,
        message: 'Only a pending leave request can be cancelled',
      });
    }

    const result = await this.approvals.cancel(client, {
      documentType: ApprovalDocumentType.LEAVE_REQUEST,
      documentId: id,
      currentState: leave.status,
      actorUserId,
      actorRole,
    });

    await client.query('UPDATE leave_requests SET status = $2 WHERE id = $1', [
      id,
      result.nextState,
    ]);
    return true;
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private attendanceStatusFor(type: LeaveType): string {
    if (type === LeaveType.SICK) return 'sick';
    if (type === LeaveType.PERMISSION) return 'permission';
    return 'leave'; // annual, marriage, unpaid
  }

  private async getQuota(client: PoolClient, employeeId: UUID, year: string): Promise<LeaveQuota> {
    const quotas = await getLeaveQuotas(client);
    const res = await client.query<{ type: LeaveType; used: string }>(
      `SELECT type, COALESCE(SUM(days), 0) AS used
         FROM leave_requests
        WHERE employee_id = $1 AND status IN ('pending','approved') AND type = ANY($2) AND EXTRACT(YEAR FROM start_date) = $3
        GROUP BY type`,
      [employeeId, QUOTA_TYPES, year],
    );
    const used = new Map(res.rows.map((r) => [r.type, Number(r.used)]));
    return {
      annual: { total: quotas.annual, used: used.get(LeaveType.ANNUAL) ?? 0 },
      marriage: { total: quotas.marriage, used: used.get(LeaveType.MARRIAGE) ?? 0 },
    };
  }

  /** Public — also used by `LeaveSyncProjector` to resolve `event.actorUserId` -> employee. */
  async resolveSelfEmployee(
    client: PoolClient,
    userId: UUID,
  ): Promise<{ id: UUID; locationId: UUID }> {
    const res = await client.query<{ id: UUID; location_id: UUID }>(
      'SELECT id, location_id FROM employees WHERE user_id = $1',
      [userId],
    );
    if (res.rows.length === 0) {
      throw new ForbiddenException({
        code: ERR_VALIDATION,
        message: 'This account has no linked employee record',
      });
    }
    return { id: res.rows[0]!.id, locationId: res.rows[0]!.location_id };
  }

  /**
   * Resolves the actor's REAL current role from `users`/`roles` — used by
   * `LeaveSyncProjector`, which must NOT trust `payload.meta.actorRole`
   * (informative only, SYNC-PROTOCOL §2.3: "role at the time of action...
   * cloud re-checks") for anything `ApprovalService`'s role-authorization
   * gate depends on.
   */
  async resolveActorRole(client: PoolClient, userId: UUID): Promise<RoleKey> {
    const res = await client.query<{ key: RoleKey }>(
      'SELECT r.key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1',
      [userId],
    );
    if (res.rows.length === 0) {
      throw new NotFoundException({
        code: ERR_NOT_FOUND,
        message: `No user found for actor ${userId}`,
      });
    }
    return res.rows[0]!.key;
  }

  private async requireLeave(
    client: PoolClient,
    id: UUID,
  ): Promise<{
    status: LeaveStatus;
    startDate: string;
    endDate: string;
    type: LeaveType;
    employeeUserId: UUID | null;
  }> {
    const res = await client.query<Record<string, any>>(
      `SELECT lr.status, lr.start_date, lr.end_date, lr.type, e.user_id
         FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id
        WHERE lr.id = $1`,
      [id],
    );
    if (res.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Leave request not found' });
    const r = res.rows[0]!;
    return {
      status: r.status,
      startDate: pgDateToIso(r.start_date),
      endDate: pgDateToIso(r.end_date),
      type: r.type,
      employeeUserId: r.user_id ?? null,
    };
  }

  private async getRowOrThrow(client: PoolClient, id: UUID): Promise<LeaveRow> {
    const res = await client.query<Record<string, any>>(
      `SELECT lr.*, e.name AS employee_name, u.name AS decided_by_name
         FROM leave_requests lr
         JOIN employees e ON e.id = lr.employee_id
         LEFT JOIN users u ON u.id = lr.decided_by
        WHERE lr.id = $1`,
      [id],
    );
    if (res.rows.length === 0)
      throw new NotFoundException({ code: ERR_NOT_FOUND, message: 'Leave request not found' });
    return this.mapLeaveRow(res.rows[0]!);
  }

  private mapLeaveRow = (r: Record<string, any>): LeaveRow => ({
    id: r.id,
    employeeName: r.employee_name,
    type: r.type,
    startDate: pgDateToIso(r.start_date),
    endDate: pgDateToIso(r.end_date),
    days: String(r.days),
    reason: r.reason ?? null,
    status: r.status,
    // The ATTACHMENT ID. The client turns it into a URL through
    // `/api/attachments/:id/url` (`lib/attachment-url.ts`), which is what the
    // previous comment here already described as the plan — but the query
    // selected `a.object_key`, so the field carried an S3 KEY instead. That
    // endpoint takes a UUID, so the documented call could never have worked,
    // and putting the key in an <img src>/<a href> resolves it against the
    // current page and 404s. Same defect that made the finance selfie and
    // payment-proof evidence invisible; `lr.attachment_id` is already in
    // `lr.*`, so the attachments join it needed is gone too.
    attachmentId: r.attachment_id ?? null,
    decidedBy: r.decided_by_name ?? null,
  });
}
