/**
 * B-16 — proof that `PurchaseOrderService.receive()` now reaches the general
 * ledger as JGUD-01 (`gudang_purchase`, CONTRACTS.md §6.2), against the LIVE
 * database, driving the REAL `PurchaseOrderService` (no mocks) — kept
 * separate from `purchasing.integration.spec.ts` per this ticket's "new
 * *.spec.ts only" instruction, same convention `waste-gl-posting.spec.ts`
 * and `pos-online-order-gl-posting.spec.ts` already established for B-16.
 *
 * `PurchaseOrderService.receive()` self-commits (`db-tx.ts`'s `withWrite`),
 * so the `journal.action` event it publishes is handled by the REAL
 * `PostingEngineService` on its OWN `withSystemContext` connection (same
 * cross-connection shape `waste-gl-posting.spec.ts`'s header explains) — the
 * resulting `journal_entries`/`journal_lines` rows are genuine commits, not
 * something this test's own rolled-back transaction ever undoes, so they are
 * cleaned up by hand in `afterEach` exactly like that file's `cleanupPo`.
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
import { PaymentVerificationsService } from '../accounting/payment-verifications.service';
import { formatDateOnly } from '../../common/date-only.util';

import { PurchaseRequestRepository } from './purchase-request.repository';
import { PurchaseRequestService } from './purchase-request.service';
import { PurchaseOrderRepository } from './purchase-order.repository';
import { PurchaseOrderService, type PurchaseOrderDetail } from './purchase-order.service';
import {
  appPoolForDi,
  closePool,
  createAttachment,
  deleteAttachment,
  loadFixtures,
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
  const payments = new PaymentVerificationsService(sync, new EventBus());
  const prRepo = new PurchaseRequestRepository();
  const prService = new PurchaseRequestService(prRepo, approvals);
  const poRepo = new PurchaseOrderRepository();
  const poService = new PurchaseOrderService(
    poRepo,
    approvals,
    ledger,
    payments,
    prService,
    eventBus,
  );
  return { poService };
}

/** The REAL posting engine, subscribed to the SAME bus `PurchaseOrderService` publishes through. */
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
): { userId: string; roleKey: RoleKey; locationScope: readonly string[] | null } {
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

/** Mirrors `purchasing.integration.spec.ts`'s `cleanupPo`, plus the `journal_entries`/`journal_lines`
 * rows this file's fix now produces (a real, separately-committed side effect of `receive()`). */
async function cleanupPo(
  id: string,
  locationId: string,
  storageAreaId: string,
  itemId: string,
): Promise<void> {
  await cleanupPool.query(
    `UPDATE purchase_orders SET approval_id = NULL, payment_verification_id = NULL WHERE id = $1`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM journal_lines WHERE entry_id IN (
       SELECT id FROM journal_entries WHERE ref_type = 'po_receipt'
         AND ref_id IN (SELECT id FROM po_receipts WHERE po_id = $1))`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM journal_entries WHERE ref_type = 'po_receipt'
       AND ref_id IN (SELECT id FROM po_receipts WHERE po_id = $1)`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM stock_movements WHERE ref_type = 'po_receipt'
       AND ref_id IN (SELECT id FROM po_receipts WHERE po_id = $1)`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM po_receipt_lines WHERE po_receipt_id IN (SELECT id FROM po_receipts WHERE po_id = $1)`,
    [id],
  );
  await cleanupPool.query(`DELETE FROM po_receipts WHERE po_id = $1`, [id]);
  await cleanupPool.query(
    `DELETE FROM payment_verifications WHERE ref_type = 'purchase_order' AND ref_id = $1`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'purchase_order' AND document_id = $1)`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM approvals WHERE document_type = 'purchase_order' AND document_id = $1`,
    [id],
  );
  await cleanupPool.query(`DELETE FROM purchase_orders WHERE id = $1`, [id]);
  await reconcileStockBalance(locationId, storageAreaId, itemId);
}

describe.skipIf(!process.env.DATABASE_URL)(
  'PurchaseOrder.receive() — GL posting (B-16 JGUD-01 gudang_purchase), live database',
  () => {
    let fx: Fixtures;
    const attachmentIds: string[] = [];
    const poIds: string[] = [];

    beforeAll(async () => {
      fx = await loadFixtures();
    }, 30_000);

    afterEach(async () => {
      while (attachmentIds.length) await deleteAttachment(attachmentIds.pop()!);
      while (poIds.length) {
        const id = poIds.pop()!;
        await cleanupPo(id, fx.warehouseId, fx.storageAreaWarehouse, fx.itemId);
      }
    });

    afterAll(async () => {
      await cleanupPool.end();
      await closePool();
    });

    it('a full PO receipt posts a balanced Dr 1100 / Cr 2000 entry valued at qty_received × unit_price, on the correct WITA business date', async () => {
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus); // subscribes the real PostingEngineService
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => {
        journalEvents.push(e);
      });

      const created: PurchaseOrderDetail = await withRollbackAs(
        { role: 'manager', userId: mgr.userId, locationIds: [] },
        (client) => {
          const { poService } = buildKit(eventBus);
          return poService.create(client, mgr, {
            supplierId: fx.supplierId,
            locationId: fx.warehouseId,
            orderDate: '2026-06-30',
            expectedDate: '2026-07-15',
            lines: [
              { itemId: fx.itemId, qtyOrdered: '15.000', unitId: fx.unitId, unitPrice: '12345.00' },
            ],
          });
        },
      );
      poIds.push(created.id);
      expect(created.total).toBe('185175.00'); // 15.000 * 12345.00

      await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
        const { poService } = buildKit(eventBus);
        return poService.submit(client, mgr, created.id);
      });

      const approved = await withRollbackAs(
        { role: 'manager', userId: mgr.userId, locationIds: [] },
        (client) => {
          const { poService } = buildKit(eventBus);
          return poService.approve(client, mgr, created.id, undefined);
        },
      );
      expect(approved.status).toBe('approved');

      await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
        const { poService } = buildKit(eventBus);
        return poService.issue(client, created.id);
      });

      const photoId = await createAttachment(fx.kepalaGudangUserId);
      attachmentIds.push(photoId);

      const received = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { poService } = buildKit(eventBus);
          return poService.receive(client, kgd, created.id, {
            lines: [
              {
                poLineId: approved.lines[0]!.id,
                qtyReceived: '15.000',
                storageAreaId: fx.storageAreaWarehouse,
              },
            ],
            photoAttachmentIds: [photoId],
          });
        },
      );
      expect(received.status).toBe('received');

      // `EventBus.publish()` awaits every handler and `receive()` awaits the publish before its own
      // transaction commits (see `waste-gl-posting.spec.ts`'s header for the identical reasoning), so
      // the engine's separate connection has already committed the journal entry by now.
      const purchaseEvents = journalEvents.filter((e) => e.payload.eventType === 'gudang_purchase');
      expect(purchaseEvents).toHaveLength(1);
      expect(purchaseEvents[0]!.payload.amount).toBe('185175.00');

      const receiptRow = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM po_receipts WHERE po_id = $1`,
        [created.id],
      );
      const receiptId = receiptRow.rows[0]!.id;
      expect(purchaseEvents[0]!.payload.documentId).toBe(receiptId);

      const entryRows = await cleanupPool.query<{
        id: string;
        event_type: string;
        ref_type: string;
        ref_id: string;
        location_id: string;
        entry_date: unknown;
      }>(
        `SELECT id, event_type, ref_type, ref_id, location_id, entry_date FROM journal_entries
          WHERE ref_type = 'po_receipt' AND ref_id = $1`,
        [receiptId],
      );
      expect(entryRows.rows).toHaveLength(1);
      expect(entryRows.rows[0]!.event_type).toBe('gudang_purchase');
      expect(entryRows.rows[0]!.location_id).toBe(fx.warehouseId);
      // The DATE/WITA trap this ticket calls out by name: `entry_date` is a `DATE` column, so a raw
      // `pg` read needs `formatDateOnly` (never `.toISOString()`) to recover the real calendar day.
      const todayWita = businessDateOf(new Date().toISOString());
      expect(formatDateOnly(entryRows.rows[0]!.entry_date)).toBe(todayWita);

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
      expect(debit?.code).toBe('1100'); // Persediaan Gudang
      expect(credit?.code).toBe('2000'); // Hutang Supplier
      expect(debit?.debit).toBe('185175.00');
      expect(credit?.credit).toBe('185175.00');

      // Idempotency — the journal's `UNIQUE (event_type, ref_type, ref_id) WHERE source='system'` must
      // make a redelivery of the SAME event a no-op, never a second entry.
      await eventBus.publish('journal.action', purchaseEvents[0]!.payload);
      const replay = await cleanupPool.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM journal_entries WHERE ref_type = 'po_receipt' AND ref_id = $1`,
        [receiptId],
      );
      expect(replay.rows[0]!.count).toBe('1');
    });
  },
);
