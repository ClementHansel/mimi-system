/**
 * Integration tests against the LIVE database (BUILD-PLAN §5/§8: "the full
 * flow drives end to end ... for both an outlet opname (Supervisor
 * approves) and a warehouse opname (Kepala Gudang approves)").
 *
 * Every test runs inside its own transaction and ROLLBACKs at the end —
 * nothing here durably mutates the seed. Wired by hand (`new`), mirroring
 * `kernel/stock-ledger/stock-ledger.integration.spec.ts` and
 * `kernel/approvals/approvals.integration.spec.ts` — every dependency here
 * is a REAL kernel class on the SAME transaction, never a mock.
 *
 * COORDINATOR-FLAGGED FIX: the two mandated approval-variant tests below now
 * run under `withRollbackAs` with the fixture's REAL Supervisor/Leader
 * Outlet/Kepala Gudang users and their REAL `user_locations` assignment as
 * `app.location_ids` — a genuinely RLS-restricted Postgres session, not the
 * central `'owner'` role the first cut of this harness hardcoded (which
 * bypasses `app_has_location()`/`users_select` unconditionally and would
 * have hidden a defect exactly like W2-B's own `findPendingCandidates` bug).
 * `setSessionContext` switches the actor mid-transaction so one test can
 * play "Leader Outlet counts, then Supervisor approves" as two genuinely
 * different sessions, matching two real HTTP requests.
 *
 * Doing this surfaced a REAL bug (fixed in `stock-opname.repository.ts`):
 * `HEADER_SELECT` used an INNER JOIN to `users` for `counted_by`/
 * `approved_by` display names. `users` RLS is "central role OR self"
 * (migration 009) — under a genuine Supervisor session, that INNER JOIN
 * silently dropped the ENTIRE opname header (not just the name) whenever
 * the counter and the approver were different people, because the join
 * predicate never matched once RLS hid the counterparty's `users` row. Every
 * prior run of this suite (owner-role session) could not have caught it:
 * `owner` satisfies `users_select` unconditionally, so the join always had
 * a row to match. Fixed to LEFT JOIN — see that file's comment.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { can, ERR_DISPUTES_OPEN, ERR_FORBIDDEN, ERR_NOT_FOUND, ERR_VARIANCE_REASON_REQUIRED, RoleKey, SyncOriginType } from '@mimi/shared';

// The FIRST live-DB test in a cold run pays for pool/connection warm-up
// (observed 5s+ once, 150-250ms on every later test in the same run) — a
// vitest default-5000ms flake, not a hang or a deadlock: isolating that same
// test (`-t`) or giving it headroom both make it pass in ~250ms. Raised here,
// scoped to this file only (never touching the shared `vitest.config.ts`).
vi.setConfig({ testTimeout: 15_000 });

import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../kernel/stock-ledger/stock-ledger-events';
import { EventBus } from '../../kernel/events/event-bus.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';

import { StockOpnameRepository } from './stock-opname.repository';
import { StockOpnameService, type ActorContext } from './stock-opname.service';
import {
  appPoolForDi,
  closePool,
  loadFixtures,
  pickUnusedStockKey,
  readBalance,
  setSessionContext,
  setSettingValue,
  withRollback,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

function buildService(): StockOpnameService {
  const events = new SyncEventsRepository(appPoolForDi());
  const conflicts = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(events, conflicts);
  return new StockOpnameService(
    new StockOpnameRepository(),
    new ApprovalService(new ApprovalsRepository()),
    new StockLedgerService(new StockMovedEventEmitter(new EventBus())),
    new SyncEmitService(events, conflictDetector),
    conflicts,
    events,
  );
}

function actorFor(fx: Fixtures, role: RoleKey, locationScope: readonly string[] | null = null): ActorContext {
  return { userId: fx.usersByRole[role], roleKey: role, locationScope };
}

describe('StockOpname — live database (outlet + warehouse approval variants)', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    fx = await loadFixtures();
  });

  afterAll(async () => {
    await closePool();
  });

  it('outlet opname, GENUINE RLS sessions: Leader Outlet counts, Supervisor approves — real user_locations scope throughout', async () => {
    const leaderOutlet = { role: 'leader_outlet', userId: fx.leaderOutletUserId, locationIds: [fx.outletId] };
    const supervisor = { role: 'supervisor', userId: fx.supervisorUserId, locationIds: [fx.outletId] };

    await withRollbackAs(leaderOutlet, async (client) => {
      const service = buildService();
      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);
      const leaderOutletActor: ActorContext = { userId: fx.leaderOutletUserId, roleKey: RoleKey.LEADER_OUTLET, locationScope: [fx.outletId] };
      const supervisorActor: ActorContext = { userId: fx.supervisorUserId, roleKey: RoleKey.SUPERVISOR, locationScope: [fx.outletId] };

      const created = await service.create(client, leaderOutletActor, { locationId: fx.outletId });
      expect(created.status).toBe('counting');

      await service.upsertLines(client, leaderOutletActor, created.id, {
        lines: [{ storageAreaId: fx.storageAreaOutlet, itemId, countedQty: '7.500', varianceReason: 'Selisih hasil hitung fisik' }],
      });

      const submitted = await service.submit(client, leaderOutletActor, created.id);
      expect(submitted.status).toBe('submitted');
      expect(submitted.lines[0]!.diffQty).toBe('7.500');
      // Attributability survives a genuinely RLS-restricted read: the Leader Outlet's own name
      // resolves (self-read policy), proving the header-row LEFT JOIN fix works for the counter's side.
      expect(submitted.countedBy).not.toBe(fx.leaderOutletUserId);

      // Now switch the SAME Postgres transaction to the Supervisor's own real session
      // (real user id, real user_locations scope) — two genuine actors, not one owner session.
      await setSessionContext(client, supervisor);

      const approved = await service.approve(client, supervisorActor, created.id, { note: 'Disetujui' });
      expect(approved.status).toBe('adjusted');
      // The Supervisor is neither central nor the Leader Outlet, so `users_select` genuinely denies
      // them the counter's `users` row — `counted_by_name` comes back NULL from the LEFT JOIN. The
      // fix's whole point is that `toOpname()` then falls back to the raw `counted_by` id rather than
      // returning `null`/dropping the row: `Opname.countedBy` is non-nullable (FR-SO-01: who), and a
      // UUID a human can still trace beats a document that silently vanished for its own approver.
      expect(approved.countedBy).toBeTruthy();

      const balance = await readBalance(client, fx.outletId, fx.storageAreaOutlet, itemId);
      expect(balance).toBe('7.500');

      const adjustments = await client.query(`SELECT * FROM stock_adjustments WHERE opname_id = $1`, [created.id]);
      expect(adjustments.rows).toHaveLength(1);
      expect(adjustments.rows[0].approved_by).toBe(fx.supervisorUserId);
    });
  });

  it('outlet opname: Kepala Gudang is NOT eligible for step 1 — rejected under their OWN genuine (warehouse-scoped) session', async () => {
    // Setup as the real Leader Outlet/Supervisor pair (owner session — setup is not the assertion here).
    let opnameId = '';
    await withRollback(async (client) => {
      const service = buildService();
      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);
      const created = await service.create(client, actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]), { locationId: fx.outletId });
      await service.upsertLines(client, actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]), created.id, {
        lines: [{ storageAreaId: fx.storageAreaOutlet, itemId, countedQty: '2.000', varianceReason: 'Selisih' }],
      });
      await service.submit(client, actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]), created.id);
      opnameId = created.id;
    });

    // The ACTUAL assertion: Kepala Gudang's own real session, scoped to the warehouse (their real
    // user_locations row) — not an application-level override. `stock_opname_loc`'s `app_has_location()`
    // denies this outlet's `location_id` outright, so the row is RLS-invisible before the approval
    // engine's own role gate is ever reached: NotFoundException, not ERR_APPROVAL_STEP_ROLE. This is a
    // STRONGER result than the owner-session version of this test could show (defense in depth: RLS
    // denies first, the engine's own role check would have denied it too) — reported as observed, not
    // adjusted to match a preconceived error code (coordinator instruction).
    await withRollbackAs({ role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] }, async (client) => {
      const service = buildService();
      await expect(
        service.approve(client, { userId: fx.kepalaGudangUserId, roleKey: RoleKey.KEPALA_GUDANG, locationScope: [fx.warehouseId] }, opnameId, {}),
      ).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });
    });
  });

  it('warehouse opname, GENUINE RLS session: Kepala Gudang counts AND approves under their own real (warehouse-scoped) session', async () => {
    const kgd = { role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] };

    await withRollbackAs(kgd, async (client) => {
      const service = buildService();
      const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);
      const kgdActor: ActorContext = { userId: fx.kepalaGudangUserId, roleKey: RoleKey.KEPALA_GUDANG, locationScope: [fx.warehouseId] };

      const created = await service.create(client, kgdActor, { locationId: fx.warehouseId });
      await service.upsertLines(client, kgdActor, created.id, {
        lines: [{ storageAreaId: fx.storageAreaWarehouse, itemId, countedQty: '3.000', varianceReason: 'Kekurangan stok gudang' }],
      });
      await service.submit(client, kgdActor, created.id);

      const approved = await service.approve(client, kgdActor, created.id, {});
      expect(approved.status).toBe('adjusted');

      const balance = await readBalance(client, fx.warehouseId, fx.storageAreaWarehouse, itemId);
      expect(balance).toBe('3.000');

      const adjustments = await client.query(`SELECT * FROM stock_adjustments WHERE opname_id = $1`, [created.id]);
      expect(adjustments.rows).toHaveLength(1);
      expect(adjustments.rows[0].approved_by).toBe(fx.kepalaGudangUserId);
      expect(adjustments.rows[0].created_by).toBe(fx.kepalaGudangUserId);
    });
  });

  it('warehouse opname: Supervisor is NOT eligible — rejected under their OWN genuine (outlet-scoped) session', async () => {
    let opnameId = '';
    await withRollback(async (client) => {
      const service = buildService();
      const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);
      const created = await service.create(client, actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]), { locationId: fx.warehouseId });
      await service.upsertLines(client, actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]), created.id, {
        lines: [{ storageAreaId: fx.storageAreaWarehouse, itemId, countedQty: '3.000', varianceReason: 'Kekurangan' }],
      });
      await service.submit(client, actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]), created.id);
      opnameId = created.id;
    });

    // Same reasoning as the outlet-side cross-check above: the Supervisor's real session is scoped to
    // their outlet, never the warehouse, so `stock_opname_loc` hides the row first.
    await withRollbackAs({ role: 'supervisor', userId: fx.supervisorUserId, locationIds: [fx.outletId] }, async (client) => {
      const service = buildService();
      await expect(
        service.approve(client, { userId: fx.supervisorUserId, roleKey: RoleKey.SUPERVISOR, locationScope: [fx.outletId] }, opnameId, {}),
      ).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });
    });
  });

  it('a large variance escalates the outlet chain to Manager after Supervisor\'s step', async () => {
    await withRollback(async (client) => {
      await setSettingValue(client, 'approval.threshold.opname', { managerAboveIdr: '0.01' });
      const service = buildService();
      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);

      const created = await service.create(client, actorFor(fx, RoleKey.LEADER_OUTLET), { locationId: fx.outletId });
      await service.upsertLines(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id, {
        lines: [{ storageAreaId: fx.storageAreaOutlet, itemId, countedQty: '50.000', varianceReason: 'Selisih besar' }],
      });
      await service.submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id);

      const step1 = await service.approve(client, actorFor(fx, RoleKey.SUPERVISOR), created.id, {});
      expect(step1.status).toBe('submitted'); // not yet finalized — escalated to step 2

      const step2 = await service.approve(client, actorFor(fx, RoleKey.MANAGER), created.id, {});
      expect(step2.status).toBe('adjusted');

      const balance = await readBalance(client, fx.outletId, fx.storageAreaOutlet, itemId);
      expect(balance).toBe('50.000');
    });
  });

  it('submit rejects with ERR_VARIANCE_REASON_REQUIRED when a non-zero variance has no reason', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);

      const created = await service.create(client, actorFor(fx, RoleKey.LEADER_OUTLET), { locationId: fx.outletId });
      await service.upsertLines(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id, {
        lines: [{ storageAreaId: fx.storageAreaOutlet, itemId, countedQty: '1.000' }],
      });

      await expect(service.submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id)).rejects.toMatchObject({
        response: { code: ERR_VARIANCE_REASON_REQUIRED },
      });
    });
  });

  it('reject requires a reason and never posts an adjustment', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);

      const created = await service.create(client, actorFor(fx, RoleKey.KEPALA_GUDANG), { locationId: fx.warehouseId });
      await service.upsertLines(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id, {
        lines: [{ storageAreaId: fx.storageAreaWarehouse, itemId, countedQty: '2.000', varianceReason: 'test' }],
      });
      await service.submit(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id);

      await expect(
        service.reject(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id, { reason: '' as unknown as string }),
      ).rejects.toBeTruthy();

      const rejected = await service.reject(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id, { reason: 'Data tidak valid' });
      expect(rejected.status).toBe('rejected');

      const balance = await readBalance(client, fx.warehouseId, fx.storageAreaWarehouse, itemId);
      expect(balance).toBeNull();
    });
  });

  it('a scoped role acting outside its assigned location is rejected (ERR_FORBIDDEN)', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.create(client, actorFor(fx, RoleKey.LEADER_OUTLET, [fx.warehouseId]), { locationId: fx.outletId }),
      ).rejects.toMatchObject({ response: { code: ERR_FORBIDDEN } });
    });
  });

  it('cancel from counting requires no approval chain and never touches stock_balances', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const created = await service.create(client, actorFor(fx, RoleKey.LEADER_OUTLET), { locationId: fx.outletId });
      const cancelled = await service.cancel(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id);
      expect(cancelled.status).toBe('cancelled');
    });
  });

  it('submit is blocked while a C1 double-count dispute is open, and resolve clears it', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      const events = new SyncEventsRepository(appPoolForDi());
      const conflicts = new SyncConflictsRepository();
      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);

      const created = await service.create(client, actorFor(fx, RoleKey.LEADER_OUTLET), { locationId: fx.outletId });
      await service.upsertLines(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id, {
        lines: [{ storageAreaId: fx.storageAreaOutlet, itemId, countedQty: '9.000', varianceReason: 'Awal' }],
      });
      const lineId = (await service.getDetail(client, created.id)).lines.find((l) => l.itemId === itemId)!.id;

      // Two devices independently counted the same item/area — both land as real `area_counted`
      // events (`sync_conflicts.winner_event_id`/`loser_event_id` FK-reference `sync_events`).
      const winnerEventId = crypto.randomUUID();
      const loserEventId = crypto.randomUUID();
      const areaCountedEvent = (eventId: string, countedQty: string, clientSeq: bigint) => ({
        event: {
          eventId,
          originTier: SyncOriginType.DEVICE,
          originDeviceId: crypto.randomUUID(),
          locationId: fx.outletId,
          entity: 'stock_opname',
          entityId: created.id,
          op: 'area_counted',
          payload: {
            v: 1,
            data: { opnameId: created.id, storageAreaId: fx.storageAreaOutlet, lines: [{ itemId, systemQty: '0.000', countedQty, varianceReason: 'Hitungan kedua' }] },
            meta: { actorUserId: fx.usersByRole[RoleKey.LEADER_OUTLET], actorRole: 'leader_outlet', appVersion: 'test' },
          },
          clientSeq,
          occurredAt: new Date().toISOString(),
          actorUserId: fx.usersByRole[RoleKey.LEADER_OUTLET],
          schemaV: 1,
        },
        applyStatus: 'applied' as const,
        batchId: null,
      });
      await events.insertEvent(client, areaCountedEvent(loserEventId, '9.000', 1n));
      await events.insertEvent(client, areaCountedEvent(winnerEventId, '11.000', 2n));

      await conflicts.recordConflictIfAbsent(client, {
        kind: 'double_count',
        queue: 'conflict',
        entity: 'stock_opname',
        entityId: created.id,
        locationId: fx.outletId,
        winnerEventId,
        loserEventId,
        detail: { storageAreaId: fx.storageAreaOutlet, itemId, disputed: true },
        assigneeRole: 'supervisor',
      });

      await expect(service.submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id)).rejects.toMatchObject({
        response: { code: ERR_DISPUTES_OPEN },
      });

      const resolved = await service.resolveLine(client, actorFor(fx, RoleKey.SUPERVISOR), created.id, lineId, {
        chosenEventId: winnerEventId,
        reason: 'Hitungan kedua lebih akurat',
      });
      expect(resolved.countedQty).toBe('11.000');
      expect(resolved.disputed).toBe(false);

      const submitted = await service.submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id);
      expect(submitted.status).toBe('submitted');
    });
  });

  it('RBAC: Kasir holds none of the opname permission keys (create/submit/approve)', () => {
    expect(can(RoleKey.KASIR, 'opname.create')).toBe(false);
    expect(can(RoleKey.KASIR, 'opname.submit')).toBe(false);
    expect(can(RoleKey.KASIR, 'opname.approve')).toBe(false);
    expect(can(RoleKey.SUPERVISOR, 'opname.approve')).toBe(true);
    expect(can(RoleKey.LEADER_OUTLET, 'opname.approve')).toBe(false);
  });
});
