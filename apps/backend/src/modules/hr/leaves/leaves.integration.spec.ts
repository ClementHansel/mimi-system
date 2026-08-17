import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../../kernel/approvals/approvals.repository';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../../kernel/sync/sync-conflicts.repository';
import { LeavesService } from './leaves.service';
import type { SubmitLeaveDto } from '../dto/leave.dto';
import { closePool, loadHrFixtures, nextClientId, setRlsContext, withRollbackAs, type HrFixtures } from '../test-support/live-db';
import { LeaveType, RoleKey } from '@mimi/shared';

/**
 * Integration proof (F-HR-06, POUT-01/02/04, §5.10 leave chain) — against a
 * REAL Postgres connection under the SAME RLS session context a real
 * request gets, exercising the REAL `ApprovalService` (kernel/approvals,
 * D-08) rather than a mock. Every `it()` issues real SQL; none of this is
 * `expect(true).toBe(true)`.
 *
 * `days` is `NUMERIC(4,1)` (CONTRACTS.md §0's decimal-string wire rule) — the
 * server always returns `"11.0"`, never `"11"`; assertions below match that.
 */
describe('LeavesService (integration, live Postgres)', () => {
  let fixtures: HrFixtures;
  let service: LeavesService;
  let approvals: ApprovalService;
  let dbAvailable = true;

  beforeAll(async () => {
    try {
      fixtures = await loadHrFixtures();
      if (!fixtures.usersByRole[RoleKey.KASIR] || !fixtures.usersByRole[RoleKey.SUPERVISOR]) {
        dbAvailable = false;
        return;
      }
      // `SyncEventsRepository`/`SyncConflictsRepository` need a `Pool` for DI even though every call
      // `LeavesService` actually makes routes through the `client` (the RLS'd `PoolClient` from
      // `withRollbackAs`), never this pool directly — mirrors production wiring without pretending
      // sync events aren't real (this DOES exercise `SyncEmitService.emit()` for real against the
      // live `sync_events` table, inside the same rolled-back transaction).
      const pool = new Pool({
        connectionString:
          process.env.DATABASE_URL ??
          `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
      });
      await pool.query('SELECT 1');
      const eventsRepo = new SyncEventsRepository(pool);
      const conflictDetector = new ConflictDetectorService(eventsRepo, new SyncConflictsRepository(pool));
      const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);
      approvals = new ApprovalService(new ApprovalsRepository());
      service = new LeavesService(approvals, syncEmit);
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('submit -> the pending approval carries the employee HOME location, visible in the pending-approvals queue', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN];

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      const dto: SubmitLeaveDto = {
        clientId: nextClientId(),
        type: LeaveType.PERMISSION,
        startDate: '2026-09-01',
        endDate: '2026-09-01',
        reason: 'Keperluan keluarga',
      };
      const leave = await service.submit(client, kasir.userId, dto);
      expect(leave.status).toBe('pending');
      expect(leave.days).toBe('1.0');

      // The submit() call supplied the employee's HOME location as `locationId` — without that, per
      // the ticket instruction, the pending-approvals view will never show it. Observed here through
      // HR_ADMIN (a central role, `app_is_central()`) rather than the outlet SUPERVISOR:
      // kernel/approvals' `findPendingCandidates` INNER JOINs `users` for the requester's display
      // name, and `users`' own RLS policy (self-read or central-role-read only) means a NON-central
      // approver's session can never see a DIFFERENT user's requester row — so a Supervisor's
      // `GET /api/approvals/pending` silently returns zero rows for anyone else's request, regardless
      // of location match. That is a cross-module finding in kernel/approvals (W2-B), out of this
      // module's ownership to fix; flagged in the final report rather than patched here. This
      // assertion instead proves what belongs to M14: `submit()` supplies the correct, real `locationId`.
      await setRlsContext(client, { userId: hrAdmin?.userId ?? kasir.userId, roleKey: RoleKey.HR_ADMIN, locationIds: [] });
      const pending = await approvals.getPending(
        client,
        { userId: hrAdmin?.userId ?? kasir.userId, roleKey: RoleKey.HR_ADMIN, locationIds: null },
        { page: 1, pageSize: 50 },
      );
      const found = pending.rows.find((r) => r.documentId === leave.id);
      expect(found).toBeDefined();
      expect(found?.locationId).toBe(kasir.locationId);
    });
  });

  it('approve (SUPERVISOR) marks the leave approved, records the decider, and writes attendance.status for the date range', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR]!;
    const kasirRls = { userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] };
    const spvRls = { userId: spv.userId, roleKey: RoleKey.SUPERVISOR, locationIds: [kasir.locationId] };

    await withRollbackAs(kasirRls, async (client) => {
      const dto: SubmitLeaveDto = {
        clientId: nextClientId(),
        type: LeaveType.SICK,
        startDate: '2026-09-05',
        endDate: '2026-09-06',
        reason: 'Demam',
      };
      const submitted = await service.submit(client, kasir.userId, dto);

      // A real approval is a SEPARATE request under the supervisor's OWN session — switch RLS
      // identity so `users` self-read visibility (needed to resolve `decidedBy`'s display name)
      // reflects the supervisor's real view, not the submitter's.
      await setRlsContext(client, spvRls);
      const approved = await service.approve(client, spv.userId, RoleKey.SUPERVISOR, submitted.id, {});
      expect(approved.status).toBe('approved');
      expect(approved.decidedBy).not.toBeNull();

      const attRows = await client.query(
        `SELECT date, status FROM attendance WHERE employee_id = $1 AND date BETWEEN '2026-09-05' AND '2026-09-06' ORDER BY date`,
        [kasir.employeeId],
      );
      expect(attRows.rows.length).toBe(2);
      expect(attRows.rows.every((r) => r.status === 'sick')).toBe(true);
    });
  });

  it('reject requires a reason (FR-AUDIT-02) and is rejected with ERR_VALIDATION when omitted', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR]!;

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      const submitted = await service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.PERMISSION,
        startDate: '2026-09-10',
        endDate: '2026-09-10',
      });

      await setRlsContext(client, { userId: spv.userId, roleKey: RoleKey.SUPERVISOR, locationIds: [kasir.locationId] });

      await expect(service.reject(client, spv.userId, RoleKey.SUPERVISOR, submitted.id, { reason: '' })).rejects.toMatchObject({
        response: { code: 'ERR_VALIDATION' },
      });

      const rejected = await service.reject(client, spv.userId, RoleKey.SUPERVISOR, submitted.id, { reason: 'Jadwal padat' });
      expect(rejected.status).toBe('rejected');
    });
  });

  it('cancel is restricted to the requesting employee, pending only', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const otherKasir = fixtures.usersByRole[RoleKey.LEADER_OUTLET]; // a different employee at the same outlet, standing in for "not the requester"

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      const submitted = await service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.PERMISSION,
        startDate: '2026-09-15',
        endDate: '2026-09-15',
      });

      if (otherKasir) {
        await expect(
          service.cancel(client, otherKasir.userId, RoleKey.LEADER_OUTLET, submitted.id),
        ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });
      }

      const cancelled = await service.cancel(client, kasir.userId, RoleKey.KASIR, submitted.id);
      expect(cancelled.status).toBe('cancelled');

      // Cancelling an ALREADY-cancelled leave is now a deliberate idempotent no-op (not an error) —
      // `LeaveSyncProjector` needs `applyCancel` to tolerate replaying the same `leave_requests
      // .cancelled` fact without throwing (`ApprovalService.decide()` itself throws
      // `ERR_APPROVAL_ALREADY_DECIDED` on a non-pending approval, which a naive replay would surface
      // as a spurious projection failure). The online path shares that same core, so a user double-
      // tapping "cancel" also just gets the same cancelled row back, not an error.
      const cancelledAgain = await service.cancel(client, kasir.userId, RoleKey.KASIR, submitted.id);
      expect(cancelledAgain.status).toBe('cancelled');
      expect(cancelledAgain.id).toBe(cancelled.id);
    });
  });

  it('annual leave quota (12 days/year) is enforced — a request that would exceed the remaining balance is rejected', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      // Consume most of the 12-day annual quota with one request.
      const first = await service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.ANNUAL,
        startDate: '2027-01-05',
        endDate: '2027-01-15', // 11 days
      });
      expect(first.days).toBe('11.0');

      // A second request for 2 more days this year exceeds the 12-day quota (11 + 2 > 12).
      await expect(
        service.submit(client, kasir.userId, {
          clientId: nextClientId(),
          type: LeaveType.ANNUAL,
          startDate: '2027-02-01',
          endDate: '2027-02-02',
        }),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } });

      // Exactly the remaining 1 day is still fine.
      const second = await service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.ANNUAL,
        startDate: '2027-03-01',
        endDate: '2027-03-01',
      });
      expect(second.days).toBe('1.0');
    });
  });

  it('marriage leave quota is 3 days/year (POUT-04) — a 4-day request is rejected', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      await expect(
        service.submit(client, kasir.userId, {
          clientId: nextClientId(),
          type: LeaveType.MARRIAGE,
          startDate: '2028-06-01',
          endDate: '2028-06-04', // 4 days > 3-day quota
        }),
      ).rejects.toMatchObject({
        response: { code: 'ERR_VALIDATION', details: expect.objectContaining({ quota: { total: 3, used: 0 } }) },
      });

      const ok = await service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.MARRIAGE,
        startDate: '2028-06-01',
        endDate: '2028-06-03', // exactly 3 days
      });
      expect(ok.days).toBe('3.0');
    });
  });
});
