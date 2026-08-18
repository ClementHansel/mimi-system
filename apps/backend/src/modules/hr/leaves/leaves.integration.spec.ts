import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { Pool } from 'pg';
import { ApprovalService } from '../../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../../kernel/approvals/approvals.repository';
import { SyncEmitService } from '../../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../../kernel/sync/sync-conflicts.repository';
import { LeavesService } from './leaves.service';
import type { SubmitLeaveDto } from '../dto/leave.dto';
import {
  asRequest,
  closePool,
  loadHrFixtures,
  nextClientId,
  type HrFixtures,
} from '../test-support/live-db';
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
 *
 * BE-TXN-ROLLBACK: `LeavesService.submit`/`approve`/`reject`/`cancel` now
 * call `withWrite` (a REAL `BEGIN...COMMIT`) — see
 * `test-support/live-db.ts`'s `asRequest` doc comment for the full gotcha.
 * Every flow below that used to chain two-plus mutating calls (and actor
 * switches via `setRlsContext`) on ONE `withRollbackAs` transaction now opens
 * a SEPARATE `asRequest` connection per mutating call — one call = one
 * simulated HTTP request, exactly like `waste-return`/`stock-opname`'s own
 * integration suites already do. The one exception documented inline below:
 * a rejected `reject()`/`cancel()` call whose validation throws BEFORE ever
 * reaching `withWrite` does not itself end the transaction, so it may share
 * a connection with the ONE subsequent call that actually does.
 */
describe('LeavesService (integration, live Postgres)', () => {
  let fixtures: HrFixtures;
  let service: LeavesService;
  let approvals: ApprovalService;
  let dbAvailable = true;
  let ownerPool: Pool;
  // QA-ATTENDANCE-LEAK: every `submit()` below now commits for real (`withWrite`, BE-TXN-ROLLBACK)
  // instead of being discarded by `RlsCleanupInterceptor`'s old blanket ROLLBACK — so a leave request
  // that isn't deleted afterward permanently inflates `getQuota`'s per-year sum for this same
  // fixture employee. Two consecutive full-suite runs with no reset between them (this ticket's own
  // acceptance bar) reproduced exactly that: the annual/marriage quota tests below expected a fresh
  // `used: 0`/"11 days used" baseline and got the FIRST run's leftover rows added on top instead.
  // Every test that creates a `leave_requests` row pushes its id here; `afterEach` deletes it (and
  // its `approvals` row — no cascade either direction, per the FK note below) unconditionally, win
  // or fail, so nothing this file writes outlives the test that wrote it.
  const createdLeaveIds: string[] = [];

  beforeAll(async () => {
    try {
      fixtures = await loadHrFixtures();
      if (!fixtures.usersByRole[RoleKey.KASIR] || !fixtures.usersByRole[RoleKey.SUPERVISOR]) {
        dbAvailable = false;
        return;
      }
      // `SyncEventsRepository`/`SyncConflictsRepository` need a `Pool` for DI even though every call
      // `LeavesService` actually makes routes through the `client` (the RLS'd `PoolClient` from
      // `asRequest`/`withRollbackAs`), never this pool directly — mirrors production wiring without
      // pretending sync events aren't real (this DOES exercise `SyncEmitService.emit()` for real
      // against the live `sync_events` table, inside whichever connection is currently mutating).
      const pool = new Pool({
        connectionString:
          process.env.DATABASE_URL ??
          `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
      });
      await pool.query('SELECT 1');
      const eventsRepo = new SyncEventsRepository(pool);
      const conflictDetector = new ConflictDetectorService(
        eventsRepo,
        new SyncConflictsRepository(pool),
      );
      const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);
      approvals = new ApprovalService(new ApprovalsRepository());
      service = new LeavesService(approvals, syncEmit);
      // Owner/migration identity ONLY for this file's own test-writes cleanup (BYPASSRLS) — never
      // used to construct a service under test, matching every other live-DB harness's convention.
      ownerPool = new Pool({
        connectionString:
          process.env.DATABASE_MIGRATION_URL ??
          `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
      });
      await ownerPool.query('SELECT 1');
    } catch {
      dbAvailable = false;
    }
  });

  afterEach(async () => {
    if (!dbAvailable || createdLeaveIds.length === 0) return;
    for (const id of createdLeaveIds) {
      // Child-first: `leave_requests.approval_id` FKs to `approvals(id)` with NO cascade (same
      // ordering `sync-projector.integration.spec.ts`'s own cleanup already documents).
      await ownerPool.query('DELETE FROM leave_requests WHERE id = $1', [id]);
      await ownerPool.query('DELETE FROM approvals WHERE document_id = $1', [id]);
    }
    createdLeaveIds.length = 0;
  });

  afterAll(async () => {
    await ownerPool?.end().catch(() => {});
    await closePool();
  });

  it('submit -> the pending approval carries the employee HOME location, visible in the pending-approvals queue', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const hrAdmin = fixtures.usersByRole[RoleKey.HR_ADMIN];
    const kasirRls = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [kasir.locationId],
    };

    const dto: SubmitLeaveDto = {
      clientId: nextClientId(),
      type: LeaveType.PERMISSION,
      startDate: '2026-09-01',
      endDate: '2026-09-01',
      reason: 'Keperluan keluarga',
    };
    const leave = await asRequest(kasirRls, (client) => service.submit(client, kasir.userId, dto));
    createdLeaveIds.push(leave.id);
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
    //
    // A GENUINELY SEPARATE connection (real HR Admin session) — `submit`'s `withWrite` already
    // committed the leave + its approval row for real, so this new connection sees it.
    const hrAdminRls = {
      userId: hrAdmin?.userId ?? kasir.userId,
      roleKey: RoleKey.HR_ADMIN,
      locationIds: [],
    };
    const pending = await asRequest(hrAdminRls, (client) =>
      approvals.getPending(
        client,
        { userId: hrAdminRls.userId, roleKey: RoleKey.HR_ADMIN, locationIds: null },
        { page: 1, pageSize: 50 },
      ),
    );
    const found = pending.rows.find((r) => r.documentId === leave.id);
    expect(found).toBeDefined();
    expect(found?.locationId).toBe(kasir.locationId);
  });

  it('approve (SUPERVISOR) marks the leave approved, records the decider, and writes attendance.status for the date range', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR]!;
    const kasirRls = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [kasir.locationId],
    };
    const spvRls = {
      userId: spv.userId,
      roleKey: RoleKey.SUPERVISOR,
      locationIds: [kasir.locationId],
    };

    const dto: SubmitLeaveDto = {
      clientId: nextClientId(),
      type: LeaveType.SICK,
      startDate: '2026-09-05',
      endDate: '2026-09-06',
      reason: 'Demam',
    };
    const submitted = await asRequest(kasirRls, (client) =>
      service.submit(client, kasir.userId, dto),
    );
    createdLeaveIds.push(submitted.id);

    try {
      // A real approval is a SEPARATE request under the supervisor's OWN session/connection — proves
      // `submit`'s commit genuinely persisted (a still-open, uncommitted transaction from `submit`
      // would be invisible here) and matches how two real HTTP requests actually behave.
      const approved = await asRequest(spvRls, (client) =>
        service.approve(client, spv.userId, RoleKey.SUPERVISOR, submitted.id, {}),
      );
      expect(approved.status).toBe('approved');
      expect(approved.decidedBy).not.toBeNull();

      // A THIRD, still-different connection — proves `approve`'s attendance.status side effect also
      // genuinely committed, not merely visible within its own now-closed transaction.
      const attRows = await asRequest(spvRls, (client) =>
        client.query(
          `SELECT date, status FROM attendance WHERE employee_id = $1 AND date BETWEEN '2026-09-05' AND '2026-09-06' ORDER BY date`,
          [kasir.employeeId],
        ),
      );
      expect(attRows.rows.length).toBe(2);
      expect(attRows.rows.every((r) => r.status === 'sick')).toBe(true);
    } finally {
      // `approve`'s `attendance.status` side effect (BE-TXN-ROLLBACK: also a real commit) writes
      // rows keyed by (employee_id, date) — `afterEach`'s `createdLeaveIds` cleanup only knows about
      // `leave_requests`/`approvals`, so this test cleans up its OWN attendance side effect here,
      // same convention `attendance.integration.spec.ts`'s `withCleanSlate` uses for its own writes.
      await ownerPool.query(
        `DELETE FROM attendance WHERE employee_id = $1 AND date BETWEEN '2026-09-05' AND '2026-09-06'`,
        [kasir.employeeId],
      );
    }
  });

  it('reject requires a reason (FR-AUDIT-02) and is rejected with ERR_VALIDATION when omitted', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR]!;
    const kasirRls = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [kasir.locationId],
    };
    const spvRls = {
      userId: spv.userId,
      roleKey: RoleKey.SUPERVISOR,
      locationIds: [kasir.locationId],
    };

    const submitted = await asRequest(kasirRls, (client) =>
      service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.PERMISSION,
        startDate: '2026-09-10',
        endDate: '2026-09-10',
      }),
    );
    createdLeaveIds.push(submitted.id);

    // Both `reject` calls share ONE connection deliberately: the empty-reason attempt throws
    // `ERR_VALIDATION` BEFORE `reject()` ever calls `requireLeave`/`withWrite` — no transaction
    // boundary crosses, so the connection is still perfectly usable for the real (valid-reason)
    // rejection right after. See this file's header for why that's the one case this is safe.
    const rejected = await asRequest(spvRls, async (client) => {
      await expect(
        service.reject(client, spv.userId, RoleKey.SUPERVISOR, submitted.id, { reason: '' }),
      ).rejects.toMatchObject({
        response: { code: 'ERR_VALIDATION' },
      });
      return service.reject(client, spv.userId, RoleKey.SUPERVISOR, submitted.id, {
        reason: 'Jadwal padat',
      });
    });
    expect(rejected.status).toBe('rejected');
  });

  it('cancel is restricted to the requesting employee, pending only', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const otherKasir = fixtures.usersByRole[RoleKey.LEADER_OUTLET]; // a different employee at the same outlet, standing in for "not the requester"
    const kasirRls = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [kasir.locationId],
    };

    const submitted = await asRequest(kasirRls, (client) =>
      service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.PERMISSION,
        startDate: '2026-09-15',
        endDate: '2026-09-15',
      }),
    );
    createdLeaveIds.push(submitted.id);

    if (otherKasir) {
      // Deliberately still the REQUESTER's own RLS session (`kasirRls`) — this proves
      // `applyCancel`'s own JS-level "only the requesting employee" check (comparing
      // `leave.employeeUserId` to the `actorUserId` ARGUMENT), not RLS visibility. Passing
      // `otherKasir`'s identity as the actor argument while still reading under `kasir`'s own
      // session (which can see their own leave) is exactly what the original single-transaction
      // version of this test did — only the CONNECTION is new here, per BE-TXN-ROLLBACK
      // (`submit`'s `withWrite` above already ended the first connection's transaction).
      // `applyCancel`'s forbidden-actor check happens INSIDE `cancel()`'s `withWrite` (it needs a
      // read first to know the leave even exists), so this rejected attempt still ends its own
      // transaction on its own connection, same as any other `withWrite` call.
      await asRequest(kasirRls, (client) =>
        expect(
          service.cancel(client, otherKasir.userId, RoleKey.LEADER_OUTLET, submitted.id),
        ).rejects.toMatchObject({
          response: { code: 'ERR_VALIDATION' },
        }),
      );
    }

    const cancelled = await asRequest(kasirRls, (client) =>
      service.cancel(client, kasir.userId, RoleKey.KASIR, submitted.id),
    );
    expect(cancelled.status).toBe('cancelled');

    // Cancelling an ALREADY-cancelled leave is now a deliberate idempotent no-op (not an error) —
    // `LeaveSyncProjector` needs `applyCancel` to tolerate replaying the same `leave_requests
    // .cancelled` fact without throwing (`ApprovalService.decide()` itself throws
    // `ERR_APPROVAL_ALREADY_DECIDED` on a non-pending approval, which a naive replay would surface
    // as a spurious projection failure). The online path shares that same core, so a user double-
    // tapping "cancel" also just gets the same cancelled row back, not an error. A SEPARATE
    // connection: the first `cancel` above already committed for real.
    const cancelledAgain = await asRequest(kasirRls, (client) =>
      service.cancel(client, kasir.userId, RoleKey.KASIR, submitted.id),
    );
    expect(cancelledAgain.status).toBe('cancelled');
    expect(cancelledAgain.id).toBe(cancelled.id);
  });

  it('annual leave quota (12 days/year) is enforced — a request that would exceed the remaining balance is rejected', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const kasirRls = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [kasir.locationId],
    };

    // Each `submit()` call — success OR the quota rejection — runs its own `withWrite` and so ends
    // its own connection's transaction for real; three separate connections, not one shared one.
    const first = await asRequest(kasirRls, (client) =>
      service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.ANNUAL,
        startDate: '2027-01-05',
        endDate: '2027-01-15', // 11 days
      }),
    );
    createdLeaveIds.push(first.id);
    expect(first.days).toBe('11.0');

    // A second request for 2 more days this year exceeds the 12-day quota (11 + 2 > 12).
    await asRequest(kasirRls, (client) =>
      expect(
        service.submit(client, kasir.userId, {
          clientId: nextClientId(),
          type: LeaveType.ANNUAL,
          startDate: '2027-02-01',
          endDate: '2027-02-02',
        }),
      ).rejects.toMatchObject({ response: { code: 'ERR_VALIDATION' } }),
    );

    // Exactly the remaining 1 day is still fine.
    const second = await asRequest(kasirRls, (client) =>
      service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.ANNUAL,
        startDate: '2027-03-01',
        endDate: '2027-03-01',
      }),
    );
    createdLeaveIds.push(second.id);
    expect(second.days).toBe('1.0');
  });

  it('marriage leave quota is 3 days/year (POUT-04) — a 4-day request is rejected', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const kasirRls = {
      userId: kasir.userId,
      roleKey: RoleKey.KASIR,
      locationIds: [kasir.locationId],
    };

    await asRequest(kasirRls, (client) =>
      expect(
        service.submit(client, kasir.userId, {
          clientId: nextClientId(),
          type: LeaveType.MARRIAGE,
          startDate: '2028-06-01',
          endDate: '2028-06-04', // 4 days > 3-day quota
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'ERR_VALIDATION',
          details: expect.objectContaining({ quota: { total: 3, used: 0 } }),
        },
      }),
    );

    const ok = await asRequest(kasirRls, (client) =>
      service.submit(client, kasir.userId, {
        clientId: nextClientId(),
        type: LeaveType.MARRIAGE,
        startDate: '2028-06-01',
        endDate: '2028-06-03', // exactly 3 days
      }),
    );
    createdLeaveIds.push(ok.id);
    expect(ok.days).toBe('3.0');
  });

  // ── BE-TXN-ROLLBACK regression: writes must survive past the request that made them ──
  describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
    it('submit persists past its own request — a later listMe (new connection) finds it', async () => {
      if (!dbAvailable) return;
      const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
      const kasirRls = {
        userId: kasir.userId,
        roleKey: RoleKey.KASIR,
        locationIds: [kasir.locationId],
      };

      const submitted = await asRequest(kasirRls, (client) =>
        service.submit(client, kasir.userId, {
          clientId: nextClientId(),
          type: LeaveType.PERMISSION,
          startDate: '2026-10-01',
          endDate: '2026-10-01',
        }),
      );
      createdLeaveIds.push(submitted.id);
      expect(submitted.status).toBe('pending');

      // A GENUINELY separate connection — never sees `submit`'s connection's uncommitted state,
      // only what it actually COMMITted. If `submit` had never called `withWrite` (the original
      // bug), this read would come back empty.
      const { rows } = await asRequest(kasirRls, (client) =>
        service.listMe(client, kasir.userId, '2026'),
      );
      expect(rows.some((r) => r.id === submitted.id)).toBe(true);
    });
  });
});
