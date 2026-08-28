/**
 * B-16 — proof that `StockOpnameService.approve()` now reaches the general
 * ledger as JOUT-06 (`outlet_stock_adjustment`) / JGUD-06
 * (`gudang_stock_adjustment`, CONTRACTS.md §6.2), against the LIVE database,
 * driving the REAL `StockOpnameService` (no mocks) — kept separate from
 * `stock-opname.integration.spec.ts` per this ticket's "new *.spec.ts only"
 * instruction, same convention `waste-gl-posting.spec.ts` established for
 * B-16.
 *
 * `StockOpnameService.approve()` self-commits (`db-tx.ts`'s `withWrite`), so
 * the `journal.action` event(s) it publishes are handled by the REAL
 * `PostingEngineService` on its OWN `withSystemContext` connection (same
 * cross-connection shape `waste-gl-posting.spec.ts`'s header explains) — the
 * resulting `journal_entries`/`journal_lines` rows are genuine commits, not
 * something this test's own rolled-back transaction ever undoes, so they are
 * cleaned up by hand in `afterEach`.
 *
 * Covers BOTH the overage and shortage branch for JOUT-06 (they post to
 * different accounts — an untested branch here is a wrong number in the
 * books, per this ticket's own instruction), plus JGUD-06 at the warehouse
 * so the gudang-vs-outlet routing (read from `locations.type`, never the
 * location's name) is proven end to end too.
 *
 * `attributable` is deliberately never exercised as `true` here —
 * `stock-opname.service.ts`'s own new doc comment on the emit call explains
 * why: whether a shortfall is attributable is a PAYROLL-time decision
 * (`runs/runs.service.ts`'s `computeStockShortfallShares`), not something
 * knowable at opname-approval time, so this wiring always passes
 * `attributable: false`. Flagged to the coordinator, not silently assumed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { businessDateOf, RoleKey } from '@mimi/shared';
import { Pool } from 'pg';

vi.setConfig({ testTimeout: 20_000 });

import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../kernel/stock-ledger/stock-ledger-events';
import { EventBus } from '../../kernel/events/event-bus.service';
import type { DomainEvent } from '../../kernel/events/domain-events';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { ChartOfAccountsService } from '../accounting/chart-of-accounts.service';
import { FiscalPeriodsService } from '../accounting/fiscal-periods.service';
import { JournalService } from '../accounting/journal.service';
import { PostingEngineService } from '../accounting/posting-engine.service';
import { formatDateOnly } from '../../common/date-only.util';
import { MovementType } from '@mimi/shared';

import { StockOpnameRepository } from './stock-opname.repository';
import { StockOpnameService, type ActorContext } from './stock-opname.service';
import {
  appPoolForDi,
  asCommittedRequest,
  asRequest,
  closePool,
  loadFixtures,
  pickUnusedStockKey,
  type Fixtures,
} from './test-support/live-db';

function buildService(eventBus: EventBus): StockOpnameService {
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
    eventBus,
  );
}

/** The REAL posting engine, subscribed to the SAME bus `StockOpnameService` publishes through. */
function buildEngine(pool: Pool, eventBus: EventBus): PostingEngineService {
  const journal = new JournalService(new ChartOfAccountsService(), new FiscalPeriodsService());
  const engine = new PostingEngineService(pool, eventBus, journal);
  engine.onModuleInit();
  return engine;
}

function actorFor(
  fx: Fixtures,
  role: RoleKey,
  locationScope: readonly string[] | null = null,
): ActorContext {
  return { userId: fx.usersByRole[role], roleKey: role, locationScope };
}

const cleanupPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ??
    `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
});

async function reconcileStockBalance(
  locationId: string,
  storageAreaId: string,
  itemId: string,
): Promise<void> {
  await cleanupPool.query(
    `UPDATE stock_balances
        SET qty_on_hand = COALESCE(
          (SELECT SUM(CASE WHEN m.movement_type LIKE '%_out' THEN -m.qty ELSE m.qty END)
             FROM stock_movements m
            WHERE m.location_id = stock_balances.location_id
              AND m.storage_area_id = stock_balances.storage_area_id
              AND m.item_id = stock_balances.item_id),
          0
        )
      WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [locationId, storageAreaId, itemId],
  );
}

/** Establishes a KNOWN starting balance via the REAL `StockLedgerService` (never a raw
 * `stock_balances` write — D-07), committed durably so the SEPARATE opname transaction can see it,
 * so a shortage test has real stock to be found missing. */
async function seedInitialStock(
  locationId: string,
  storageAreaId: string,
  itemId: string,
  qty: string,
  unitCost: string,
  ownerUserId: string,
): Promise<void> {
  await asCommittedRequest({ role: 'owner', userId: ownerUserId, locationIds: [] }, (client) => {
    const ledger = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));
    return ledger.post(
      client,
      [
        {
          locationId,
          storageAreaId,
          itemId,
          movementType: MovementType.PURCHASE_IN,
          qty,
          unitCost,
          refType: 'test_seed',
          refId: null,
          actorId: ownerUserId,
        },
      ],
      'strict',
    );
  });
}

async function cleanupOpname(
  opnameId: string,
  locationId: string,
  storageAreaId: string,
  itemId: string,
): Promise<void> {
  await cleanupPool.query(`UPDATE stock_opname SET approval_id = NULL WHERE id = $1`, [opnameId]);
  await cleanupPool.query(
    `DELETE FROM journal_lines WHERE entry_id IN (
       SELECT id FROM journal_entries WHERE ref_type = 'stock_adjustment'
         AND ref_id IN (SELECT id FROM stock_adjustments WHERE opname_id = $1))`,
    [opnameId],
  );
  await cleanupPool.query(
    `DELETE FROM journal_entries WHERE ref_type = 'stock_adjustment'
       AND ref_id IN (SELECT id FROM stock_adjustments WHERE opname_id = $1)`,
    [opnameId],
  );
  await cleanupPool.query(
    `DELETE FROM stock_movements WHERE ref_type = 'stock_adjustment'
       AND ref_id IN (SELECT id FROM stock_adjustments WHERE opname_id = $1)`,
    [opnameId],
  );
  // SCOPED to this test's own key. Unscoped, this deleted the `test_seed`
  // movements belonging to every OTHER key too — including those of a spec
  // running concurrently — stranding their balances and breaking G1
  // (`balance === fold(movements)`) for the rest of the run.
  await cleanupPool.query(
    `DELETE FROM stock_movements
      WHERE ref_type = 'test_seed'
        AND location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [locationId, storageAreaId, itemId],
  );
  // The movements above are gone; the BALANCE they moved is not, and deleting
  // one without the other is what breaks G1 (`balance === fold(movements)`)
  // for every suite that runs afterwards — a permanent, invisible drift that
  // made `stock-ledger.integration.spec.ts` fail on a database this spec had
  // merely been run against. Safe to delete outright rather than restore,
  // because `pickUnusedStockKey` guarantees this (location, area, item) had
  // NO balance row before the test created one.
  await cleanupPool.query(
    `DELETE FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [locationId, storageAreaId, itemId],
  );
  await cleanupPool.query(`DELETE FROM stock_adjustments WHERE opname_id = $1`, [opnameId]);
  await cleanupPool.query(
    `DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'stock_opname' AND document_id = $1)`,
    [opnameId],
  );
  await cleanupPool.query(
    `DELETE FROM approvals WHERE document_type = 'stock_opname' AND document_id = $1`,
    [opnameId],
  );
  await cleanupPool.query(`DELETE FROM stock_opname_lines WHERE opname_id = $1`, [opnameId]);
  await cleanupPool.query(`DELETE FROM stock_opname WHERE id = $1`, [opnameId]);
  await reconcileStockBalance(locationId, storageAreaId, itemId);
}

describe.skipIf(!process.env.DATABASE_URL)(
  'StockOpname.approve() — GL posting (B-16 JOUT-06/JGUD-06 stock adjustment), live database',
  () => {
    let fx: Fixtures;
    const opnameIds: { id: string; locationId: string; storageAreaId: string; itemId: string }[] =
      [];

    beforeAll(async () => {
      fx = await loadFixtures();
    }, 30_000);

    afterEach(async () => {
      while (opnameIds.length) {
        const o = opnameIds.pop()!;
        await cleanupOpname(o.id, o.locationId, o.storageAreaId, o.itemId);
      }
    });

    afterAll(async () => {
      await cleanupPool.end();
      await closePool();
    });

    it('FR-SO-03/FR-SO-04 — outlet OVERAGE (counted higher than system) posts Dr 1110 Persediaan Outlet / Cr 4100 Pendapatan Lainnya', async () => {
      const leader = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
      const supervisor = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);
      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);
      const unitCostRes = await cleanupPool.query<{ avg_cost: string }>(
        `SELECT avg_cost FROM items WHERE id = $1`,
        [itemId],
      );
      const unitCost = unitCostRes.rows[0]!.avg_cost;

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => journalEvents.push(e));

      const created = await asRequest(
        { role: 'leader_outlet', userId: leader.userId, locationIds: [fx.outletId] },
        (client) => buildService(eventBus).create(client, leader, { locationId: fx.outletId }),
      );
      opnameIds.push({
        id: created.id,
        locationId: fx.outletId,
        storageAreaId: fx.storageAreaOutlet,
        itemId,
      });

      await asRequest(
        { role: 'leader_outlet', userId: leader.userId, locationIds: [fx.outletId] },
        (client) =>
          buildService(eventBus).upsertLines(client, leader, created.id, {
            lines: [
              {
                storageAreaId: fx.storageAreaOutlet,
                itemId,
                countedQty: '5.000',
                varianceReason: 'Kelebihan stok tidak diketahui',
              },
            ],
          }),
      );
      await asRequest(
        { role: 'leader_outlet', userId: leader.userId, locationIds: [fx.outletId] },
        (client) => buildService(eventBus).submit(client, leader, created.id),
      );
      const approved = await asRequest(
        { role: 'supervisor', userId: supervisor.userId, locationIds: [fx.outletId] },
        (client) => buildService(eventBus).approve(client, supervisor, created.id, {}),
      );
      expect(approved.status).toBe('adjusted');

      const adjRow = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM stock_adjustments WHERE opname_id = $1`,
        [created.id],
      );
      const adjustmentId = adjRow.rows[0]!.id;

      const events = journalEvents.filter((e) => e.payload.eventType === 'outlet_stock_adjustment');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.documentId).toBe(adjustmentId);
      expect(events[0]!.payload.context).toEqual({ direction: 'overage', attributable: false });

      const expectedAmount = (5 * Number(unitCost)).toFixed(2);
      expect(events[0]!.payload.amount).toBe(expectedAmount);

      const entryRows = await cleanupPool.query<{
        id: string;
        event_type: string;
        location_id: string;
        entry_date: unknown;
      }>(
        `SELECT id, event_type, location_id, entry_date FROM journal_entries
          WHERE ref_type = 'stock_adjustment' AND ref_id = $1`,
        [adjustmentId],
      );
      expect(entryRows.rows).toHaveLength(1);
      expect(entryRows.rows[0]!.event_type).toBe('outlet_stock_adjustment');
      expect(entryRows.rows[0]!.location_id).toBe(fx.outletId);
      const todayWita = businessDateOf(new Date().toISOString());
      expect(formatDateOnly(entryRows.rows[0]!.entry_date)).toBe(todayWita);

      const lineRows = await cleanupPool.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit, l.credit
           FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY a.code`,
        [entryRows.rows[0]!.id],
      );
      expect(lineRows.rows).toHaveLength(2);
      const debit = lineRows.rows.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = lineRows.rows.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('1110'); // Persediaan Outlet
      expect(credit?.code).toBe('4100'); // Pendapatan Lainnya
      expect(debit?.debit).toBe(expectedAmount);
      expect(credit?.credit).toBe(expectedAmount);

      // Idempotency
      await eventBus.publish('journal.action', events[0]!.payload);
      const replay = await cleanupPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM journal_entries WHERE ref_type = 'stock_adjustment' AND ref_id = $1`,
        [adjustmentId],
      );
      expect(replay.rows[0]!.count).toBe('1');
    });

    it('outlet SHORTAGE (counted lower than system) posts Dr 6400 Beban Selisih Stok / Cr 1110 Persediaan Outlet', async () => {
      const leader = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
      const supervisor = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);
      const itemId = await pickUnusedStockKey(fx.outletId, fx.storageAreaOutlet);
      // `stock_adjustments.unit_cost` is frozen from `items.avg_cost` at count time (never the
      // arbitrary value a seed movement happens to carry — D-04: `StockLedgerService` never touches
      // `items.avg_cost`), so the expected amount MUST be derived from the item's real avg_cost, same
      // as the overage test above — never a hand-picked constant.
      const unitCostRes = await cleanupPool.query<{ avg_cost: string }>(
        `SELECT avg_cost FROM items WHERE id = $1`,
        [itemId],
      );
      const unitCost = unitCostRes.rows[0]!.avg_cost;
      await seedInitialStock(
        fx.outletId,
        fx.storageAreaOutlet,
        itemId,
        '10.000',
        unitCost,
        fx.usersByRole[RoleKey.OWNER],
      );

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => journalEvents.push(e));

      const created = await asRequest(
        { role: 'leader_outlet', userId: leader.userId, locationIds: [fx.outletId] },
        (client) => buildService(eventBus).create(client, leader, { locationId: fx.outletId }),
      );
      opnameIds.push({
        id: created.id,
        locationId: fx.outletId,
        storageAreaId: fx.storageAreaOutlet,
        itemId,
      });

      await asRequest(
        { role: 'leader_outlet', userId: leader.userId, locationIds: [fx.outletId] },
        (client) =>
          buildService(eventBus).upsertLines(client, leader, created.id, {
            lines: [
              {
                storageAreaId: fx.storageAreaOutlet,
                itemId,
                countedQty: '4.000',
                varianceReason: 'Kehilangan tidak diketahui',
              },
            ],
          }),
      );
      await asRequest(
        { role: 'leader_outlet', userId: leader.userId, locationIds: [fx.outletId] },
        (client) => buildService(eventBus).submit(client, leader, created.id),
      );
      const approved = await asRequest(
        { role: 'supervisor', userId: supervisor.userId, locationIds: [fx.outletId] },
        (client) => buildService(eventBus).approve(client, supervisor, created.id, {}),
      );
      expect(approved.status).toBe('adjusted');

      const adjRow = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM stock_adjustments WHERE opname_id = $1`,
        [created.id],
      );
      const adjustmentId = adjRow.rows[0]!.id;

      const events = journalEvents.filter((e) => e.payload.eventType === 'outlet_stock_adjustment');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.context).toEqual({ direction: 'shortage', attributable: false });
      // diff = 4.000 - 10.000 = -6.000 -> |6.000| * avg_cost (never a hardcoded number)
      const expectedAmount = (6 * Number(unitCost)).toFixed(2);
      expect(events[0]!.payload.amount).toBe(expectedAmount);

      const entryRows = await cleanupPool.query<{ id: string; event_type: string }>(
        `SELECT id, event_type FROM journal_entries WHERE ref_type = 'stock_adjustment' AND ref_id = $1`,
        [adjustmentId],
      );
      expect(entryRows.rows).toHaveLength(1);

      const lineRows = await cleanupPool.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit, l.credit
           FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY a.code`,
        [entryRows.rows[0]!.id],
      );
      const debit = lineRows.rows.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = lineRows.rows.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('6400'); // Beban Selisih Stok
      expect(credit?.code).toBe('1110'); // Persediaan Outlet
      expect(debit?.debit).toBe(expectedAmount);
      expect(credit?.credit).toBe(expectedAmount);
    });

    it('warehouse SHORTAGE posts Dr 6400 / Cr 1100 Persediaan Gudang, routed via `locations.type` (JGUD-06)', async () => {
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
      const itemId = await pickUnusedStockKey(fx.warehouseId, fx.storageAreaWarehouse);
      const unitCostRes = await cleanupPool.query<{ avg_cost: string }>(
        `SELECT avg_cost FROM items WHERE id = $1`,
        [itemId],
      );
      const unitCost = unitCostRes.rows[0]!.avg_cost;
      await seedInitialStock(
        fx.warehouseId,
        fx.storageAreaWarehouse,
        itemId,
        '8.000',
        unitCost,
        fx.usersByRole[RoleKey.OWNER],
      );

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => journalEvents.push(e));

      const created = await asRequest(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => buildService(eventBus).create(client, kgd, { locationId: fx.warehouseId }),
      );
      opnameIds.push({
        id: created.id,
        locationId: fx.warehouseId,
        storageAreaId: fx.storageAreaWarehouse,
        itemId,
      });

      await asRequest(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) =>
          buildService(eventBus).upsertLines(client, kgd, created.id, {
            lines: [
              {
                storageAreaId: fx.storageAreaWarehouse,
                itemId,
                countedQty: '5.000',
                varianceReason: 'Kekurangan gudang',
              },
            ],
          }),
      );
      await asRequest(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => buildService(eventBus).submit(client, kgd, created.id),
      );
      const approved = await asRequest(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => buildService(eventBus).approve(client, kgd, created.id, {}),
      );
      expect(approved.status).toBe('adjusted');

      const adjRow = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM stock_adjustments WHERE opname_id = $1`,
        [created.id],
      );
      const adjustmentId = adjRow.rows[0]!.id;

      const events = journalEvents.filter((e) => e.payload.eventType === 'gudang_stock_adjustment');
      expect(events).toHaveLength(1);
      expect(events[0]!.payload.context).toEqual({ direction: 'shortage' });
      // diff = 5.000 - 8.000 = -3.000 -> |3.000| * avg_cost (never a hardcoded number)
      const expectedAmount = (3 * Number(unitCost)).toFixed(2);
      expect(events[0]!.payload.amount).toBe(expectedAmount);

      const entryRows = await cleanupPool.query<{
        id: string;
        event_type: string;
        location_id: string;
      }>(
        `SELECT id, event_type, location_id FROM journal_entries WHERE ref_type = 'stock_adjustment' AND ref_id = $1`,
        [adjustmentId],
      );
      expect(entryRows.rows).toHaveLength(1);
      expect(entryRows.rows[0]!.event_type).toBe('gudang_stock_adjustment');
      expect(entryRows.rows[0]!.location_id).toBe(fx.warehouseId);

      const lineRows = await cleanupPool.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit, l.credit
           FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY a.code`,
        [entryRows.rows[0]!.id],
      );
      const debit = lineRows.rows.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = lineRows.rows.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('6400'); // Beban Selisih Stok
      expect(credit?.code).toBe('1100'); // Persediaan Gudang
      expect(debit?.debit).toBe(expectedAmount);
      expect(credit?.credit).toBe(expectedAmount);
    });
  },
);
