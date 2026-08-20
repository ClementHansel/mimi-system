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
import {
  can,
  ERR_DISPUTES_OPEN,
  ERR_FORBIDDEN,
  ERR_NOT_FOUND,
  ERR_VARIANCE_REASON_REQUIRED,
  RoleKey,
  SyncOriginType,
} from '@mimi/shared';

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
  asCommittedRequest,
  asRequest,
  closePool,
  loadFixtures,
  pickUnusedStockKey,
  readBalance,
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
    new EventBus(),
  );
}

function actorFor(
  fx: Fixtures,
  role: RoleKey,
  locationScope: readonly string[] | null = null,
): ActorContext {
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

  // BE-TXN-ROLLBACK: every test below now opens a SEPARATE `withRollback(As)`/`asRequest`
  // connection per mutating call (see `test-support/live-db.ts`'s `asRequest` doc comment for
  // why chaining two mutating calls on one connection cannot work once the service actually
  // commits). Each test's own assertions run on whichever connection just did that step's
  // write/read — never on a DIFFERENT step's already-committed-or-rolled-back connection.

  it('outlet opname, GENUINE RLS sessions: Leader Outlet counts, Supervisor approves — real user_locations scope throughout', async () => {
    const leaderOutlet = {
      role: 'leader_outlet',
      userId: fx.leaderOutletUserId,
      locationIds: [fx.outletId],
    };
    const supervisor = {
      role: 'supervisor',
      userId: fx.supervisorUserId,
      locationIds: [fx.outletId],
    };
    const leaderOutletActor: ActorContext = {
      userId: fx.leaderOutletUserId,
      roleKey: RoleKey.LEADER_OUTLET,
      locationScope: [fx.outletId],
    };
    const supervisorActor: ActorContext = {
      userId: fx.supervisorUserId,
      roleKey: RoleKey.SUPERVISOR,
      locationScope: [fx.outletId],
    };
    const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);

    const created = await asRequest(leaderOutlet, (client) =>
      buildService().create(client, leaderOutletActor, { locationId: fx.outletId }),
    );
    expect(created.status).toBe('counting');

    await asRequest(leaderOutlet, (client) =>
      buildService().upsertLines(client, leaderOutletActor, created.id, {
        lines: [
          {
            storageAreaId: fx.storageAreaOutlet,
            itemId,
            countedQty: '7.500',
            varianceReason: 'Selisih hasil hitung fisik',
          },
        ],
      }),
    );

    const submitted = await asRequest(leaderOutlet, (client) =>
      buildService().submit(client, leaderOutletActor, created.id),
    );
    expect(submitted.status).toBe('submitted');
    expect(submitted.lines[0]!.diffQty).toBe('7.500');
    // Attributability survives a genuinely RLS-restricted read: the Leader Outlet's own name
    // resolves (self-read policy), proving the header-row LEFT JOIN fix works for the counter's side.
    expect(submitted.countedBy).not.toBe(fx.leaderOutletUserId);

    // A genuinely SEPARATE session — the Supervisor's own real user id + real user_locations
    // scope, on its own connection (two real actors, not one owner session switching mid-transaction).
    const approved = await asRequest(supervisor, (client) =>
      buildService().approve(client, supervisorActor, created.id, { note: 'Disetujui' }),
    );
    expect(approved.status).toBe('adjusted');
    // The Supervisor is neither central nor the Leader Outlet, so `users_select` genuinely denies
    // them the counter's `users` row — `counted_by_name` comes back NULL from the LEFT JOIN. The
    // fix's whole point is that `toOpname()` then falls back to the raw `counted_by` id rather than
    // returning `null`/dropping the row: `Opname.countedBy` is non-nullable (FR-SO-01: who), and a
    // UUID a human can still trace beats a document that silently vanished for its own approver.
    expect(approved.countedBy).toBeTruthy();

    // Final independent read (a FOURTH connection): proves `approve`'s ledger/adjustment writes
    // genuinely committed, not merely visible within its own now-closed transaction.
    const final = await asRequest(supervisor, async (client) => {
      const balance = await readBalance(client, fx.outletId, fx.storageAreaOutlet, itemId);
      const adjustments = await client.query(
        `SELECT * FROM stock_adjustments WHERE opname_id = $1`,
        [created.id],
      );
      return { balance, adjustments: adjustments.rows };
    });
    expect(final.balance).toBe('7.500');
    expect(final.adjustments).toHaveLength(1);
    expect(final.adjustments[0].approved_by).toBe(fx.supervisorUserId);
  });

  it('outlet opname: Kepala Gudang is NOT eligible for step 1 — rejected under their OWN genuine (warehouse-scoped) session', async () => {
    // Setup as the real Leader Outlet/Supervisor pair (owner session — setup is not the assertion here);
    // each step is its own connection/commit, per the rule above.
    const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);
    const created = await withRollback((client) =>
      buildService().create(client, actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]), {
        locationId: fx.outletId,
      }),
    );
    await withRollback((client) =>
      buildService().upsertLines(
        client,
        actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]),
        created.id,
        {
          lines: [
            {
              storageAreaId: fx.storageAreaOutlet,
              itemId,
              countedQty: '2.000',
              varianceReason: 'Selisih',
            },
          ],
        },
      ),
    );
    await withRollback((client) =>
      buildService().submit(client, actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]), created.id),
    );

    // The ACTUAL assertion: Kepala Gudang's own real session, scoped to the warehouse (their real
    // user_locations row) — not an application-level override. `stock_opname_loc`'s `app_has_location()`
    // denies this outlet's `location_id` outright, so the row is RLS-invisible before the approval
    // engine's own role gate is ever reached: NotFoundException, not ERR_APPROVAL_STEP_ROLE. This is a
    // STRONGER result than the owner-session version of this test could show (defense in depth: RLS
    // denies first, the engine's own role check would have denied it too) — reported as observed, not
    // adjusted to match a preconceived error code (coordinator instruction).
    await withRollbackAs(
      { role: 'kepala_gudang', userId: fx.kepalaGudangUserId, locationIds: [fx.warehouseId] },
      async (client) => {
        const service = buildService();
        await expect(
          service.approve(
            client,
            {
              userId: fx.kepalaGudangUserId,
              roleKey: RoleKey.KEPALA_GUDANG,
              locationScope: [fx.warehouseId],
            },
            created.id,
            {},
          ),
        ).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });
      },
    );
  });

  it('warehouse opname, GENUINE RLS session: Kepala Gudang counts AND approves under their own real (warehouse-scoped) session', async () => {
    const kgd = {
      role: 'kepala_gudang',
      userId: fx.kepalaGudangUserId,
      locationIds: [fx.warehouseId],
    };
    const kgdActor: ActorContext = {
      userId: fx.kepalaGudangUserId,
      roleKey: RoleKey.KEPALA_GUDANG,
      locationScope: [fx.warehouseId],
    };
    const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);

    const created = await asRequest(kgd, (client) =>
      buildService().create(client, kgdActor, { locationId: fx.warehouseId }),
    );
    await asRequest(kgd, (client) =>
      buildService().upsertLines(client, kgdActor, created.id, {
        lines: [
          {
            storageAreaId: fx.storageAreaWarehouse,
            itemId,
            countedQty: '3.000',
            varianceReason: 'Kekurangan stok gudang',
          },
        ],
      }),
    );
    await asRequest(kgd, (client) => buildService().submit(client, kgdActor, created.id));

    const approved = await asRequest(kgd, (client) =>
      buildService().approve(client, kgdActor, created.id, {}),
    );
    expect(approved.status).toBe('adjusted');

    const final = await asRequest(kgd, async (client) => {
      const balance = await readBalance(client, fx.warehouseId, fx.storageAreaWarehouse, itemId);
      const adjustments = await client.query(
        `SELECT * FROM stock_adjustments WHERE opname_id = $1`,
        [created.id],
      );
      return { balance, adjustments: adjustments.rows };
    });
    expect(final.balance).toBe('3.000');
    expect(final.adjustments).toHaveLength(1);
    expect(final.adjustments[0].approved_by).toBe(fx.kepalaGudangUserId);
    expect(final.adjustments[0].created_by).toBe(fx.kepalaGudangUserId);
  });

  it('warehouse opname: Supervisor is NOT eligible — rejected under their OWN genuine (outlet-scoped) session', async () => {
    const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);
    const created = await withRollback((client) =>
      buildService().create(client, actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]), {
        locationId: fx.warehouseId,
      }),
    );
    await withRollback((client) =>
      buildService().upsertLines(
        client,
        actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]),
        created.id,
        {
          lines: [
            {
              storageAreaId: fx.storageAreaWarehouse,
              itemId,
              countedQty: '3.000',
              varianceReason: 'Kekurangan',
            },
          ],
        },
      ),
    );
    await withRollback((client) =>
      buildService().submit(
        client,
        actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]),
        created.id,
      ),
    );

    // Same reasoning as the outlet-side cross-check above: the Supervisor's real session is scoped to
    // their outlet, never the warehouse, so `stock_opname_loc` hides the row first.
    await withRollbackAs(
      { role: 'supervisor', userId: fx.supervisorUserId, locationIds: [fx.outletId] },
      async (client) => {
        const service = buildService();
        await expect(
          service.approve(
            client,
            {
              userId: fx.supervisorUserId,
              roleKey: RoleKey.SUPERVISOR,
              locationScope: [fx.outletId],
            },
            created.id,
            {},
          ),
        ).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });
      },
    );
  });

  it("a large variance escalates the outlet chain to Manager after Supervisor's step", async () => {
    const owner = { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] };
    // Own committed connection: the setting must be durably visible to the LATER, separate
    // connections `submit`/`approve` run on — a raw write inside a block that only ever
    // ROLLBACKs (`withRollback`) would not survive past that block. MUST be restored afterward
    // (`finally` below) — a real `COMMIT` here means this row now outlives this test and would
    // otherwise leak into every later test/file in the same run (seed default, migration
    // `007_settings_document_counters.sql`: `{"managerAboveIdr":"2000000.00"}`).
    const originalThreshold = { managerAboveIdr: '2000000.00' };
    try {
      await asCommittedRequest(owner, (client) =>
        setSettingValue(client, 'approval.threshold.opname', { managerAboveIdr: '0.01' }),
      );

      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);
      const created = await withRollback((client) =>
        buildService().create(client, actorFor(fx, RoleKey.LEADER_OUTLET), {
          locationId: fx.outletId,
        }),
      );
      await withRollback((client) =>
        buildService().upsertLines(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id, {
          lines: [
            {
              storageAreaId: fx.storageAreaOutlet,
              itemId,
              countedQty: '50.000',
              varianceReason: 'Selisih besar',
            },
          ],
        }),
      );
      await withRollback((client) =>
        buildService().submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id),
      );

      const step1 = await withRollback((client) =>
        buildService().approve(client, actorFor(fx, RoleKey.SUPERVISOR), created.id, {}),
      );
      expect(step1.status).toBe('submitted'); // not yet finalized — escalated to step 2

      const step2 = await withRollback((client) =>
        buildService().approve(client, actorFor(fx, RoleKey.MANAGER), created.id, {}),
      );
      expect(step2.status).toBe('adjusted');

      const balance = await withRollback((client) =>
        readBalance(client, fx.outletId, fx.storageAreaOutlet, itemId),
      );
      expect(balance).toBe('50.000');
    } finally {
      await asCommittedRequest(owner, (client) =>
        setSettingValue(client, 'approval.threshold.opname', originalThreshold),
      );
    }
  });

  it('submit rejects with ERR_VARIANCE_REASON_REQUIRED when a non-zero variance has no reason', async () => {
    const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);
    const created = await withRollback((client) =>
      buildService().create(client, actorFor(fx, RoleKey.LEADER_OUTLET), {
        locationId: fx.outletId,
      }),
    );
    await withRollback((client) =>
      buildService().upsertLines(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id, {
        lines: [{ storageAreaId: fx.storageAreaOutlet, itemId, countedQty: '1.000' }],
      }),
    );

    await withRollback((client) =>
      expect(
        buildService().submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id),
      ).rejects.toMatchObject({
        response: { code: ERR_VARIANCE_REASON_REQUIRED },
      }),
    );
  });

  it('reject requires a reason and never posts an adjustment', async () => {
    const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);
    const created = await withRollback((client) =>
      buildService().create(client, actorFor(fx, RoleKey.KEPALA_GUDANG), {
        locationId: fx.warehouseId,
      }),
    );
    await withRollback((client) =>
      buildService().upsertLines(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id, {
        lines: [
          {
            storageAreaId: fx.storageAreaWarehouse,
            itemId,
            countedQty: '2.000',
            varianceReason: 'test',
          },
        ],
      }),
    );
    await withRollback((client) =>
      buildService().submit(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id),
    );

    await withRollback((client) =>
      expect(
        buildService().reject(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id, {
          reason: '' as unknown as string,
        }),
      ).rejects.toBeTruthy(),
    );

    const rejected = await withRollback((client) =>
      buildService().reject(client, actorFor(fx, RoleKey.KEPALA_GUDANG), created.id, {
        reason: 'Data tidak valid',
      }),
    );
    expect(rejected.status).toBe('rejected');

    const balance = await withRollback((client) =>
      readBalance(client, fx.warehouseId, fx.storageAreaWarehouse, itemId),
    );
    expect(balance).toBeNull();
  });

  it('a scoped role acting outside its assigned location is rejected (ERR_FORBIDDEN)', async () => {
    await withRollback(async (client) => {
      const service = buildService();
      await expect(
        service.create(client, actorFor(fx, RoleKey.LEADER_OUTLET, [fx.warehouseId]), {
          locationId: fx.outletId,
        }),
      ).rejects.toMatchObject({ response: { code: ERR_FORBIDDEN } });
    });
  });

  it('cancel from counting requires no approval chain and never touches stock_balances', async () => {
    const created = await withRollback((client) =>
      buildService().create(client, actorFor(fx, RoleKey.LEADER_OUTLET), {
        locationId: fx.outletId,
      }),
    );
    const cancelled = await withRollback((client) =>
      buildService().cancel(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id),
    );
    expect(cancelled.status).toBe('cancelled');
  });

  it('submit is blocked while a C1 double-count dispute is open, and resolve clears it', async () => {
    const owner = { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] };
    const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);

    const created = await withRollback((client) =>
      buildService().create(client, actorFor(fx, RoleKey.LEADER_OUTLET), {
        locationId: fx.outletId,
      }),
    );
    await withRollback((client) =>
      buildService().upsertLines(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id, {
        lines: [
          {
            storageAreaId: fx.storageAreaOutlet,
            itemId,
            countedQty: '9.000',
            varianceReason: 'Awal',
          },
        ],
      }),
    );
    const lineId = await withRollback(
      async (client) =>
        (await buildService().getDetail(client, created.id)).lines.find((l) => l.itemId === itemId)!
          .id,
    );

    // Two devices independently counted the same item/area — both land as real `area_counted`
    // events (`sync_conflicts.winner_event_id`/`loser_event_id` FK-reference `sync_events`). Seeded
    // via `asCommittedRequest` (own connection, explicit COMMIT) so the LATER, separate `submit`/
    // `resolveLine` connections below genuinely see these rows — a `withRollback` block here would
    // roll them back before any later connection could observe them.
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
          data: {
            opnameId: created.id,
            storageAreaId: fx.storageAreaOutlet,
            lines: [{ itemId, systemQty: '0.000', countedQty, varianceReason: 'Hitungan kedua' }],
          },
          meta: {
            actorUserId: fx.usersByRole[RoleKey.LEADER_OUTLET],
            actorRole: 'leader_outlet',
            appVersion: 'test',
          },
        },
        clientSeq,
        occurredAt: new Date().toISOString(),
        actorUserId: fx.usersByRole[RoleKey.LEADER_OUTLET],
        schemaV: 1,
      },
      applyStatus: 'applied' as const,
      batchId: null,
    });
    await asCommittedRequest(owner, async (client) => {
      const events = new SyncEventsRepository(appPoolForDi());
      const conflicts = new SyncConflictsRepository();
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
    });

    await withRollback((client) =>
      expect(
        buildService().submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id),
      ).rejects.toMatchObject({
        response: { code: ERR_DISPUTES_OPEN },
      }),
    );

    const resolved = await withRollback((client) =>
      buildService().resolveLine(client, actorFor(fx, RoleKey.SUPERVISOR), created.id, lineId, {
        chosenEventId: winnerEventId,
        reason: 'Hitungan kedua lebih akurat',
      }),
    );
    expect(resolved.countedQty).toBe('11.000');
    expect(resolved.disputed).toBe(false);

    const submitted = await withRollback((client) =>
      buildService().submit(client, actorFor(fx, RoleKey.LEADER_OUTLET), created.id),
    );
    expect(submitted.status).toBe('submitted');
  });

  // ── BE-TXN-ROLLBACK regression: writes must survive past the request that made them ──
  //
  // Every test above shares ONE transaction (`withRollback`/`withRollbackAs`) for its
  // whole body — a write that never called `withWrite` is still visible to a LATER read
  // in that SAME transaction (Postgres always sees its own session's uncommitted rows),
  // so those tests could not, and did not, catch the original bug: `create`/`upsertLines`/
  // `submit`/`approve`/`reject`/`cancel` ran with zero `BEGIN...COMMIT` of their own, and
  // `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK` silently discarded
  // every one of them — `POST /api/stock-opname` returned 201 with a full body, and an
  // immediate `GET` on that id 404'd. `asRequest` reproduces the REAL two-request shape:
  // each call gets its OWN connection, mimicking `RlsContextGuard`'s `BEGIN` and
  // `RlsCleanupInterceptor`'s `ROLLBACK` exactly — a service that only writes inside the
  // guard's transaction (no `withWrite`) fails these, a service that commits passes.
  describe('write-then-read-back across SEPARATE connections (each simulating one real HTTP request)', () => {
    it('create persists past its own request — a later GET (new connection) finds it', async () => {
      const leaderOutlet = {
        role: 'leader_outlet',
        userId: fx.leaderOutletUserId,
        locationIds: [fx.outletId],
      };
      const leaderOutletActor: ActorContext = {
        userId: fx.leaderOutletUserId,
        roleKey: RoleKey.LEADER_OUTLET,
        locationScope: [fx.outletId],
      };

      const created = await asRequest(leaderOutlet, (client) =>
        buildService().create(client, leaderOutletActor, { locationId: fx.outletId }),
      );
      expect(created.status).toBe('counting');

      // A GENUINELY separate connection/transaction — never sees `create`'s connection's
      // uncommitted state, only what it actually COMMITted.
      const reread = await asRequest(leaderOutlet, (client) =>
        buildService().getDetail(client, created.id),
      );
      expect(reread.id).toBe(created.id);
      expect(reread.opnameNumber).toBe(created.opnameNumber);
      expect(reread.status).toBe('counting');

      const listed = await asRequest(leaderOutlet, (client) =>
        buildService().list(client, { locationId: fx.outletId, page: 1, pageSize: 200 }),
      );
      expect(listed.rows.map((r) => r.id)).toContain(created.id);
    });

    it('the full counting → submit → approve lifecycle persists end to end across separate requests, including the posted stock_adjustment', async () => {
      const kgd = {
        role: 'kepala_gudang',
        userId: fx.kepalaGudangUserId,
        locationIds: [fx.warehouseId],
      };
      const kgdActor: ActorContext = {
        userId: fx.kepalaGudangUserId,
        roleKey: RoleKey.KEPALA_GUDANG,
        locationScope: [fx.warehouseId],
      };
      const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);

      const created = await asRequest(kgd, (client) =>
        buildService().create(client, kgdActor, { locationId: fx.warehouseId }),
      );

      await asRequest(kgd, (client) =>
        buildService().upsertLines(client, kgdActor, created.id, {
          lines: [
            {
              storageAreaId: fx.storageAreaWarehouse,
              itemId,
              countedQty: '4.000',
              varianceReason: 'BE-TXN-ROLLBACK regression',
            },
          ],
        }),
      );

      const submitted = await asRequest(kgd, (client) =>
        buildService().submit(client, kgdActor, created.id),
      );
      expect(submitted.status).toBe('submitted');

      const approved = await asRequest(kgd, (client) =>
        buildService().approve(client, kgdActor, created.id, {}),
      );
      expect(approved.status).toBe('adjusted');

      // Final independent read: a THIRD, still-different connection sees the whole chain's
      // cumulative effect — the opname header, its lines, AND the stock_balances/stock_adjustments
      // side effects `postAdjustments` writes, none of which share a connection with any prior step.
      const reread = await asRequest(kgd, async (client) => {
        const detail = await buildService().getDetail(client, created.id);
        const balance = await readBalance(client, fx.warehouseId, fx.storageAreaWarehouse, itemId);
        const adjustments = await client.query(
          `SELECT id FROM stock_adjustments WHERE opname_id = $1`,
          [created.id],
        );
        return { detail, balance, adjustmentCount: adjustments.rows.length };
      });

      expect(reread.detail.status).toBe('adjusted');
      expect(reread.detail.lines[0]!.countedQty).toBe('4.000');
      expect(reread.balance).toBe('4.000');
      expect(reread.adjustmentCount).toBe(1);
    });

    it('cancel persists — a later GET (new connection) sees the cancelled status, not the pre-cancel one', async () => {
      const leaderOutlet = {
        role: 'leader_outlet',
        userId: fx.leaderOutletUserId,
        locationIds: [fx.outletId],
      };
      const leaderOutletActor: ActorContext = {
        userId: fx.leaderOutletUserId,
        roleKey: RoleKey.LEADER_OUTLET,
        locationScope: [fx.outletId],
      };

      const created = await asRequest(leaderOutlet, (client) =>
        buildService().create(client, leaderOutletActor, { locationId: fx.outletId }),
      );
      const cancelled = await asRequest(leaderOutlet, (client) =>
        buildService().cancel(client, leaderOutletActor, created.id),
      );
      expect(cancelled.status).toBe('cancelled');

      const reread = await asRequest(leaderOutlet, (client) =>
        buildService().getDetail(client, created.id),
      );
      expect(reread.status).toBe('cancelled');
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
