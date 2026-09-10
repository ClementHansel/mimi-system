/**
 * Migration 268 — paying a purchase order BEFORE the goods arrive (uang muka)
 * and in more than one instalment, against the LIVE database, driving the REAL
 * `PurchaseOrderService` (no mocks). Same harness and cleanup discipline as
 * `purchase-order-gl-posting.spec.ts`, whose header explains why `receive()`'s
 * separately-committed journal rows have to be torn down by hand.
 *
 * Three things are proved here, and the first is a bug that predates the
 * feature:
 *
 *   1. A receipt raises a voucher for THAT RECEIPT's value. It used to raise
 *      one for `header.total` — the whole PO — on the first receipt, while
 *      JGUD-01 credited 2000 Hutang Supplier for only what actually arrived.
 *      Paying it drove the payable negative by the difference, and the second
 *      half of a split delivery never became payable at all.
 *   2. A down payment lands in 1130 Uang Muka Pembelian, never 2000: the
 *      payable does not exist yet, and debiting it would put Hutang Supplier
 *      into a debit balance for the whole time the order is in transit.
 *   3. Receiving reclassifies that advance into the payable (Dr 2000 / Cr
 *      1130) for `min(nilai penerimaan, sisa uang muka)`, and the voucher the
 *      receipt raises is reduced by exactly what the advance already covered —
 *      so a prepaid order is never billed twice.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { RoleKey } from '@mimi/shared';
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
  const payments = new PaymentVerificationsService(
    sync,
    new EventBus(),
    new ApprovalService(new ApprovalsRepository()),
  );
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

/** As `purchase-order-gl-posting.spec.ts`'s `cleanupPo`, plus the `po_advance` approval chain a DP opens. */
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
  // Approvals raised by the vouchers themselves (`po_advance`), before the vouchers go.
  await cleanupPool.query(
    `DELETE FROM approval_steps WHERE approval_id IN (
       SELECT approval_id FROM payment_verifications
        WHERE ref_type = 'purchase_order' AND ref_id = $1 AND approval_id IS NOT NULL)`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM approvals WHERE id IN (
       SELECT approval_id FROM payment_verifications
        WHERE ref_type = 'purchase_order' AND ref_id = $1 AND approval_id IS NOT NULL)`,
    [id],
  );
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

interface VoucherRow {
  id: string;
  amount: string;
  status: string;
  is_advance: boolean;
}

async function vouchersFor(poId: string): Promise<VoucherRow[]> {
  const res = await cleanupPool.query<VoucherRow>(
    `SELECT id, amount, status, is_advance FROM payment_verifications
      WHERE ref_type = 'purchase_order' AND ref_id = $1 ORDER BY created_at`,
    [poId],
  );
  return res.rows;
}

describe.skipIf(!process.env.DATABASE_URL)(
  'PurchaseOrder advance + partial payments (migration 268), live database',
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

    /** draft → submitted → approved → issued. Returns the issued detail. */
    async function issuedPo(
      eventBus: EventBus,
      mgr: ReturnType<typeof actorFor>,
      lines: { qtyOrdered: string; unitPrice: string }[],
    ): Promise<PurchaseOrderDetail> {
      const ctx = { role: 'manager', userId: mgr.userId, locationIds: [] as string[] };
      const created = await withRollbackAs(ctx, (client) =>
        buildKit(eventBus).poService.create(client, mgr, {
          supplierId: fx.supplierId,
          locationId: fx.warehouseId,
          orderDate: '2026-06-30',
          expectedDate: '2026-07-15',
          lines: lines.map((l) => ({
            itemId: fx.itemId,
            qtyOrdered: l.qtyOrdered,
            unitId: fx.unitId,
            unitPrice: l.unitPrice,
          })),
        }),
      );
      poIds.push(created.id);
      await withRollbackAs(ctx, (client) =>
        buildKit(eventBus).poService.submit(client, mgr, created.id),
      );
      await withRollbackAs(ctx, (client) =>
        buildKit(eventBus).poService.approve(client, mgr, created.id, undefined),
      );
      return withRollbackAs(ctx, (client) =>
        buildKit(eventBus).poService.issue(client, created.id),
      );
    }

    it('refuses to pay a PO that has not been issued — the supplier has not seen the order yet', async () => {
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const eventBus = new EventBus();
      const ctx = { role: 'manager', userId: mgr.userId, locationIds: [] as string[] };

      const created = await withRollbackAs(ctx, (client) =>
        buildKit(eventBus).poService.create(client, mgr, {
          supplierId: fx.supplierId,
          locationId: fx.warehouseId,
          orderDate: '2026-06-30',
          lines: [
            { itemId: fx.itemId, qtyOrdered: '10.000', unitId: fx.unitId, unitPrice: '10000.00' },
          ],
        }),
      );
      poIds.push(created.id);

      await expect(
        withRollbackAs(ctx, (client) =>
          buildKit(eventBus).poService.payAdvance(client, mgr, created.id, {
            amount: '50000.00',
          }),
        ),
      ).rejects.toThrow(/only be paid once it is issued/);

      expect(await vouchersFor(created.id)).toHaveLength(0);
    });

    it('refuses an amount above what is still unpaid AND unclaimed, so a PO cannot be double-paid', async () => {
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const eventBus = new EventBus();
      const ctx = { role: 'manager', userId: mgr.userId, locationIds: [] as string[] };

      const issued = await issuedPo(eventBus, mgr, [
        { qtyOrdered: '10.000', unitPrice: '10000.00' },
      ]);
      expect(issued.total).toBe('100000.00');

      // 60% claimed. It is still only `pending` — nothing has been paid — and
      // that is the whole point: two 60% instalments must not both be
      // raisable just because Finance has not got to the first one yet.
      await withRollbackAs(ctx, (client) =>
        buildKit(eventBus).poService.payAdvance(client, mgr, issued.id, { amount: '60000.00' }),
      );

      await expect(
        withRollbackAs(ctx, (client) =>
          buildKit(eventBus).poService.payAdvance(client, mgr, issued.id, { amount: '60000.00' }),
        ),
      ).rejects.toThrow(/exceeds the 40000.00 still unpaid/);

      const vouchers = await vouchersFor(issued.id);
      expect(vouchers).toHaveLength(1);
      expect(vouchers[0]!.amount).toBe('60000.00');
    });

    it('a DP on an issued PO opens a pending ADVANCE voucher, and the PO reads dibayar-sebagian only once it is paid', async () => {
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const eventBus = new EventBus();
      const ctx = { role: 'manager', userId: mgr.userId, locationIds: [] as string[] };

      const issued = await issuedPo(eventBus, mgr, [
        { qtyOrdered: '10.000', unitPrice: '10000.00' },
      ]);

      const afterRequest = await withRollbackAs(ctx, (client) =>
        buildKit(eventBus).poService.payAdvance(client, mgr, issued.id, { amount: '40000.00' }),
      );

      // Raising a voucher moves no money. Committed, yes — paid, no.
      expect(afterRequest.payment?.state).toBe('unpaid');
      expect(afterRequest.payment?.paidTotal).toBe('0.00');
      expect(afterRequest.payment?.inFlightTotal).toBe('40000.00');

      const vouchers = await vouchersFor(issued.id);
      expect(vouchers).toHaveLength(1);
      expect(vouchers[0]!.status).toBe('pending');
      // The flag that routes this to 1130 and to the Owner-at-any-amount chain.
      expect(vouchers[0]!.is_advance).toBe(true);
    });

    it('a receipt bills only what that receipt accrued — never the whole PO', async () => {
      // The pre-268 bug, stated as a test. Ordering 10 and receiving 4 used to
      // raise a voucher for all 10 while JGUD-01 credited the payable for 4.
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);

      const issued = await issuedPo(eventBus, mgr, [
        { qtyOrdered: '10.000', unitPrice: '10000.00' },
      ]);
      const photoId = await createAttachment(fx.kepalaGudangUserId);
      attachmentIds.push(photoId);

      const received = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) =>
          buildKit(eventBus).poService.receive(client, kgd, issued.id, {
            lines: [
              {
                poLineId: issued.lines[0]!.id,
                qtyReceived: '4.000',
                storageAreaId: fx.storageAreaWarehouse,
                conditionNotes: 'Sisa menyusul',
              },
            ],
            photoAttachmentIds: [photoId],
          }),
      );
      expect(received.status).toBe('partially_received');

      const vouchers = await vouchersFor(issued.id);
      expect(vouchers).toHaveLength(1);
      expect(vouchers[0]!.amount).toBe('40000.00'); // 4 × 10000, NOT the 100000 PO total
      expect(vouchers[0]!.is_advance).toBe(false); // the payable exists now
    });

    it('a paid DP is reclassified into the payable at receipt (Dr 2000 / Cr 1130) and shrinks the receipt voucher to the balance', async () => {
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);
      const journalEvents: DomainEvent<'journal.action'>[] = [];
      eventBus.subscribe('journal.action', (e) => {
        journalEvents.push(e);
      });

      const issued = await issuedPo(eventBus, mgr, [
        { qtyOrdered: '10.000', unitPrice: '10000.00' },
      ]);
      await withRollbackAs(
        { role: 'manager', userId: mgr.userId, locationIds: [] },
        (client) =>
          buildKit(eventBus).poService.payAdvance(client, mgr, issued.id, { amount: '30000.00' }),
      );

      // Finance's own ladder (proof → verify → owner → pay) is exercised by
      // `accounting.integration.spec.ts`; here it is only the PRECONDITION, so
      // the voucher is marked paid directly. What is under test is what
      // `receive()` does about an advance that has already landed.
      const advance = (await vouchersFor(issued.id))[0]!;
      await cleanupPool.query(`UPDATE payment_verifications SET status = 'paid' WHERE id = $1`, [
        advance.id,
      ]);

      const photoId = await createAttachment(fx.kepalaGudangUserId);
      attachmentIds.push(photoId);

      const received = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) =>
          buildKit(eventBus).poService.receive(client, kgd, issued.id, {
            lines: [
              {
                poLineId: issued.lines[0]!.id,
                qtyReceived: '10.000',
                storageAreaId: fx.storageAreaWarehouse,
              },
            ],
            photoAttachmentIds: [photoId],
          }),
      );
      expect(received.status).toBe('received');

      // 100000 accrued, 30000 already prepaid — so 70000 is billed, not 100000.
      const vouchers = await vouchersFor(issued.id);
      expect(vouchers).toHaveLength(2);
      const raisedAtReceipt = vouchers.find((v) => !v.is_advance)!;
      expect(raisedAtReceipt.amount).toBe('70000.00');

      // The DP has been consumed: nothing left sitting in 1130 for this PO.
      expect(received.payment?.advancePaid).toBe('30000.00');
      expect(received.payment?.advanceUnapplied).toBe('0.00');

      const offsets = journalEvents.filter(
        (e) => e.payload.eventType === 'supplier_advance_offset',
      );
      expect(offsets).toHaveLength(1);
      expect(offsets[0]!.payload.amount).toBe('30000.00');

      const receiptRow = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM po_receipts WHERE po_id = $1`,
        [issued.id],
      );
      const receiptId = receiptRow.rows[0]!.id;

      const entry = await cleanupPool.query<{ id: string }>(
        `SELECT id FROM journal_entries
          WHERE ref_type = 'po_receipt' AND ref_id = $1 AND event_type = 'supplier_advance_offset'`,
        [receiptId],
      );
      expect(entry.rows).toHaveLength(1);

      const legs = await cleanupPool.query<{ code: string; debit: string; credit: string }>(
        `SELECT a.code, l.debit, l.credit
           FROM journal_lines l JOIN chart_of_accounts a ON a.id = l.account_id
          WHERE l.entry_id = $1 ORDER BY a.code`,
        [entry.rows[0]!.id],
      );
      const debit = legs.rows.find((r) => Number.parseFloat(r.debit) > 0);
      const credit = legs.rows.find((r) => Number.parseFloat(r.credit) > 0);
      expect(debit?.code).toBe('2000'); // Hutang Supplier, settled by the DP
      expect(credit?.code).toBe('1130'); // Uang Muka Pembelian, released
      expect(debit?.debit).toBe('30000.00');
      expect(credit?.credit).toBe('30000.00');
    });

    it('an advance never consumes more than the receipt it is applied against', async () => {
      // Prepay the whole order, then take delivery of a quarter of it. Only
      // the quarter may be offset: the rest of the DP is still an advance on
      // goods nobody has handed over.
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);

      const issued = await issuedPo(eventBus, mgr, [
        { qtyOrdered: '10.000', unitPrice: '10000.00' },
      ]);
      await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) =>
        buildKit(eventBus).poService.payAdvance(client, mgr, issued.id, { amount: '100000.00' }),
      );
      const advance = (await vouchersFor(issued.id))[0]!;
      await cleanupPool.query(`UPDATE payment_verifications SET status = 'paid' WHERE id = $1`, [
        advance.id,
      ]);

      const photoId = await createAttachment(fx.kepalaGudangUserId);
      attachmentIds.push(photoId);

      const received = await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) =>
          buildKit(eventBus).poService.receive(client, kgd, issued.id, {
            lines: [
              {
                poLineId: issued.lines[0]!.id,
                qtyReceived: '2.500',
                storageAreaId: fx.storageAreaWarehouse,
                conditionNotes: 'Kirim bertahap',
              },
            ],
            photoAttachmentIds: [photoId],
          }),
      );

      expect(received.payment?.advancePaid).toBe('100000.00');
      // 25000 earned by this delivery, 75000 still an advance on goods not yet handed over.
      expect(received.payment?.advanceUnapplied).toBe('75000.00');
      // The receipt is fully covered by the DP, so it bills nothing further.
      const raisedAtReceipt = (await vouchersFor(issued.id)).filter((v) => !v.is_advance);
      expect(raisedAtReceipt).toHaveLength(0);
      // And the order is already fully paid, even though it is barely delivered.
      expect(received.payment?.state).toBe('paid');
      expect(received.payment?.outstanding).toBe('0.00');
    });

    it('a fully received PO closes even with a balance outstanding — the debt stays, the order does not', async () => {
      // Owner-decided 2026-09-10. Closing used to require the linked voucher
      // to read 'paid', which under instalment terms held a delivered PO open
      // for as long as the last termin took.
      const mgr = actorFor(fx, RoleKey.MANAGER, null);
      const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
      const eventBus = new EventBus();
      buildEngine(appPoolForDi(), eventBus);

      const issued = await issuedPo(eventBus, mgr, [
        { qtyOrdered: '10.000', unitPrice: '10000.00' },
      ]);
      const photoId = await createAttachment(fx.kepalaGudangUserId);
      attachmentIds.push(photoId);

      await withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) =>
          buildKit(eventBus).poService.receive(client, kgd, issued.id, {
            lines: [
              {
                poLineId: issued.lines[0]!.id,
                qtyReceived: '10.000',
                storageAreaId: fx.storageAreaWarehouse,
              },
            ],
            photoAttachmentIds: [photoId],
          }),
      );

      const closed = await withRollbackAs(
        { role: 'manager', userId: mgr.userId, locationIds: [] },
        (client) => buildKit(eventBus).poService.close(client, issued.id),
      );

      expect(closed.status).toBe('closed');
      // Nothing was paid, and the system still says so rather than quietly
      // treating a closed order as a settled one.
      expect(closed.payment?.state).toBe('unpaid');
      expect(closed.payment?.outstanding).toBe('100000.00');
    });
  },
);
