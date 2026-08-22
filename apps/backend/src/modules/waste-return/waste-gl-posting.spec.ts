/**
 * W6-04 (financial correctness) — "cold-chain breach → waste → journal path"
 * exercised end to end against the LIVE database, real `WasteService`, no
 * mocks (same wiring as `waste-return.integration.spec.ts`, which this file
 * is deliberately kept separate from per this ticket's "new *.spec.ts only"
 * constraint).
 *
 * The path IS reachable up through stock: `WasteReason.COLD_CHAIN_BREACH` is
 * a first-class reason code (`@mimi/shared`'s `enums.ts`), so a Kepala
 * Gudang/Leader Outlet can file a waste report citing a cold-chain breach,
 * a Supervisor/Manager approves it, and `WasteService.approve()` posts a
 * real `waste_out` stock movement (`stock-ledger`, D-07) for it — proven
 * below, positively.
 *
 * B-16 UPDATE (this ticket): the GL leg is now ALSO reachable.
 * `WasteService.approve()` publishes `journal.action` for JOUT-04
 * (`outlet_waste`) / JGUD-05 (`gudang_waste`) right after the stock movement
 * commits, per record in the approved batch (CONTRACTS.md §6.2). The second
 * test below used to PIN the broken (unreachable) behaviour; it now asserts
 * the real, balanced `journal_entries`/`journal_lines` rows the fix
 * produces — Dr 5100 Beban Waste / Cr 1100 Persediaan Gudang (warehouse) or
 * 1110 Persediaan Outlet (outlet), valued at the SAME qty × unit_cost as the
 * stock movement. Do not delete this file's history; it is the record of a
 * genuine correctness defect (see PROGRESS.md B-16) and its fix.
 *
 * The real `PostingEngineService` is used to actually post (not a
 * hand-rolled assertion of the event payload alone) — subscribed to the SAME
 * `EventBus` instance `WasteService` publishes through, exactly as
 * `AccountingModule` wires it in production (`onModuleInit`). Unlike
 * `daily-posting.spec.ts` (which must drive `postForEvent` with the test's
 * OWN client, because that service's data is never committed until the
 * test's rollback), this works via the engine's normal `withSystemContext`
 * path on a SEPARATE connection: `WasteService.approve()` self-commits
 * (`db-tx.ts`'s `withWrite`) same as every other mutating method in this
 * module (see `waste-return.integration.spec.ts`'s header for why), so the
 * approved waste record is already real, and `resolvePureLegs`'s
 * `gudang_waste`/`outlet_waste` legs need no cross-connection DB read (only
 * `amount` from the event payload) — there is nothing for a separate
 * connection to fail to see.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleKey, WasteReason } from '@mimi/shared';
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

import { WasteRepository } from './waste.repository';
import { WasteService, type ActorContext } from './waste.service';
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
  const wasteService = new WasteService(new WasteRepository(), approvals, ledger, sync, eventBus);
  return { wasteService };
}

/** The REAL posting engine, subscribed to the SAME bus `WasteService` publishes through — see the file header for why a separate connection is safe here. */
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

/** Same cleanup shape as `waste-return.integration.spec.ts` — see that file's header comment for
 * why the balance must be reconciled to the fold of remaining movements, never blind-deleted.
 * B-16: also deletes any real `journal_entries`/`journal_lines` this file's fix now produces —
 * those are genuine commits (the engine posts through its own connection), not something the
 * outer test transaction ever rolls back. */
async function cleanupWasteBatch(batchId: string): Promise<void> {
  const rows = await cleanupPool.query<{
    id: string;
    location_id: string;
    storage_area_id: string;
    item_id: string;
  }>(`SELECT id, location_id, storage_area_id, item_id FROM waste_records WHERE batch_id = $1`, [
    batchId,
  ]);
  for (const row of rows.rows) {
    await cleanupPool.query(`UPDATE waste_records SET approval_id = NULL WHERE id = $1`, [row.id]);
    await cleanupPool.query(
      `DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'waste' AND document_id = $1)`,
      [row.id],
    );
    await cleanupPool.query(
      `DELETE FROM approvals WHERE document_type = 'waste' AND document_id = $1`,
      [row.id],
    );
    await cleanupPool.query(
      `DELETE FROM journal_lines WHERE entry_id IN (SELECT id FROM journal_entries WHERE ref_type = 'waste_record' AND ref_id = $1)`,
      [row.id],
    );
    await cleanupPool.query(
      `DELETE FROM journal_entries WHERE ref_type = 'waste_record' AND ref_id = $1`,
      [row.id],
    );
    await cleanupPool.query(
      `DELETE FROM stock_movements WHERE ref_type = 'waste_record' AND ref_id = $1`,
      [row.id],
    );
    await reconcileStockBalance(row.location_id, row.storage_area_id, row.item_id);
  }
  await cleanupPool.query(`DELETE FROM waste_records WHERE batch_id = $1`, [batchId]);
}

describe.skipIf(!process.env.DATABASE_URL)(
  'Waste (cold-chain breach reason) — GL posting reachability, live database',
  () => {
    let fx: Fixtures;
    const attachmentIds: string[] = [];
    const batchIds: string[] = [];

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
      await ensureStock(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId, '50.000');
    });

    afterEach(async () => {
      while (attachmentIds.length) await deleteAttachment(attachmentIds.pop()!);
      while (batchIds.length) await cleanupWasteBatch(batchIds.pop()!);
    });

    afterAll(async () => {
      await reconcileStockBalance(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId);
      await cleanupPool.end();
      await closePool();
    });

    it('control: a COLD_CHAIN_BREACH waste report, once approved, DOES post a real waste_out stock movement and decrement the warehouse balance', async () => {
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

      const photoId = await createAttachment(fx.kepalaGudangUserId, 'cold_chain_breach_photo');
      attachmentIds.push(photoId);

      const before = await withRollbackAs(
        { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
        (client) =>
          client.query<{ qty_on_hand: string }>(
            `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
            [fx.warehouseId, fx.storageAreaWarehouse, fx.itemId],
          ),
      );

      const created = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit(new EventBus());
          return wasteService.create(client, kgd, {
            locationId: fx.warehouseId,
            items: [
              {
                storageAreaId: fx.storageAreaWarehouse,
                itemId: fx.itemId,
                qty: '4.000',
                reason: WasteReason.COLD_CHAIN_BREACH,
                reasonDetail: 'Reefer excursion above -15C on SJ (see sj_temperature_logs)',
              },
            ],
            photoAttachmentIds: [photoId],
          });
        },
      );
      batchIds.push(created[0]!.batchId);
      expect(created[0]!.reason).toBe(WasteReason.COLD_CHAIN_BREACH);

      // Kepala Gudang's own approval role for a warehouse waste batch, per this module's approval
      // routing (mirrors the leader_outlet -> supervisor pairing `waste-return.integration.spec.ts`
      // uses for the outlet side).
      const approved = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit(new EventBus());
          return wasteService.approve(client, kgd, created[0]!.batchId, {});
        },
      );
      expect(approved[0]!.status).toBe('approved');

      const after = await withRollbackAs(
        { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
        (client) =>
          client.query<{ qty_on_hand: string }>(
            `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
            [fx.warehouseId, fx.storageAreaWarehouse, fx.itemId],
          ),
      );
      expect(Number(before.rows[0]!.qty_on_hand) - Number(after.rows[0]!.qty_on_hand)).toBeCloseTo(
        4,
        3,
      );

      const movementRows = await cleanupPool.query<{ movement_type: string; ref_type: string }>(
        `SELECT movement_type, ref_type FROM stock_movements WHERE ref_type = 'waste_record' AND ref_id = $1`,
        [created[0]!.id],
      );
      expect(movementRows.rows).toHaveLength(1);
      expect(movementRows.rows[0]!.movement_type).toBe('waste_out');
    });

    it('FIXED (B-16): the SAME approval now produces a balanced gudang_waste (JGUD-05) journal_entries row — Dr 5100 Beban Waste / Cr 1100 Persediaan Gudang', async () => {
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
      const photoId = await createAttachment(fx.kepalaGudangUserId, 'cold_chain_breach_photo_2');
      attachmentIds.push(photoId);

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus); // subscribes the real PostingEngineService to `eventBus`
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => journalEvents.push(e));

      const created = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit(eventBus);
          return wasteService.create(client, kgd, {
            locationId: fx.warehouseId,
            items: [
              {
                storageAreaId: fx.storageAreaWarehouse,
                itemId: fx.itemId,
                qty: '2.000',
                reason: WasteReason.COLD_CHAIN_BREACH,
                reasonDetail: 'Reefer excursion, second batch',
              },
            ],
            photoAttachmentIds: [photoId],
          });
        },
      );
      batchIds.push(created[0]!.batchId);

      await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { wasteService } = buildKit(eventBus);
          return wasteService.approve(client, kgd, created[0]!.batchId, {});
        },
      );

      // `EventBus.publish()` awaits every handler (see its own doc comment) and `WasteService`
      // awaits `eventBus.publish(...)` before its transaction commits, so by the time `approve()`
      // above has resolved, the engine's OWN `withSystemContext` connection has already committed
      // the journal entry — no polling/sleep needed.
      expect(journalEvents).toHaveLength(1);
      expect(journalEvents[0]!.payload.eventType).toBe('gudang_waste');
      expect(journalEvents[0]!.payload.documentId).toBe(created[0]!.id);

      const entryRows = await cleanupPool.query<{
        id: string;
        event_type: string;
        ref_type: string;
        ref_id: string;
        location_id: string;
      }>(
        `SELECT id, event_type, ref_type, ref_id, location_id FROM journal_entries
          WHERE ref_type = 'waste_record' AND ref_id = $1`,
        [created[0]!.id],
      );
      expect(entryRows.rows).toHaveLength(1);
      expect(entryRows.rows[0]!.event_type).toBe('gudang_waste');
      expect(entryRows.rows[0]!.location_id).toBe(fx.warehouseId);

      const lineRows = await cleanupPool.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit, l.credit
           FROM journal_lines l
           JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1
          ORDER BY a.code`,
        [entryRows.rows[0]!.id],
      );
      expect(lineRows.rows).toHaveLength(2);
      const debit = lineRows.rows.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = lineRows.rows.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('5100'); // Beban Waste/Rusak/Expired
      expect(credit?.code).toBe('1100'); // Persediaan Gudang
      // A double-entry line is unbalanced only if the two legs disagree — assert equality directly
      // (never a hardcoded number) against the SAME source `WasteService.approve()` used: qty × the
      // unit_cost it froze onto the record at approval.
      const wr = await cleanupPool.query<{ qty: string; unit_cost: string }>(
        `SELECT qty, unit_cost FROM waste_records WHERE id = $1`,
        [created[0]!.id],
      );
      const expectedAmount = (Number(wr.rows[0]!.qty) * Number(wr.rows[0]!.unit_cost)).toFixed(2);
      expect(debit?.debit).toBe(expectedAmount);
      expect(credit?.credit).toBe(expectedAmount);

      // Re-publishing the SAME event (simulating a redelivery — `approve()` itself cannot be
      // re-run, since a second call would hit `record.status !== WasteStatus.PENDING` first) must
      // never double-post — the journal's own
      // `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'` is what makes this a no-op,
      // not application-level logic, so this proves the engine's idempotency guard actually reaches
      // this event type in practice, not merely on paper.
      await eventBus.publish('journal.action', journalEvents[0]!.payload);
      const replay = await cleanupPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM journal_entries WHERE ref_type = 'waste_record' AND ref_id = $1`,
        [created[0]!.id],
      );
      expect(replay.rows[0]!.count).toBe('1');
    });
  },
);
