/**
 * Integration tests against the LIVE database for M11 `purchasing`
 * (CONTRACTS.md §4.11, §5.3). Wired by hand (`new`) — every dependency is a
 * REAL kernel/cross-module class, never a mock, mirroring
 * `modules/replenishment/replenishment.integration.spec.ts`.
 *
 * IMPORTANT: unlike `kernel/approvals`'s harness, every mutating method here
 * SELF-COMMITS (`db-tx.ts`'s `withWrite()` — the "AIRE/inventory convention"
 * `modules/location`'s `db-tx.ts` documents, mandatory for every mutating
 * `purchasing`/`waste-return` method per that file's header). That means a
 * SINGLE `withRollbackAs(...)` wrapping a multi-step flow (create, then
 * submit, then approve) would have its `SET LOCAL ROLE app_user` + session
 * vars silently evaporate the instant the first call's internal `COMMIT`
 * lands — every later query in that same block then runs as the raw
 * `mimi_app` login role (zero grants, D-21/D-22), producing a bare Postgres
 * "permission denied" rather than an RLS-shaped denial. Each lifecycle step
 * below therefore opens its OWN `withRollbackAs` — one call = one simulated
 * HTTP request, exactly matching `replenishment.integration.spec.ts`'s
 * pattern — and rows are cleaned up via the owner pool afterward (a
 * `withRollbackAs` block's trailing ROLLBACK is a no-op once the row inside
 * it already committed).
 *
 * Runs the PR→PO→receiving→petty-cash flows under REAL, non-central role
 * sessions (Kepala Gudang, Manager, Leader Outlet, Finance) — not `'owner'`
 * — per this campaign's standing note that an owner-only test suite hides
 * scoped-role RLS bugs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ERR_FORBIDDEN, ERR_PHOTO_REQUIRED, RoleKey } from '@mimi/shared';

vi.setConfig({ testTimeout: 20_000 });

import { ApprovalService } from '../../kernel/approvals/approvals.service';
import { ApprovalsRepository } from '../../kernel/approvals/approvals.repository';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../kernel/stock-ledger/stock-ledger-events';
import { EventBus } from '../../kernel/events/event-bus.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { PaymentVerificationsService } from '../accounting/payment-verifications.service';

import { PurchaseRequestRepository } from './purchase-request.repository';
import { PurchaseRequestService, type ActorContext } from './purchase-request.service';
import { PurchaseOrderRepository } from './purchase-order.repository';
import { PurchaseOrderService } from './purchase-order.service';
import { PettyCashRepository } from './petty-cash.repository';
import { PettyCashService } from './petty-cash.service';
import {
  appPoolForDi,
  closePool,
  createAttachment,
  deleteAttachment,
  loadFixtures,
  withRollbackAs,
  type Fixtures,
} from './test-support/live-db';
import { Pool } from 'pg';

function buildKit() {
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
  const poService = new PurchaseOrderService(poRepo, approvals, ledger, payments, prService);
  const pcRepo = new PettyCashRepository();
  const pcService = new PettyCashService(pcRepo, ledger, sync, payments);

  return { prService, poService, pcService };
}

function actorFor(fx: Fixtures, role: RoleKey, locationScope: readonly string[] | null = null): ActorContext {
  return { userId: fx.usersByRole[role], roleKey: role, locationScope };
}

const cleanupPool = new Pool({
  connectionString:
    process.env.DATABASE_MIGRATION_URL ??
    `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${process.env.POSTGRES_PORT ?? '55433'}/${process.env.POSTGRES_DB ?? 'mimi'}`,
});

async function cleanupPr(id: string): Promise<void> {
  await cleanupPool.query(`UPDATE purchase_requests SET approval_id = NULL WHERE id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'purchase_request' AND document_id = $1)`, [id]);
  await cleanupPool.query(`DELETE FROM approvals WHERE document_type = 'purchase_request' AND document_id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM purchase_requests WHERE id = $1`, [id]);
}

async function cleanupPo(id: string): Promise<void> {
  await cleanupPool.query(`UPDATE purchase_orders SET approval_id = NULL, payment_verification_id = NULL WHERE id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM stock_movements WHERE ref_type = 'po_receipt' AND ref_id IN (SELECT id FROM po_receipts WHERE po_id = $1)`, [id]);
  await cleanupPool.query(`DELETE FROM po_receipt_lines WHERE po_receipt_id IN (SELECT id FROM po_receipts WHERE po_id = $1)`, [id]);
  await cleanupPool.query(`DELETE FROM po_receipts WHERE po_id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM payment_verifications WHERE ref_type = 'purchase_order' AND ref_id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'purchase_order' AND document_id = $1)`, [id]);
  await cleanupPool.query(`DELETE FROM approvals WHERE document_type = 'purchase_order' AND document_id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM purchase_orders WHERE id = $1`, [id]);
}

async function cleanupPc(id: string): Promise<void> {
  await cleanupPool.query(`UPDATE petty_cash SET payment_verification_id = NULL WHERE id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM stock_movements WHERE ref_type = 'petty_cash' AND ref_id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM payment_verifications WHERE ref_type = 'petty_cash' AND ref_id = $1`, [id]);
  await cleanupPool.query(`DELETE FROM petty_cash WHERE id = $1`, [id]);
}

describe('Purchasing — live database (PR -> PO -> receiving, petty cash)', () => {
  let fx: Fixtures;
  const attachmentIds: string[] = [];
  const prIds: string[] = [];
  const poIds: string[] = [];
  const pcIds: string[] = [];

  beforeAll(async () => {
    fx = await loadFixtures();
  });

  afterEach(async () => {
    while (attachmentIds.length) await deleteAttachment(attachmentIds.pop()!);
    while (prIds.length) await cleanupPr(prIds.pop()!);
    while (poIds.length) await cleanupPo(poIds.pop()!);
    while (pcIds.length) await cleanupPc(pcIds.pop()!);
  });

  afterAll(async () => {
    await cleanupPool.end();
    await closePool();
  });

  it('PR create -> submit -> approve (Manager) reaches approved', async () => {
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
    const mgr = actorFor(fx, RoleKey.MANAGER, null);

    const created = await withRollbackAs({ role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] }, (client) => {
      const { prService } = buildKit();
      return prService.create(client, kgd, { locationId: fx.warehouseId, lines: [{ itemId: fx.itemId, qty: '10.000', unitId: fx.unitId, estPrice: '5000.00' }] });
    });
    prIds.push(created.id);
    expect(created.status).toBe('draft');

    const submitted = await withRollbackAs({ role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] }, (client) => {
      const { prService } = buildKit();
      return prService.submit(client, kgd, created.id);
    });
    expect(submitted.status).toBe('submitted');

    const approved = await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { prService } = buildKit();
      return prService.approve(client, mgr, created.id, {});
    });
    expect(approved.status).toBe('approved');
  });

  it('PO create -> submit -> approve -> issue -> receive posts purchase_in and updates items.avg_cost (FR-PO-02/03/04)', async () => {
    const mgr = actorFor(fx, RoleKey.MANAGER, null);
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

    const priorAvgCost = await withRollbackAs({ role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] }, async (client) => {
      const res = await client.query<{ avg_cost: string }>(`SELECT avg_cost FROM items WHERE id = $1`, [fx.itemId]);
      return res.rows[0]!.avg_cost;
    });

    const created = await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.create(client, mgr, {
        supplierId: fx.supplierId, locationId: fx.warehouseId, orderDate: new Date().toISOString().slice(0, 10),
        lines: [{ itemId: fx.itemId, qtyOrdered: '20.000', unitId: fx.unitId, unitPrice: '8000.00' }],
      });
    });
    poIds.push(created.id);
    expect(created.status).toBe('draft');
    expect(created.total).toBe('160000.00');

    await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.submit(client, mgr, created.id);
    });

    const approved = await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.approve(client, mgr, created.id, undefined);
    });
    expect(approved.status).toBe('approved');

    const issued = await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.issue(client, created.id);
    });
    expect(issued.status).toBe('issued');

    const photoId = await createAttachment(fx.kepalaGudangUserId);
    attachmentIds.push(photoId);

    const received = await withRollbackAs({ role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] }, (client) => {
      const { poService } = buildKit();
      return poService.receive(client, kgd, created.id, {
        lines: [{ poLineId: issued.lines[0]!.id, qtyReceived: '20.000', storageAreaId: fx.storageAreaWarehouse }],
        photoAttachmentIds: [photoId],
      });
    });
    expect(received.status).toBe('received');
    expect(received.lines[0]!.qtyReceived).toBe('20.000');
    expect(received.lines[0]!.qtyDifference).toBe('0.000');

    const afterAvgCost = await withRollbackAs({ role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] }, async (client) => {
      const res = await client.query<{ avg_cost: string }>(`SELECT avg_cost FROM items WHERE id = $1`, [fx.itemId]);
      return res.rows[0]!.avg_cost;
    });
    expect(afterAvgCost).not.toBe(priorAvgCost);

    const pv = await withRollbackAs({ role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] }, (client) =>
      client.query<{ status: string; ref_type: string }>(`SELECT status, ref_type FROM payment_verifications WHERE ref_id = $1`, [created.id]),
    );
    expect(pv.rows[0]?.status).toBe('pending');
    expect(pv.rows[0]?.ref_type).toBe('purchase_order');
  });

  it('PO receiving without a photo is rejected (wajib foto, FR-PO-04)', async () => {
    const mgr = actorFor(fx, RoleKey.MANAGER, null);
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

    const created = await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.create(client, mgr, {
        supplierId: fx.supplierId, locationId: fx.warehouseId, orderDate: new Date().toISOString().slice(0, 10),
        lines: [{ itemId: fx.itemId, qtyOrdered: '5.000', unitId: fx.unitId, unitPrice: '1000.00' }],
      });
    });
    poIds.push(created.id);

    await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.submit(client, mgr, created.id);
    });
    await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.approve(client, mgr, created.id, undefined);
    });
    const issued = await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.issue(client, created.id);
    });

    await expect(
      withRollbackAs({ role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] }, (client) => {
        const { poService } = buildKit();
        return poService.receive(client, kgd, created.id, {
          lines: [{ poLineId: issued.lines[0]!.id, qtyReceived: '5.000', storageAreaId: fx.storageAreaWarehouse }],
          photoAttachmentIds: [],
        });
      }),
    ).rejects.toMatchObject({ response: { code: ERR_PHOTO_REQUIRED } });
  });

  it('a Supervisor creating a PR outside their assigned location gets a real ERR_FORBIDDEN (permission denied pin)', async () => {
    const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);

    await expect(
      withRollbackAs({ role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] }, (client) => {
        const { prService } = buildKit();
        return prService.create(client, spv, { locationId: fx.warehouseId, lines: [{ itemId: fx.itemId, qty: '1.000', unitId: fx.unitId }] });
      }),
    ).rejects.toMatchObject({ response: { code: ERR_FORBIDDEN } });
  });

  it('petty cash create (Leader Outlet) -> verify (Finance) posts purchase_in for a stockable line and requires both photos (PRD 8.6.1)', async () => {
    const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
    const fin = actorFor(fx, RoleKey.FINANCE, null);

    const proofId = await createAttachment(fx.leaderOutletUserId, 'payment_proof');
    const photoId = await createAttachment(fx.leaderOutletUserId, 'petty_cash_photo');
    attachmentIds.push(proofId, photoId);

    const created = await withRollbackAs({ role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] }, (client) => {
      const { pcService } = buildKit();
      return pcService.create(client, ldr, {
        locationId: fx.outletId,
        purchaseDate: new Date().toISOString().slice(0, 10),
        storeName: 'Toko Kelontong Pak Budi',
        lines: [{ description: 'Bawang merah', itemId: fx.itemId, storageAreaId: fx.storageAreaOutlet, qty: '2.000', amount: '30000.00', expenseCategory: 'operasional' }],
        paymentProofAttachmentId: proofId,
        goodsPhotoAttachmentId: photoId,
      });
    });
    pcIds.push(created.id);
    expect(created.status).toBe('pending');
    expect(created.totalAmount).toBe('30000.00');
    expect(created.photoUrls.sort()).toEqual([proofId, photoId].sort());

    const balBefore = await withRollbackAs({ role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] }, (client) =>
      client.query<{ qty_on_hand: string }>(`SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`, [fx.outletId, fx.storageAreaOutlet, fx.itemId]),
    );

    const verified = await withRollbackAs({ role: 'finance', userId: fin.userId, locationIds: [] }, (client) => {
      const { pcService } = buildKit();
      return pcService.verify(client, fin, created.id, undefined);
    });
    expect(verified.status).toBe('verified');

    const balAfter = await withRollbackAs({ role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] }, (client) =>
      client.query<{ qty_on_hand: string }>(`SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`, [fx.outletId, fx.storageAreaOutlet, fx.itemId]),
    );
    const before = Number(balBefore.rows[0]?.qty_on_hand ?? '0');
    const afterQty = Number(balAfter.rows[0]!.qty_on_hand);
    expect(afterQty - before).toBeCloseTo(2, 3);

    const pv = await withRollbackAs({ role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] }, (client) =>
      client.query<{ status: string; ref_type: string }>(`SELECT status, ref_type FROM payment_verifications WHERE ref_id = $1`, [created.id]),
    );
    expect(pv.rows[0]?.ref_type).toBe('petty_cash');
  });
});
