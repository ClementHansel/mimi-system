/**
 * B-16 — "retur shipped -> journal" reachability, exercised end to end
 * against the LIVE database, real `ReturnService`, no mocks (kept separate
 * from `waste-return.integration.spec.ts`, which exercises the retur
 * lifecycle itself, and from `waste-gl-posting.spec.ts`, which is the waste
 * side of the same defect class).
 *
 * `ReturnService.ship()` now publishes `journal.action` right after the
 * `return_out` stock movement commits, for BOTH retur directions
 * (CONTRACTS.md §6.2, §5.5/§5.6):
 *
 *  - JOUT-05 `outlet_return_to_warehouse` — outlet→gudang leg — Dr 1120
 *    Persediaan Dalam Perjalanan / Cr 1110 Persediaan Outlet.
 *  - JGUD-04 `gudang_return_to_supplier` — gudang→supplier leg — Dr 2000
 *    Hutang Supplier / Cr 1100 Persediaan Gudang.
 *
 * The direction distinguishing the two IS `returns.direction` itself — the
 * same column `kernel/approvals`' `document-context.resolver.ts` already
 * reads to route this document's own approval step (SPV vs KGD) — never a
 * guess from a location's name/code.
 *
 * Same "real posting engine on its own connection" shape as
 * `waste-gl-posting.spec.ts`'s fixed test — see that file's header for why
 * this is safe even though `ReturnService.ship()` self-commits
 * (`db-tx.ts`'s `withWrite`): `resolvePureLegs`'s `outlet_return_to_warehouse`/
 * `gudang_return_to_supplier` legs need no cross-connection DB read, only the
 * `amount` already carried on the event payload.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JournalEventType, ReturnDirection, RoleKey } from '@mimi/shared';
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

import { ReturnRepository } from './return.repository';
import { ReturnService, type ActorContext } from './return.service';
import {
  appPoolForDi,
  closePool,
  createAttachment,
  deleteAttachment,
  ensureStock,
  loadFixtures,
  reconcileStockBalance,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';

function buildKit(eventBus: EventBus) {
  const events = new SyncEventsRepository(appPoolForDi());
  const conflicts = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(events, conflicts);
  const sync = new SyncEmitService(events, conflictDetector);
  const ledger = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));
  const approvals = new ApprovalService(new ApprovalsRepository());
  const returnService = new ReturnService(
    new ReturnRepository(),
    approvals,
    ledger,
    sync,
    eventBus,
  );
  return { returnService };
}

/** The REAL posting engine, subscribed to the SAME bus `ReturnService` publishes through — matches how `AccountingModule` wires it in production. */
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

/** Same shape as `waste-return.integration.spec.ts`'s `cleanupReturn` (reconcile the balance to
 * the fold of remaining movements, never blind-delete it), plus deleting whatever real
 * `journal_entries`/`journal_lines` this file's fix now produces — genuine commits via the
 * engine's own connection, never rolled back by the outer test transaction. */
async function cleanupReturn(id: string): Promise<void> {
  await cleanupPool.query(`UPDATE returns SET approval_id = NULL WHERE id = $1`, [id]);
  const keys = await cleanupPool.query<{
    location_id: string;
    storage_area_id: string;
    item_id: string;
  }>(
    `SELECT DISTINCT location_id, storage_area_id, item_id FROM stock_movements WHERE ref_type = 'return' AND ref_id = $1`,
    [id],
  );
  await cleanupPool.query(`DELETE FROM stock_movements WHERE ref_type = 'return' AND ref_id = $1`, [
    id,
  ]);
  for (const key of keys.rows)
    await reconcileStockBalance(key.location_id, key.storage_area_id, key.item_id);
  await cleanupPool.query(
    `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE ref_type = 'return' AND ref_id = $1)`,
    [id],
  );
  await cleanupPool.query(`DELETE FROM journal_entries WHERE ref_type = 'return' AND ref_id = $1`, [
    id,
  ]);
  await cleanupPool.query(
    `DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'return' AND document_id = $1)`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM approvals WHERE document_type = 'return' AND document_id = $1`,
    [id],
  );
  await cleanupPool.query(`DELETE FROM returns WHERE id = $1`, [id]);
}

/** Fetches the balanced Dr/Cr pair for one journal entry, asserting exactly two lines. */
async function journalLegsFor(
  entryId: string,
): Promise<{ code: string; debit: string; credit: string }[]> {
  const res = await cleanupPool.query<{ code: string; debit: string; credit: string }>(
    `SELECT a.code, l.debit, l.credit
       FROM journal_lines l
       JOIN chart_of_accounts a ON a.id = l.account_id
      WHERE l.entry_id = $1
      ORDER BY a.code`,
    [entryId],
  );
  return res.rows;
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Return shipment -> GL posting (B-16), live database',
  () => {
    let fx: Fixtures;
    const attachmentIds: string[] = [];
    const returnIds: string[] = [];

    beforeAll(async () => {
      fx = await loadFixtures();
    });

    // Stock is bootstrapped per TEST, not once per file.
    //
    // `ensureStock` writes `stock_balances` directly with no matching
    // `stock_movements` row (a documented test-bootstrap exception to D-07), and
    // this file's own `afterEach` cleanup calls `reconcileStockBalance`, which
    // resets the balance to the FOLD of remaining movements — deleting the
    // bootstrap along with the test's own rows. So with a single `beforeAll`
    // bootstrap, only the FIRST test in the file actually had stock; every later
    // one posted against the seed's fold and failed with
    // `StockInsufficientError` the moment that fold was below the quantity under
    // test. It looked like cross-file interference (and was masked for a while
    // by files racing in the parallel project, which sometimes left extra
    // balance lying around) — but the file was undermining itself.
    beforeEach(async () => {
      await ensureStock(fx.outletId, fx.storageAreaOutlet, fx.itemId, '100.000');
      await ensureStock(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId, '100.000');
    });

    afterEach(async () => {
      while (attachmentIds.length) await deleteAttachment(attachmentIds.pop()!);
      while (returnIds.length) await cleanupReturn(returnIds.pop()!);
    });

    afterAll(async () => {
      await reconcileStockBalance(fx.outletId, fx.storageAreaOutlet, fx.itemId);
      await reconcileStockBalance(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId);
      await cleanupPool.end();
      await closePool();
    });

    it('JOUT-05: outlet->gudang shipment posts Dr 1120 Dalam Perjalanan / Cr 1110 Persediaan Outlet', async () => {
      const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
      const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => {
        journalEvents.push(e);
      });

      const creationPhoto = await createAttachment(fx.leaderOutletUserId, 'defect_photo');
      attachmentIds.push(creationPhoto);

      const created = await withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.create(client, ldr, {
            direction: ReturnDirection.OUTLET_TO_WAREHOUSE,
            fromLocationId: fx.outletId,
            toLocationId: fx.warehouseId,
            lines: [
              {
                itemId: fx.itemId,
                storageAreaId: fx.storageAreaOutlet,
                qty: '2.000',
                condition: 'damaged' as never,
                reason: 'Kemasan rusak',
              },
            ],
            photoAttachmentIds: [creationPhoto],
          });
        },
      );
      returnIds.push(created.id);

      await withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.submit(client, ldr, created.id);
        },
      );

      await withRollbackAs(
        { role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.approve(client, spv, created.id, undefined);
        },
      );

      const proofShip = await createAttachment(fx.leaderOutletUserId, 'return_proof');
      attachmentIds.push(proofShip);
      const shipped = await withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.ship(client, ldr, created.id, { proofAttachmentIds: [proofShip] });
        },
      );
      expect(shipped.status).toBe('in_transit');

      expect(journalEvents).toHaveLength(1);
      expect(journalEvents[0]!.payload.eventType).toBe('outlet_return_to_warehouse');
      expect(journalEvents[0]!.payload.documentId).toBe(created.id);
      expect(journalEvents[0]!.payload.locationId).toBe(fx.outletId);

      const entryRows = await cleanupPool.query<{ id: string; event_type: string }>(
        `SELECT id, event_type FROM journal_entries WHERE ref_type = 'return' AND ref_id = $1`,
        [created.id],
      );
      expect(entryRows.rows).toHaveLength(1);
      expect(entryRows.rows[0]!.event_type).toBe('outlet_return_to_warehouse');

      const legs = await journalLegsFor(entryRows.rows[0]!.id);
      expect(legs).toHaveLength(2);
      const debit = legs.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = legs.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('1120'); // Persediaan Dalam Perjalanan
      expect(credit?.code).toBe('1110'); // Persediaan Outlet

      const line = await cleanupPool.query<{ qty: string; unit_cost: string }>(
        `SELECT qty, unit_cost FROM return_lines WHERE return_id = $1`,
        [created.id],
      );
      const expectedAmount = (Number(line.rows[0]!.qty) * Number(line.rows[0]!.unit_cost)).toFixed(
        2,
      );
      expect(debit?.debit).toBe(expectedAmount);
      expect(credit?.credit).toBe(expectedAmount);

      // Redelivery of the SAME event must never double-post (the journal's own
      // `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'`, not application logic).
      await eventBus.publish('journal.action', journalEvents[0]!.payload);
      const replay = await cleanupPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM journal_entries WHERE ref_type = 'return' AND ref_id = $1`,
        [created.id],
      );
      expect(replay.rows[0]!.count).toBe('1');
    });

    it('JGUD-02: warehouse receipt of an outlet return posts Dr 1100 Persediaan Gudang / Cr 1120 Dalam Perjalanan, clearing the in-transit leg', async () => {
      // The CLEARING half of JOUT-05 above. That test proves value leaves the
      // outlet into 1120; nothing proved it ever leaves 1120 again. If this
      // publish went missing, every returned rupiah would sit in Persediaan
      // Dalam Perjalanan forever while the physical stock sat on a warehouse
      // shelf — the balance sheet slowly accumulating goods that arrived
      // months ago, with no failing test anywhere. Stock still moves
      // (RETURN_IN posts through StockLedgerService), the return still reaches
      // 'received', and only the ledger is wrong.
      const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
      const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => {
        journalEvents.push(e);
      });

      const creationPhoto = await createAttachment(fx.leaderOutletUserId, 'defect_photo');
      attachmentIds.push(creationPhoto);

      const created = await withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.create(client, ldr, {
            direction: ReturnDirection.OUTLET_TO_WAREHOUSE,
            fromLocationId: fx.outletId,
            toLocationId: fx.warehouseId,
            lines: [
              {
                itemId: fx.itemId,
                storageAreaId: fx.storageAreaOutlet,
                qty: '2.000',
                condition: 'damaged' as never,
                reason: 'Kemasan rusak',
              },
            ],
            photoAttachmentIds: [creationPhoto],
          });
        },
      );
      returnIds.push(created.id);
      const lineId = created.lines[0]!.lineId;

      await withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.submit(client, ldr, created.id);
        },
      );
      await withRollbackAs(
        { role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.approve(client, spv, created.id, undefined);
        },
      );

      const proofShip = await createAttachment(fx.leaderOutletUserId, 'return_proof');
      attachmentIds.push(proofShip);
      await withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.ship(client, ldr, created.id, { proofAttachmentIds: [proofShip] });
        },
      );

      const proofReceive = await createAttachment(fx.kepalaGudangUserId, 'receiving_photo');
      attachmentIds.push(proofReceive);
      const received = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.receive(client, kgd, created.id, {
            lines: [{ lineId, qtyReceived: '2.000', storageAreaId: fx.storageAreaWarehouse }],
            proofAttachmentIds: [proofReceive],
          });
        },
      );
      expect(received.status).toBe('received');

      // Two events on this return now: the ship leg (JOUT-05) and this one.
      // Asserted by type rather than by index so a future third publish on the
      // same document fails loudly instead of shifting an index.
      const goodsIn = journalEvents.filter(
        (e) =>
          e.payload.eventType === JournalEventType.GUDANG_GOODS_IN &&
          e.payload.documentId === created.id,
      );
      expect(goodsIn).toHaveLength(1);
      expect(goodsIn[0]!.payload.documentType).toBe('return');
      expect(goodsIn[0]!.payload.locationId).toBe(fx.warehouseId);

      const entryRows = await cleanupPool.query<{ id: string; event_type: string }>(
        `SELECT id, event_type FROM journal_entries WHERE ref_type = 'return' AND ref_id = $1 AND event_type = 'gudang_goods_in'`,
        [created.id],
      );
      expect(entryRows.rows).toHaveLength(1);

      const legs = await journalLegsFor(entryRows.rows[0]!.id);
      expect(legs).toHaveLength(2);
      const debit = legs.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = legs.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('1100'); // Persediaan Gudang
      expect(credit?.code).toBe('1120'); // Persediaan Dalam Perjalanan

      // Valued from the SAME qty x unit_cost the ledger moved. This is the
      // property that makes 1120 actually clear: if the receive leg were
      // valued independently of the ship leg, the two would drift and the
      // in-transit account would keep a residue nobody could explain.
      const line = await cleanupPool.query<{ unit_cost: string }>(
        `SELECT unit_cost FROM return_lines WHERE id = $1`,
        [lineId],
      );
      const expectedAmount = (2 * Number(line.rows[0]!.unit_cost)).toFixed(2);
      expect(debit?.debit).toBe(expectedAmount);
      expect(credit?.credit).toBe(expectedAmount);

      // Same idempotency guarantee the ship leg has: redelivery must not
      // double-post (journal_entries' own UNIQUE, not application logic).
      await eventBus.publish('journal.action', goodsIn[0]!.payload);
      const replay = await cleanupPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM journal_entries WHERE ref_type = 'return' AND ref_id = $1 AND event_type = 'gudang_goods_in'`,
        [created.id],
      );
      expect(replay.rows[0]!.count).toBe('1');
    });

    it('JGUD-04: gudang->supplier shipment posts Dr 2000 Hutang Supplier / Cr 1100 Persediaan Gudang', async () => {
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => {
        journalEvents.push(e);
      });

      const creationPhoto = await createAttachment(fx.kepalaGudangUserId, 'defect_photo_supplier');
      attachmentIds.push(creationPhoto);

      const created = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.create(client, kgd, {
            direction: ReturnDirection.WAREHOUSE_TO_SUPPLIER,
            fromLocationId: fx.warehouseId,
            supplierId: fx.supplierId,
            lines: [
              {
                itemId: fx.itemId,
                storageAreaId: fx.storageAreaWarehouse,
                qty: '1.000',
                condition: 'quality' as never,
                reason: 'Kualitas tidak sesuai',
              },
            ],
            photoAttachmentIds: [creationPhoto],
          });
        },
      );
      returnIds.push(created.id);

      await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.submit(client, kgd, created.id);
        },
      );

      await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.approve(client, kgd, created.id, undefined);
        },
      );

      const proofShip = await createAttachment(fx.kepalaGudangUserId, 'return_proof_supplier');
      attachmentIds.push(proofShip);
      const shipped = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { returnService } = buildKit(eventBus);
          return returnService.ship(client, kgd, created.id, { proofAttachmentIds: [proofShip] });
        },
      );
      expect(shipped.status).toBe('in_transit');

      expect(journalEvents).toHaveLength(1);
      expect(journalEvents[0]!.payload.eventType).toBe('gudang_return_to_supplier');
      expect(journalEvents[0]!.payload.documentId).toBe(created.id);
      expect(journalEvents[0]!.payload.locationId).toBe(fx.warehouseId);

      const entryRows = await cleanupPool.query<{ id: string; event_type: string }>(
        `SELECT id, event_type FROM journal_entries WHERE ref_type = 'return' AND ref_id = $1`,
        [created.id],
      );
      expect(entryRows.rows).toHaveLength(1);
      expect(entryRows.rows[0]!.event_type).toBe('gudang_return_to_supplier');

      const legs = await journalLegsFor(entryRows.rows[0]!.id);
      expect(legs).toHaveLength(2);
      const debit = legs.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = legs.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('2000'); // Hutang Supplier
      expect(credit?.code).toBe('1100'); // Persediaan Gudang

      const line = await cleanupPool.query<{ qty: string; unit_cost: string }>(
        `SELECT qty, unit_cost FROM return_lines WHERE return_id = $1`,
        [created.id],
      );
      const expectedAmount = (Number(line.rows[0]!.qty) * Number(line.rows[0]!.unit_cost)).toFixed(
        2,
      );
      expect(debit?.debit).toBe(expectedAmount);
      expect(credit?.credit).toBe(expectedAmount);
    });
  },
);
