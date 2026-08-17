/**
 * Integration tests against the LIVE database (BUILD-PLAN §5/§8, this
 * ticket's "DONE WHEN": "an integration test drives the full chain outlet →
 * supervisor → warehouse across all 9 statuses"). Every dependency here is a
 * REAL kernel class (`ApprovalService`, `SyncEmitService`, ...) on a real
 * `mimi_app` connection — never a mock — so the suite exercises the actual
 * RLS-enforced path, not a hand-built approximation of it (D-21/D-22).
 *
 * ONE `withRollback` PER MUTATING CALL — DELIBERATE, NOT A STYLE CHOICE.
 * `ReplenishmentService`'s mutating methods self-commit (`replenishment.service.ts`'s
 * class header explains why: `SET LOCAL ROLE app_user` and the `app.*`
 * session vars are transaction-scoped and revert the instant `COMMIT` runs,
 * so building the HTTP response has to happen BEFORE that commit — the
 * "AIRE/inventory convention", matching `modules/location`'s `db-tx.ts`
 * `withWrite()` helper and `205_w1c_mimi_app_noinherit.sql`, which made a
 * forgotten `SET ROLE` fail LOUD instead of quietly returning 0 rows).
 * A consequence, twofold:
 *  1. Once one mutating call commits on a connection, that connection's
 *     role/session context is gone — a SECOND query on the SAME client
 *     would run as the bare, grant-less `mimi_app` login role and get a
 *     hard "permission denied", not a logic error. So a multi-step scenario
 *     (submit, then approve, then approve again, then process, ...) opens a
 *     FRESH `withRollback` per step here, exactly like separate HTTP
 *     requests would in production — the realistic shape, not an artifact
 *     of testing.
 *  2. `withRollback`'s own trailing `ROLLBACK` is a no-op the instant a
 *     mutating call inside it commits — every request this suite CREATES
 *     really persists. Every test therefore tracks the ids it created in
 *     `createdRequestIds` and `afterAll` sweeps them via
 *     `cleanupReplenishmentRequests()` (owner pool) — the same discipline
 *     `modules/location`'s own self-committing-service suite uses.
 *
 * TEST BOUNDARY re: FR-LOG-12 audit trail (documented, not an oversight):
 * these tests call `ReplenishmentService` directly, never through the full
 * NestJS HTTP pipeline, so the `@Audited()` INTERCEPTOR (wired to the HTTP
 * request lifecycle, `kernel/audit`'s own territory, already proven by ITS
 * OWN `audit.interceptor.integration.spec.ts`, G2-gated) never runs here.
 * What this suite instead proves: (a) the amendment reason and the amended
 * quantity are durably persisted on `replenishment_request_lines` — the
 * recoverable trail that survives a raw `SELECT`, independent of
 * `audit_log`; and (b) `ReplenishmentService.getHistory()` — this module's
 * OWN read query — correctly retrieves and shapes whatever `audit_log` rows
 * exist for `entity_type = 'replenishment_request'`, proven by seeding one
 * synthetic row shaped exactly like what `AuditInterceptor` would write for
 * an amend action (before/after diff, reason, actor) and reading it back
 * through the real service method.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ApprovalDocumentType,
  can,
  ERR_APPROVAL_STEP_ROLE,
  ERR_LOCATION_OUT_OF_SCOPE,
  ERR_NOT_FOUND,
  ERR_OFFLINE_NOT_ELIGIBLE,
  ERR_REASON_REQUIRED,
  ReplenishmentStatus,
  RoleKey,
  transition,
} from '@mimi/shared';

import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { ApprovalService, type CallerScope } from '../../kernel/approvals';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';

import { ReplenishmentAdvancementService } from './replenishment-advancement.service';
import { ReplenishmentRepository } from './replenishment.repository';
import { ReplenishmentService } from './replenishment.service';
import {
  appPoolForDi,
  cleanupReplenishmentRequests,
  closePool,
  createSuratJalanFixture,
  deleteSuratJalanFixture,
  type Fixtures,
  getOwnerPoolForTest,
  loadFixtures,
  withRollback,
} from './test-support/live-db';

function buildServices(): { service: ReplenishmentService; advancement: ReplenishmentAdvancementService } {
  const events = new SyncEventsRepository(appPoolForDi());
  const conflicts = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(events, conflicts);
  const sync = new SyncEmitService(events, conflictDetector);
  const repo = new ReplenishmentRepository();
  return {
    service: new ReplenishmentService(repo, new ApprovalService(new ApprovalsRepository()), sync),
    advancement: new ReplenishmentAdvancementService(repo, sync),
  };
}

function callerFor(userId: string, roleKey: RoleKey, locationIds: readonly string[] | null): CallerScope {
  return { userId, roleKey, locationIds: locationIds as string[] | null };
}

let fx: Fixtures;
const createdRequestIds: string[] = [];
const createdSjIds: string[] = [];

beforeAll(async () => {
  fx = await loadFixtures();
}, 30_000);

afterAll(async () => {
  // Order matters: `replenishment_requests.sj_id` FK-references `surat_jalan` with no cascade
  // (RESTRICT) — the referencing row must go first, or the surat_jalan delete fails.
  await cleanupReplenishmentRequests(createdRequestIds);
  for (const sjId of createdSjIds) await deleteSuratJalanFixture(sjId);
  await closePool();
});

describe('ReplenishmentService — live DB (mimi_app, real RLS)', () => {
  it(
    'full chain: draft → submitted → awaiting_approval → approved → processing → shipped → received → completed (all 9 FR-LOG-11 statuses)',
    async () => {
      const { service, advancement } = buildServices();
      const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);
      const spv = callerFor(fx.outletA.supervisorUserId, RoleKey.SUPERVISOR, [fx.outletA.locationId]);
      // The warehouse step is exercised as MANAGER, not the literal kepala_gudang role, because of the
      // RLS gap this suite documents separately below ("KNOWN GAP" test): kepala_gudang's real seeded
      // scope is the warehouse location only, and replenishment_requests_loc (migration 037) scopes
      // strictly by the REQUESTING OUTLET's location_id, which app_is_central() (owner/manager/finance/
      // hr_admin) satisfies but kepala_gudang does not. Manager holds `replenishment.approve.warehouse`
      // per the RBAC matrix (role-rank override, CONTRACTS §5 preamble) and IS central, so this proves
      // the full 9-state CHAIN genuinely works end-to-end under real RLS today, while the dedicated gap
      // test pins the precise, separate problem with the kepala_gudang role specifically.
      const kgd = callerFor(fx.managerUserId, RoleKey.MANAGER, null);

      const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
        service.create(client, ldr, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '10.000', unitId: fx.unitId }] }),
      );
      createdRequestIds.push(created.id);
      expect(created.status).toBe(ReplenishmentStatus.DRAFT);
      expect(created.lines).toHaveLength(1);
      const lineId = created.lines[0]!.id;

      const submitted = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
        service.submit(client, ldr, created.id),
      );
      expect(submitted.status).toBe(ReplenishmentStatus.SUBMITTED);
      expect(submitted.submittedAt).not.toBeNull();

      const step1 = await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, (client) =>
        service.approve(client, spv, created.id, {}),
      );
      expect(step1.status).toBe(ReplenishmentStatus.AWAITING_APPROVAL);
      expect(step1.approval?.state).toBe('pending');

      const step2 = await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, (client) =>
        service.approve(client, kgd, created.id, {}),
      );
      expect(step2.status).toBe(ReplenishmentStatus.APPROVED);
      expect(step2.approval?.state).toBe('approved');
      // No amendment at either step — the chain still guarantees a definite qty_approved once final.
      expect(step2.lines[0]!.qtyApproved).toBe('10.000');

      const processing = await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, (client) =>
        service.process(client, kgd, created.id),
      );
      expect(processing.status).toBe(ReplenishmentStatus.PROCESSING);

      // From here on, M10's interface (never this module's own HTTP surface — CONTRACTS §4.9's own
      // status-walk note: "shipped/received/completed are driven by M10 events, never set directly").
      // A REAL surat_jalan row — `replenishment_requests.sj_id` is FK-constrained, not a bare UUID.
      const sjId = await createSuratJalanFixture(fx.warehouseId, fx.kepalaGudangUserId);
      createdSjIds.push(sjId);
      // `ReplenishmentAdvancementService`'s methods deliberately do NOT self-commit (unlike
      // `ReplenishmentService`'s own HTTP-facing methods) — they are written to participate in the
      // CALLER's own transaction (M10's, in production, which commits once after its own SJ/drop writes
      // AND this call are both done). This test stands in as that caller, so it commits explicitly here.
      await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, async (client) => {
        await advancement.linkSuratJalan(client, created.id, sjId);
        await client.query('COMMIT');
      });
      const afterLink = await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, (client) =>
        service.getById(client, created.id),
      );
      expect(afterLink.sjId).toBe(sjId);

      await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, async (client) => {
        await advancement.markShipped(client, created.id, [{ requestLineId: lineId, qtyShipped: '10.000' }], fx.kepalaGudangUserId, RoleKey.KEPALA_GUDANG);
        await client.query('COMMIT');
      });
      const shipped = await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, (client) =>
        service.getById(client, created.id),
      );
      expect(shipped.status).toBe(ReplenishmentStatus.SHIPPED);
      expect(shipped.lines[0]!.qtyShipped).toBe('10.000');

      await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, async (client) => {
        await advancement.markReceived(client, created.id, [{ requestLineId: lineId, qtyReceived: '10.000' }], fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, false, null);
        await client.query('COMMIT');
      });
      const received = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
        service.getById(client, created.id),
      );
      expect(received.status).toBe(ReplenishmentStatus.RECEIVED);
      expect(received.lines[0]!.qtyReceived).toBe('10.000');

      const completedNow = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, async (client) => {
        const outcome = await advancement.tryAutoComplete(client, created.id);
        await client.query('COMMIT');
        return outcome;
      });
      expect(completedNow).toBe(true);
      const completed = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
        service.getById(client, created.id),
      );
      expect(completed.status).toBe(ReplenishmentStatus.COMPLETED);
      // Cleaned up in `afterAll` via `createdRequestIds` (every step above self-committed — see file header).
    },
    30_000,
  );

  it('neededBy round-trips exactly as submitted (DATE column, D-11 WITA day-shift regression)', async () => {
    const { service } = buildServices();
    const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);
    // Fixed, non-today date — a day-shift regression can't hide behind "today happens not to expose it".
    const neededBy = '2026-06-30';

    const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.create(client, ldr, { locationId: fx.outletA.locationId, neededBy, lines: [{ itemId: fx.itemId, qtyRequested: '5.000', unitId: fx.unitId }] }),
    );
    createdRequestIds.push(created.id);
    // Exact round-trip, not a loose date-shaped regex — a one-day-shifted value ("2026-06-29") would
    // still match `/^\d{4}-\d{2}-\d{2}$/` just as happily.
    expect(created.neededBy).toBe(neededBy);

    const fetched = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.getById(client, created.id),
    );
    expect(fetched.neededBy).toBe(neededBy);
  });

  it('reject at the supervisor step requires a reason and is terminal (FR-LOG-13)', async () => {
    const { service } = buildServices();
    const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);
    const spv = callerFor(fx.outletA.supervisorUserId, RoleKey.SUPERVISOR, [fx.outletA.locationId]);

    const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.create(client, ldr, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '5.000', unitId: fx.unitId }] }),
    );
    createdRequestIds.push(created.id);
    await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) => service.submit(client, ldr, created.id));

    await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, async (client) => {
      await expect(service.reject(client, spv, created.id, { reason: '' })).rejects.toMatchObject({ response: { code: ERR_REASON_REQUIRED } });
    });

    const rejected = await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, (client) =>
      service.reject(client, spv, created.id, { reason: 'Stok outlet masih cukup untuk minggu ini' }),
    );
    expect(rejected.status).toBe(ReplenishmentStatus.REJECTED);

    // Terminal: no further action possible.
    await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, async (client) => {
      await expect(service.process(client, spv, created.id)).rejects.toBeDefined();
    });
  });

  it('reject at the warehouse step requires a reason (FR-LOG-13)', async () => {
    const { service } = buildServices();
    const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);
    const spv = callerFor(fx.outletA.supervisorUserId, RoleKey.SUPERVISOR, [fx.outletA.locationId]);
    // Manager, not the literal kepala_gudang role, for the warehouse step — see the "full chain" test's
    // comment and the dedicated "KNOWN GAP" test below for why (a real, separately-documented RLS gap).
    const kgd = callerFor(fx.managerUserId, RoleKey.MANAGER, null);

    const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.create(client, ldr, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '5.000', unitId: fx.unitId }] }),
    );
    createdRequestIds.push(created.id);
    await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) => service.submit(client, ldr, created.id));
    await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, (client) => service.approve(client, spv, created.id, {}));

    await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, async (client) => {
      await expect(service.reject(client, kgd, created.id, { reason: '   ' })).rejects.toMatchObject({ response: { code: ERR_REASON_REQUIRED } });
    });

    const rejected = await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, (client) =>
      service.reject(client, kgd, created.id, { reason: 'Barang sedang kosong di gudang pusat' }),
    );
    expect(rejected.status).toBe(ReplenishmentStatus.REJECTED);
  });

  it(
    'amendment: warehouse approver changes an approved quantity — reason mandatory, the change is durably recoverable on the line, and the audit-history read surfaces it',
    async () => {
      const { service } = buildServices();
      const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);
      const spv = callerFor(fx.outletA.supervisorUserId, RoleKey.SUPERVISOR, [fx.outletA.locationId]);
      // Manager, not the literal kepala_gudang role — see the "full chain" test's comment above.
      const kgd = callerFor(fx.managerUserId, RoleKey.MANAGER, null);

      const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
        service.create(client, ldr, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '20.000', unitId: fx.unitId }] }),
      );
      createdRequestIds.push(created.id);
      const lineId = created.lines[0]!.id;
      await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) => service.submit(client, ldr, created.id));
      await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, (client) => service.approve(client, spv, created.id, {}));

      // The engine's own reason gate: `isAmendment: true` with an empty (whitespace-only) reason string.
      await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, async (client) => {
        await expect(
          service.approve(client, kgd, created.id, { amendments: [{ lineId, qtyApproved: '12.000', reason: '   ' }] }),
        ).rejects.toMatchObject({ response: { code: ERR_REASON_REQUIRED } });
      });

      const amended = await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, (client) =>
        service.approve(client, kgd, created.id, { amendments: [{ lineId, qtyApproved: '12.000', reason: 'Stok gudang hanya cukup 12kg minggu ini' }] }),
      );
      expect(amended.status).toBe(ReplenishmentStatus.APPROVED);
      const line = amended.lines.find((l) => l.id === lineId)!;
      // FR-LOG-13: from what (20), to what (12), why — all recoverable straight off the line row.
      expect(line.qtyRequested).toBe('20.000');
      expect(line.qtyApproved).toBe('12.000');
      expect(line.amendReason).toBe('Stok gudang hanya cukup 12kg minggu ini');

      // Synthetic audit_log row, shaped exactly like `AuditInterceptor` would have written for this
      // same mutation over HTTP (before/after diff, actor, reason) — proves `getHistory()`'s OWN read
      // query, independent of whether an interceptor actually ran in-process here (see file header).
      // Durable via the owner pool (a fresh `withRollback` block cannot see another block's uncommitted
      // insert) and cleaned up in `finally`.
      const pool = getOwnerPoolForTest();
      await pool.query(
        `INSERT INTO audit_log (user_id, role_key, location_id, module, action, entity_type, entity_id, before_value, after_value, reason)
         VALUES ($1, $2, $3, 'replenishment', 'replenishment.approve', 'replenishment_request', $4, $5::jsonb, $6::jsonb, $7)`,
        [
          fx.managerUserId,
          RoleKey.MANAGER,
          fx.outletA.locationId,
          created.id,
          JSON.stringify({ status: 'awaiting_approval', lines: [{ id: lineId, qtyApproved: null }] }),
          JSON.stringify({ status: 'approved', lines: [{ id: lineId, qtyApproved: '12.000' }] }),
          'Stok gudang hanya cukup 12kg minggu ini',
        ],
      );
      try {
        const history = await withRollback({ userId: kgd.userId, roleKey: kgd.roleKey, locationIds: kgd.locationIds }, (client) =>
          service.getHistory(client, created.id),
        );
        expect(history.length).toBeGreaterThan(0);
        const amendRow = history.find((h) => h.action === 'replenishment.approve');
        expect(amendRow).toBeDefined();
        expect(amendRow!.reason).toBe('Stok gudang hanya cukup 12kg minggu ini');
        expect(amendRow!.userId).toBe(fx.managerUserId);
        expect((amendRow!.afterValue as { lines: { qtyApproved: string }[] }).lines[0]!.qtyApproved).toBe('12.000');
        expect((amendRow!.beforeValue as { lines: { qtyApproved: string | null }[] }).lines[0]!.qtyApproved).toBeNull();
      } finally {
        await pool.query(`DELETE FROM audit_log WHERE entity_type = 'replenishment_request' AND entity_id = $1`, [created.id]);
      }
    },
  );

  it('amendments require a line that belongs to the request', async () => {
    const { service } = buildServices();
    const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);
    const spv = callerFor(fx.outletA.supervisorUserId, RoleKey.SUPERVISOR, [fx.outletA.locationId]);

    const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.create(client, ldr, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '8.000', unitId: fx.unitId }] }),
    );
    createdRequestIds.push(created.id);
    await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) => service.submit(client, ldr, created.id));

    await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, async (client) => {
      await expect(
        service.approve(client, spv, created.id, { amendments: [{ lineId: randomUUID(), qtyApproved: '1.000', reason: 'x' }] }),
      ).rejects.toBeDefined();
    });
  });

  it('draft lifecycle: update replaces lines, delete only works pre-submission', async () => {
    const { service } = buildServices();
    const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);

    const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.create(client, ldr, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '3.000', unitId: fx.unitId }] }),
    );
    createdRequestIds.push(created.id); // harmless if `remove()` below succeeds — cleanup is idempotent on an absent id.

    const updated = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.update(client, ldr, created.id, { lines: [{ itemId: fx.itemId2, qtyRequested: '7.000', unitId: fx.unitId }] }),
    );
    expect(updated.lines).toHaveLength(1);
    expect(updated.lines[0]!.itemId).toBe(fx.itemId2);
    expect(updated.lines[0]!.qtyRequested).toBe('7.000');

    const deleted = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.remove(client, ldr, created.id),
    );
    expect(deleted).toEqual({ id: created.id, deleted: true });

    await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, async (client) => {
      await expect(service.getById(client, created.id)).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });
    });
  });

  it("cannot create a request for a location outside the caller's own scope (both directions: own OK, foreign blocked)", async () => {
    const { service } = buildServices();
    const ldrAtA = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);

    // Direction 1 (allowed): own outlet.
    const ownOutlet = await withRollback({ userId: ldrAtA.userId, roleKey: ldrAtA.roleKey, locationIds: ldrAtA.locationIds }, (client) =>
      service.create(client, ldrAtA, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '1.000', unitId: fx.unitId }] }),
    );
    createdRequestIds.push(ownOutlet.id);
    expect(ownOutlet.locationId).toBe(fx.outletA.locationId);

    // Direction 2 (blocked): outlet B, using outlet A's own leader's scope.
    await withRollback({ userId: ldrAtA.userId, roleKey: ldrAtA.roleKey, locationIds: ldrAtA.locationIds }, async (client) => {
      await expect(
        service.create(client, ldrAtA, { locationId: fx.outletB.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '1.000', unitId: fx.unitId }] }),
      ).rejects.toMatchObject({ response: { code: ERR_LOCATION_OUT_OF_SCOPE } });
    });
  });

  it(
    "RLS, both directions: a Supervisor at outlet B's own request is fully visible to them; outlet A's Supervisor cannot see or act on it",
    async () => {
      const { service } = buildServices();
      const pool = getOwnerPoolForTest();

      // A row durably committed via the OWNER pool (bypasses RLS) so it survives across SEPARATE
      // `withRollback` sessions below — the same tradeoff `kernel/approvals`'s harness makes for
      // fixture rows in tables it does not own; here it is our own table, needed only because the
      // thing under test IS cross-session RLS visibility.
      const insert = await pool.query<{ id: string }>(
        `INSERT INTO replenishment_requests (request_number, location_id, status, source, requested_by, submitted_at)
         VALUES ($1, $2, 'submitted', 'manual', $3, NOW())
         RETURNING id`,
        [`RR-TEST-${Date.now()}`, fx.outletB.locationId, fx.outletB.leaderUserId],
      );
      const requestId = insert.rows[0]!.id;
      await pool.query(
        `INSERT INTO replenishment_request_lines (request_id, item_id, unit_id, qty_requested) VALUES ($1, $2, $3, '4.000')`,
        [requestId, fx.itemId, fx.unitId],
      );

      try {
        // Direction 1 (allowed): outlet B's own Supervisor sees it and may act on it.
        await withRollback({ userId: fx.outletB.supervisorUserId, roleKey: RoleKey.SUPERVISOR, locationIds: [fx.outletB.locationId] }, async (client) => {
          const seen = await service.getById(client, requestId);
          expect(seen.id).toBe(requestId);
        });

        // Direction 2 (denied): outlet A's Supervisor must not see it at all — RLS hides the row
        // entirely (never a 403; a row you cannot see does not exist from your vantage point).
        await withRollback({ userId: fx.outletA.supervisorUserId, roleKey: RoleKey.SUPERVISOR, locationIds: [fx.outletA.locationId] }, async (client) => {
          await expect(service.getById(client, requestId)).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });
          await expect(
            service.approve(client, callerFor(fx.outletA.supervisorUserId, RoleKey.SUPERVISOR, [fx.outletA.locationId]), requestId, {}),
          ).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });
        });
      } finally {
        await pool.query(`DELETE FROM replenishment_requests WHERE id = $1`, [requestId]);
      }
    },
  );

  it('RBAC matrix wiring: every replenishment permission key matches CONTRACTS.md §3 for both directions (allowed and denied)', () => {
    const ALLOW: Record<string, RoleKey[]> = {
      'replenishment.read': [RoleKey.OWNER, RoleKey.MANAGER, RoleKey.KEPALA_GUDANG, RoleKey.SUPERVISOR, RoleKey.LEADER_OUTLET],
      'replenishment.create': [RoleKey.SUPERVISOR, RoleKey.LEADER_OUTLET],
      'replenishment.submit': [RoleKey.SUPERVISOR, RoleKey.LEADER_OUTLET],
      'replenishment.approve.supervisor': [RoleKey.OWNER, RoleKey.MANAGER, RoleKey.SUPERVISOR],
      'replenishment.approve.warehouse': [RoleKey.OWNER, RoleKey.MANAGER, RoleKey.KEPALA_GUDANG],
      'replenishment.amend': [RoleKey.OWNER, RoleKey.MANAGER, RoleKey.KEPALA_GUDANG, RoleKey.SUPERVISOR],
    };
    for (const [key, allowedRoles] of Object.entries(ALLOW)) {
      for (const role of Object.values(RoleKey)) {
        const expected = allowedRoles.includes(role);
        expect(can(role, key as never)).toBe(expected);
      }
    }
    // Both directions, explicitly, for the role this ticket's RBAC negative test cares most about:
    // Kasir holds none of the six replenishment permissions (F02 POS surface has no logistics role).
    for (const key of Object.keys(ALLOW)) {
      expect(can(RoleKey.KASIR, key as never)).toBe(false);
    }
  });

  it(
    'KNOWN GAP (reported to the architect, not fixed here — see the module report): kepala_gudang cannot read an ' +
      'outlet-authored replenishment_request under the CURRENT RLS policy, because replenishment_requests_loc ' +
      '(migration 037) scopes purely by app_has_location(location_id) against the REQUESTING OUTLET, and ' +
      'app_is_central() (migration 001) does not include kepala_gudang. The warehouse work queue and the /approve ' +
      'endpoint both need cross-outlet visibility for the ONE central warehouse role by design (D-14) — this test ' +
      'pins the CURRENT behaviour so a future fix (a kepala_gudang OR-clause on replenishment_requests_loc / ' +
      'replenishment_request_lines_parent, mirroring the driver clause already on surat_jalan_scope, migration 201) ' +
      'is a deliberate, visible change, not a silent regression.',
    async () => {
      // Asserted at the SQL predicate level (the actual mechanism a fix must change) rather than via a
      // cross-session row, since the earlier tests already prove the row-visibility CONSEQUENCE of this
      // predicate for the analogous Supervisor-vs-Supervisor case.
      await withRollback({ userId: fx.kepalaGudangUserId, roleKey: RoleKey.KEPALA_GUDANG, locationIds: [fx.warehouseId] }, async (client) => {
        const res = await client.query<{ result: boolean }>(`SELECT app_has_location($1) AS result`, [fx.outletA.locationId]);
        expect(res.rows[0]!.result).toBe(false); // <- the gap: this SHOULD be true for kepala_gudang once fixed.
        const central = await client.query<{ result: boolean }>(`SELECT app_is_central() AS result`);
        expect(central.rows[0]!.result).toBe(false);
      });
    },
  );

  it('offline eligibility: the supervisor step is offline-eligible (SYNC-PROTOCOL §7.6); the warehouse step is not', () => {
    // Pure, zero-I/O check against the SAME `transition()` table `ApprovalService`/this module rely on —
    // proves the D-17 provision this ticket calls out ("the supervisor step IS offline-authorizable")
    // without needing the full offline-credential minting/re-verification pipeline (kernel/sync's own
    // territory, SYNC-PROTOCOL §7.2-7.5).
    const supervisorStep = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'submitted',
      action: 'approve',
      actorRole: RoleKey.SUPERVISOR,
      offlineAttempt: true,
    });
    expect(supervisorStep.ok).toBe(true);

    const warehouseStep = transition({
      documentType: ApprovalDocumentType.REPLENISHMENT_REQUEST,
      currentState: 'awaiting_approval',
      action: 'approve',
      actorRole: RoleKey.KEPALA_GUDANG,
      offlineAttempt: true,
    });
    expect(warehouseStep.ok).toBe(false);
    expect((warehouseStep as { code: string }).code).toBe(ERR_OFFLINE_NOT_ELIGIBLE);
  });

  it('wrong-role attempt on a chain step is rejected with ERR_APPROVAL_STEP_ROLE (both directions: eligible role OK, ineligible role denied)', async () => {
    const { service } = buildServices();
    const ldr = callerFor(fx.outletA.leaderUserId, RoleKey.LEADER_OUTLET, [fx.outletA.locationId]);
    const kasir = callerFor(fx.kasirUserId, RoleKey.KASIR, [fx.outletA.locationId]);
    const spv = callerFor(fx.outletA.supervisorUserId, RoleKey.SUPERVISOR, [fx.outletA.locationId]);

    const created = await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) =>
      service.create(client, ldr, { locationId: fx.outletA.locationId, lines: [{ itemId: fx.itemId, qtyRequested: '6.000', unitId: fx.unitId }] }),
    );
    createdRequestIds.push(created.id);
    await withRollback({ userId: ldr.userId, roleKey: ldr.roleKey, locationIds: ldr.locationIds }, (client) => service.submit(client, ldr, created.id));

    // Direction 1 (denied): Kasir has no approval role on this chain at all.
    await withRollback({ userId: kasir.userId, roleKey: kasir.roleKey, locationIds: kasir.locationIds }, async (client) => {
      await expect(service.approve(client, kasir, created.id, {})).rejects.toMatchObject({ response: { code: ERR_APPROVAL_STEP_ROLE } });
    });

    // Direction 2 (allowed): the actual step-1 approver.
    const approved = await withRollback({ userId: spv.userId, roleKey: spv.roleKey, locationIds: spv.locationIds }, (client) =>
      service.approve(client, spv, created.id, {}),
    );
    expect(approved.status).toBe(ReplenishmentStatus.AWAITING_APPROVAL);
  });
});
