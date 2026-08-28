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
import {
  ERR_CONFLICT,
  ERR_FORBIDDEN,
  ERR_PHOTO_REQUIRED,
  ERR_VARIANCE_REASON_REQUIRED,
  RoleKey,
} from '@mimi/shared';

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
  const journalEventBus = new EventBus();

  const prRepo = new PurchaseRequestRepository();
  const prService = new PurchaseRequestService(prRepo, approvals);
  const poRepo = new PurchaseOrderRepository();
  const poService = new PurchaseOrderService(
    poRepo,
    approvals,
    ledger,
    payments,
    prService,
    journalEventBus,
  );
  const pcRepo = new PettyCashRepository();
  // Same `journalEventBus` the PO service uses, so a test can observe the
  // B-16 JOUT-07/JOUT-08 emits from a petty-cash verify too.
  const pcService = new PettyCashService(pcRepo, ledger, sync, payments, journalEventBus);

  return { prService, poService, pcService, journalEventBus };
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

async function cleanupPr(id: string): Promise<void> {
  await cleanupPool.query(`UPDATE purchase_requests SET approval_id = NULL WHERE id = $1`, [id]);
  await cleanupPool.query(
    `DELETE FROM approval_steps WHERE approval_id IN (SELECT id FROM approvals WHERE document_type = 'purchase_request' AND document_id = $1)`,
    [id],
  );
  await cleanupPool.query(
    `DELETE FROM approvals WHERE document_type = 'purchase_request' AND document_id = $1`,
    [id],
  );
  await cleanupPool.query(`DELETE FROM purchase_requests WHERE id = $1`, [id]);
}

/**
 * QA-ISOLATION finding: this suite's stock-touching mutations (`poService.receive()`,
 * `pcService.*`) go through the REAL `StockLedgerService`, which durably updates
 * `stock_balances.qty_on_hand` in the same commit as the `stock_movements` row (every
 * mutating method here self-commits — see file header). The two cleanup functions below
 * used to `DELETE FROM stock_movements ...` for the ref but NEVER touched the balance
 * that movement had already added to — leaving `stock_balances` permanently out of sync
 * with the (now smaller) fold of `stock_movements` for that key. `stock-ledger.integration
 * .spec.ts`'s G1 "whole-table balance == fold-of-movements" check (run in a LATER file in
 * the same live DB) is exactly what caught this: it failed with N>0 mismatched keys after
 * a full suite run, on a database that was 0/0 clean immediately post-reset.
 *
 * Fix: capture the (location, storage_area, item) keys a ref's movements actually touched
 * BEFORE deleting them, then reconcile `stock_balances.qty_on_hand` to the fold of
 * whatever movements remain for that key (never a blind delete of the balance row itself —
 * the key may carry real seed history this suite never touched).
 */
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

async function deleteMovementsAndReconcile(
  refType: string,
  refIdCondition: string,
  params: unknown[],
): Promise<void> {
  const keys = await cleanupPool.query<{
    location_id: string;
    storage_area_id: string;
    item_id: string;
  }>(
    `SELECT DISTINCT location_id, storage_area_id, item_id FROM stock_movements WHERE ref_type = '${refType}' AND ${refIdCondition}`,
    params,
  );
  await cleanupPool.query(
    `DELETE FROM stock_movements WHERE ref_type = '${refType}' AND ${refIdCondition}`,
    params,
  );
  for (const key of keys.rows)
    await reconcileStockBalance(key.location_id, key.storage_area_id, key.item_id);
}

async function cleanupPo(id: string): Promise<void> {
  await cleanupPool.query(
    `UPDATE purchase_orders SET approval_id = NULL, payment_verification_id = NULL WHERE id = $1`,
    [id],
  );
  await deleteMovementsAndReconcile(
    'po_receipt',
    `ref_id IN (SELECT id FROM po_receipts WHERE po_id = $1)`,
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
}

async function cleanupPc(id: string): Promise<void> {
  await cleanupPool.query(`UPDATE petty_cash SET payment_verification_id = NULL WHERE id = $1`, [
    id,
  ]);
  await deleteMovementsAndReconcile('petty_cash', `ref_id = $1`, [id]);
  await cleanupPool.query(
    `DELETE FROM payment_verifications WHERE ref_type = 'petty_cash' AND ref_id = $1`,
    [id],
  );
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
    // Fixed date — same day-shift regression rationale as the PO test below.
    const neededBy = '2026-12-31';

    const created = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { prService } = buildKit();
        return prService.create(client, kgd, {
          locationId: fx.warehouseId,
          neededBy,
          lines: [{ itemId: fx.itemId, qty: '10.000', unitId: fx.unitId, estPrice: '5000.00' }],
        });
      },
    );
    prIds.push(created.id);
    expect(created.status).toBe('draft');
    // Exact round-trip, not a loose date-shaped regex — a one-day-shifted value would still match a regex.
    expect(created.neededBy).toBe(neededBy);
    // CONTRACTS.md §4.11: PR detail is "PR with lines + `ApprovalDetail`" — absent pre-submit.
    expect(created.approval).toBeNull();

    const submitted = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { prService } = buildKit();
        return prService.submit(client, kgd, created.id);
      },
    );
    expect(submitted.status).toBe('submitted');
    expect(submitted.approval).not.toBeNull();
    expect(submitted.approval!.currentStep).not.toBeNull();

    const approved = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { prService } = buildKit();
        return prService.approve(client, mgr, created.id, {});
      },
    );
    expect(approved.status).toBe('approved');
    expect(approved.approval).not.toBeNull();
    expect(approved.approval!.currentStep).toBeNull(); // finalized — the documented completion signal.
  });

  it('PR edit replaces lines, records who edited it, and is refused once submitted', async () => {
    // Owner's ruling, 2026-08-21: "PR should be editable but shown who make it
    // and who made the changes". Both halves are asserted here — the edit
    // itself, and that a document already in someone else's approval queue can
    // no longer be changed under them.
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
    const session = {
      role: 'kepala_gudang' as const,
      userId: kgd.userId,
      locationIds: [fx.warehouseId],
    };

    const created = await withRollbackAs(session, (client) => {
      const { prService } = buildKit();
      return prService.create(client, kgd, {
        locationId: fx.warehouseId,
        neededBy: '2026-12-31',
        lines: [{ itemId: fx.itemId, qty: '10.000', unitId: fx.unitId, estPrice: '5000.00' }],
      });
    });
    prIds.push(created.id);
    // Nobody has edited it yet, and saying "edited by <creator>" would be a lie.
    expect(created.updatedBy).toBeNull();

    const edited = await withRollbackAs(session, (client) => {
      const { prService } = buildKit();
      return prService.update(client, kgd, created.id, {
        neededBy: '2027-01-15',
        notes: 'stok gudang habis',
        lines: [{ itemId: fx.itemId, qty: '25.000', unitId: fx.unitId, estPrice: '5200.00' }],
      });
    });
    expect(edited.neededBy).toBe('2027-01-15');
    expect(edited.notes).toBe('stok gudang habis');
    // Replaced, not appended: one line in, one line out.
    expect(edited.lines).toHaveLength(1);
    expect(edited.lines[0]!.qty).toBe('25.000');
    expect(edited.updatedBy).not.toBeNull();
    expect(edited.status).toBe('draft');

    // An omitted field is "leave it alone", never "blank it".
    const partial = await withRollbackAs(session, (client) => {
      const { prService } = buildKit();
      return prService.update(client, kgd, created.id, { neededBy: '2027-02-01' });
    });
    expect(partial.notes).toBe('stok gudang habis');
    expect(partial.lines).toHaveLength(1);

    await withRollbackAs(session, (client) => {
      const { prService } = buildKit();
      return prService.submit(client, kgd, created.id);
    });

    // Mid-approval: editing would change a document the approver is looking at.
    await expect(
      withRollbackAs(session, (client) => {
        const { prService } = buildKit();
        return prService.update(client, kgd, created.id, { notes: 'diam-diam diubah' });
      }),
    ).rejects.toMatchObject({ response: { code: ERR_CONFLICT } });
  });

  it('editing a rejected PR returns it to draft and drops the stale rejection reason', async () => {
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
    const mgr = actorFor(fx, RoleKey.MANAGER, null);
    const kgdSession = {
      role: 'kepala_gudang' as const,
      userId: kgd.userId,
      locationIds: [fx.warehouseId],
    };

    const created = await withRollbackAs(kgdSession, (client) => {
      const { prService } = buildKit();
      return prService.create(client, kgd, {
        locationId: fx.warehouseId,
        lines: [{ itemId: fx.itemId, qty: '10.000', unitId: fx.unitId, estPrice: '9000.00' }],
      });
    });
    prIds.push(created.id);

    await withRollbackAs(kgdSession, (client) => {
      const { prService } = buildKit();
      return prService.submit(client, kgd, created.id);
    });
    const rejected = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { prService } = buildKit();
        return prService.reject(client, mgr, created.id, { reason: 'harga terlalu mahal' });
      },
    );
    expect(rejected.status).toBe('rejected');
    expect(rejected.rejectionReason).toBe('harga terlalu mahal');

    const amended = await withRollbackAs(kgdSession, (client) => {
      const { prService } = buildKit();
      return prService.update(client, kgd, created.id, {
        lines: [{ itemId: fx.itemId, qty: '10.000', unitId: fx.unitId, estPrice: '7000.00' }],
      });
    });
    // The document the approver rejected no longer exists, so keeping "harga
    // terlalu mahal" on it would misrepresent the amended request.
    expect(amended.status).toBe('draft');
    expect(amended.rejectionReason).toBeNull();
    expect(amended.lines[0]!.estPrice).toBe('7000.00');
  });

  it('an outlet replenishment request converts into a draft PR that remembers its source', async () => {
    // Owner: "a place to see requests from stores properly and able to convert
    // that to PR". The conversion copies the lines UNPRICED and leaves the
    // outlet's own request alone — buying it in is the other answer to that
    // request, not a state change of it.
    const mgr = actorFor(fx, RoleKey.MANAGER, null);
    const mgrSession = { role: 'manager' as const, userId: mgr.userId, locationIds: [] };

    const source = await cleanupPool.query<{ id: string; request_number: string; status: string }>(
      `SELECT id, request_number, status FROM replenishment_requests
        WHERE status <> 'draft' AND EXISTS (
          SELECT 1 FROM replenishment_request_lines l WHERE l.request_id = replenishment_requests.id
        )
        ORDER BY created_at DESC LIMIT 1`,
    );
    const src = source.rows[0];
    // The seed carries requests across several states; if that ever stops being
    // true this test says so instead of quietly passing on nothing.
    expect(src, 'seed must provide a non-draft replenishment request with lines').toBeTruthy();

    const converted = await withRollbackAs(mgrSession, (client) => {
      const { prService } = buildKit();
      return prService.createFromReplenishment(client, mgr, {
        replenishmentId: src!.id,
        locationId: fx.warehouseId,
        notes: 'tidak bisa dipenuhi dari stok',
      });
    });
    prIds.push(converted.id);

    expect(converted.status).toBe('draft');
    expect(converted.locationId).toBe(fx.warehouseId);
    expect(converted.sourceReplenishmentId).toBe(src!.id);
    expect(converted.sourceReplenishmentNumber).toBe(src!.request_number);
    expect(converted.lines.length).toBeGreaterThan(0);
    // Unpriced on purpose — an invented figure would read as a quote.
    for (const line of converted.lines) expect(line.estPrice).toBe('0.00');

    // The outlet's request is untouched.
    const after = await cleanupPool.query<{ status: string }>(
      `SELECT status FROM replenishment_requests WHERE id = $1`,
      [src!.id],
    );
    expect(after.rows[0]!.status).toBe(src!.status);
  });

  it('PO create -> submit -> approve -> issue -> receive posts purchase_in and updates items.avg_cost (FR-PO-02/03/04)', async () => {
    const mgr = actorFor(fx, RoleKey.MANAGER, null);
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

    const priorAvgCost = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      async (client) => {
        const res = await client.query<{ avg_cost: string }>(
          `SELECT avg_cost FROM items WHERE id = $1`,
          [fx.itemId],
        );
        return res.rows[0]!.avg_cost;
      },
    );

    // Fixed, non-today dates (rather than `new Date()`) so a day-shift regression can't hide behind
    // "today happens to fall on a date the bug doesn't visibly break" — BE-PURCH-FIX regression for the
    // `pg` local-`Date`/`.toISOString()` WITA (UTC+8) calendar-day shift (`common/date-only.util.ts`).
    const orderDate = '2026-06-30';
    const expectedDate = '2026-07-15';

    const created = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.create(client, mgr, {
          supplierId: fx.supplierId,
          locationId: fx.warehouseId,
          orderDate,
          expectedDate,
          lines: [
            { itemId: fx.itemId, qtyOrdered: '20.000', unitId: fx.unitId, unitPrice: '8000.00' },
          ],
        });
      },
    );
    poIds.push(created.id);
    expect(created.status).toBe('draft');
    expect(created.total).toBe('160000.00');
    // Exact round-trip — NOT merely `expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)`, which a
    // one-day-shifted value would pass just as happily.
    expect(created.orderDate).toBe(orderDate);
    expect(created.expectedDate).toBe(expectedDate);
    // CONTRACTS.md §4.11 `PurchaseOrder.approval`/`paymentStatus` — both absent on a fresh draft.
    expect(created.approval).toBeNull();
    expect(created.paymentStatus).toBeNull();

    const submitted = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.submit(client, mgr, created.id);
      },
    );
    // Once submitted, the approval chain is real — `approval` must carry it (never null past 'draft').
    expect(submitted.approval).not.toBeNull();
    expect(submitted.approval!.steps.length).toBeGreaterThan(0);
    expect(submitted.approval!.currentStep).not.toBeNull();

    const approved = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.approve(client, mgr, created.id, undefined);
      },
    );
    expect(approved.status).toBe('approved');
    // `currentStep === null` is the documented finalization signal (@mimi/shared ApprovalDetail) — this
    // single-manager-step chain should be finalized by now.
    expect(approved.approval).not.toBeNull();
    expect(approved.approval!.currentStep).toBeNull();

    const issued = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.issue(client, created.id);
      },
    );
    expect(issued.status).toBe('issued');

    const photoId = await createAttachment(fx.kepalaGudangUserId);
    attachmentIds.push(photoId);

    const received = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { poService } = buildKit();
        return poService.receive(client, kgd, created.id, {
          lines: [
            {
              poLineId: issued.lines[0]!.id,
              qtyReceived: '20.000',
              storageAreaId: fx.storageAreaWarehouse,
            },
          ],
          photoAttachmentIds: [photoId],
        });
      },
    );
    expect(received.status).toBe('received');
    expect(received.lines[0]!.qtyReceived).toBe('20.000');
    expect(received.lines[0]!.qtyDifference).toBe('0.000');
    // `received.paymentStatus` is `'pending'` here — ticket DB-PV-RLS. Migration 095's
    // `payment_verifications_role` RLS policy was `FOR ALL USING (role IN owner,manager,finance)`, a
    // BLANKET restriction with no SELECT carve-out, so `kepala_gudang`'s own session (the role that
    // actually performs receiving, per `purchasing.po.receive`) could never see ANY
    // `payment_verifications` row via the `LEFT JOIN` `PurchaseOrderRepository` now does, even though
    // `createSystemVerification` just inserted one moments ago (that INSERT only ever succeeded
    // because it escalates around itself — `PaymentVerificationsService`'s own "CARRIED ITEM #3" doc
    // comment flags the identical gap on the INSERT `WITH CHECK` side; this was the SELECT-side twin).
    // Fixed by `220_dbpvrls_payment_verifications_fulfilment_select.sql`: a new, command-scoped
    // `FOR SELECT` policy lets fulfilment roles (`app_is_fulfilment_role()`, currently just
    // `kepala_gudang`) read `purchase_order`-linked rows within their own location scope, without
    // touching INSERT/UPDATE/DELETE on this table (still owner/manager/finance-only — see
    // `payment-verifications-fulfilment-rls.spec.ts` for the write-side regression gates). The very
    // next block re-reads the SAME PO as 'owner' and confirms the field matches exactly.
    expect(received.paymentStatus).toBe('pending');

    const asOwner = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.getDetail(client, created.id);
      },
    );
    expect(asOwner.paymentStatus).toBe('pending');

    const afterAvgCost = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      async (client) => {
        const res = await client.query<{ avg_cost: string }>(
          `SELECT avg_cost FROM items WHERE id = $1`,
          [fx.itemId],
        );
        return res.rows[0]!.avg_cost;
      },
    );
    expect(afterAvgCost).not.toBe(priorAvgCost);

    const pv = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) =>
        client.query<{ status: string; ref_type: string }>(
          `SELECT status, ref_type FROM payment_verifications WHERE ref_id = $1`,
          [created.id],
        ),
    );
    expect(pv.rows[0]?.status).toBe('pending');
    expect(pv.rows[0]?.ref_type).toBe('purchase_order');
  });

  it('FR-PO-03 — a short receipt is refused without a reason, then records the ordered-vs-received difference', async () => {
    // The happy path above receives exactly what was ordered and asserts
    // `qtyDifference === '0.000'`. That is the case where the requirement is
    // trivially satisfiable — a field hardcoded to '0.000' would pass it.
    // FR-PO-03 is about the case where the numbers DISAGREE: the supplier
    // short-delivers, and the system has to record by how much and why.
    // Nothing exercised that, in either direction.
    const mgr = actorFor(fx, RoleKey.MANAGER, null);
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

    const created = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.create(client, mgr, {
          supplierId: fx.supplierId,
          locationId: fx.warehouseId,
          orderDate: '2026-06-30',
          expectedDate: '2026-07-15',
          lines: [
            { itemId: fx.itemId, qtyOrdered: '20.000', unitId: fx.unitId, unitPrice: '8000.00' },
          ],
        });
      },
    );
    poIds.push(created.id);

    await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.submit(client, mgr, created.id);
    });
    await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.approve(client, mgr, created.id, undefined);
    });
    const issued = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.issue(client, created.id);
      },
    );

    const photoId = await createAttachment(fx.kepalaGudangUserId);
    attachmentIds.push(photoId);

    // 15 of 20 arrived, with no explanation. Recording a variance nobody has
    // to account for is how shrinkage becomes invisible, so the receipt is
    // refused outright rather than stored with a blank reason.
    await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      async (client) => {
        const { poService } = buildKit();
        await expect(
          poService.receive(client, kgd, created.id, {
            lines: [
              {
                poLineId: issued.lines[0]!.id,
                qtyReceived: '15.000',
                storageAreaId: fx.storageAreaWarehouse,
              },
            ],
            photoAttachmentIds: [photoId],
          }),
        ).rejects.toMatchObject({ response: { code: ERR_VARIANCE_REASON_REQUIRED } });
      },
    );

    // Whitespace is not a reason. Without this the guard above is one
    // `.trim()` away from being decorative.
    await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      async (client) => {
        const { poService } = buildKit();
        await expect(
          poService.receive(client, kgd, created.id, {
            lines: [
              {
                poLineId: issued.lines[0]!.id,
                qtyReceived: '15.000',
                storageAreaId: fx.storageAreaWarehouse,
                conditionNotes: '   ',
              },
            ],
            photoAttachmentIds: [photoId],
          }),
        ).rejects.toMatchObject({ response: { code: ERR_VARIANCE_REASON_REQUIRED } });
      },
    );

    const received = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { poService } = buildKit();
        return poService.receive(client, kgd, created.id, {
          lines: [
            {
              poLineId: issued.lines[0]!.id,
              qtyReceived: '15.000',
              storageAreaId: fx.storageAreaWarehouse,
              conditionNotes: 'Supplier kirim kurang 5 kg, sisa menyusul',
            },
          ],
          photoAttachmentIds: [photoId],
        });
      },
    );

    // The difference itself — the number FR-PO-03 exists to produce.
    expect(received.lines[0]!.qtyReceived).toBe('15.000');
    expect(received.lines[0]!.qtyDifference).toBe('5.000');
    // Still open, because 5 are outstanding. A PO that closed here would
    // strand the shortfall with nothing tracking it.
    expect(received.status).not.toBe('received');

    // Stock moved for what actually arrived, not for what was ordered — the
    // variance must not be paid for twice, once on paper and once in stock.
    const movement = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) =>
        client.query<{ qty: string }>(
          `SELECT m.qty FROM stock_movements m
             JOIN po_receipts r ON r.id = m.ref_id
            WHERE m.ref_type = 'po_receipt' AND r.po_id = $1 AND m.item_id = $2`,
          [created.id, fx.itemId],
        ),
    );
    expect(movement.rows).toHaveLength(1);
    expect(Number(movement.rows[0]!.qty)).toBeCloseTo(15, 3);
  });

  it('PO receiving without a photo is rejected (wajib foto, FR-PO-04)', async () => {
    const mgr = actorFor(fx, RoleKey.MANAGER, null);
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

    const created = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.create(client, mgr, {
          supplierId: fx.supplierId,
          locationId: fx.warehouseId,
          orderDate: new Date().toISOString().slice(0, 10),
          lines: [
            { itemId: fx.itemId, qtyOrdered: '5.000', unitId: fx.unitId, unitPrice: '1000.00' },
          ],
        });
      },
    );
    poIds.push(created.id);

    await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.submit(client, mgr, created.id);
    });
    await withRollbackAs({ role: 'manager', userId: mgr.userId, locationIds: [] }, (client) => {
      const { poService } = buildKit();
      return poService.approve(client, mgr, created.id, undefined);
    });
    const issued = await withRollbackAs(
      { role: 'manager', userId: mgr.userId, locationIds: [] },
      (client) => {
        const { poService } = buildKit();
        return poService.issue(client, created.id);
      },
    );

    await expect(
      withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { poService } = buildKit();
          return poService.receive(client, kgd, created.id, {
            lines: [
              {
                poLineId: issued.lines[0]!.id,
                qtyReceived: '5.000',
                storageAreaId: fx.storageAreaWarehouse,
              },
            ],
            photoAttachmentIds: [],
          });
        },
      ),
    ).rejects.toMatchObject({ response: { code: ERR_PHOTO_REQUIRED } });
  });

  it('a Supervisor creating a PR outside their assigned location gets a real ERR_FORBIDDEN (permission denied pin)', async () => {
    const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);

    await expect(
      withRollbackAs(
        { role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] },
        (client) => {
          const { prService } = buildKit();
          return prService.create(client, spv, {
            locationId: fx.warehouseId,
            lines: [{ itemId: fx.itemId, qty: '1.000', unitId: fx.unitId }],
          });
        },
      ),
    ).rejects.toMatchObject({ response: { code: ERR_FORBIDDEN } });
  });

  it('petty cash create (Leader Outlet) -> verify (Finance) posts purchase_in for a stockable line and requires both photos (PRD 8.6.1)', async () => {
    const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
    const fin = actorFor(fx, RoleKey.FINANCE, null);

    const proofId = await createAttachment(fx.leaderOutletUserId, 'payment_proof');
    const photoId = await createAttachment(fx.leaderOutletUserId, 'petty_cash_photo');
    attachmentIds.push(proofId, photoId);

    // Fixed date (not `new Date()`) — same day-shift regression rationale as the PO/PR tests above.
    const purchaseDate = '2026-03-01';

    const created = await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { pcService } = buildKit();
        return pcService.create(client, ldr, {
          locationId: fx.outletId,
          purchaseDate,
          storeName: 'Toko Kelontong Pak Budi',
          lines: [
            {
              description: 'Bawang merah',
              itemId: fx.itemId,
              storageAreaId: fx.storageAreaOutlet,
              qty: '2.000',
              amount: '30000.00',
              expenseCategory: 'operasional',
            },
          ],
          paymentProofAttachmentId: proofId,
          goodsPhotoAttachmentId: photoId,
        });
      },
    );
    pcIds.push(created.id);
    expect(created.status).toBe('pending');
    expect(created.totalAmount).toBe('30000.00');
    expect(created.photoUrls.sort()).toEqual([proofId, photoId].sort());
    // Exact round-trip — `petty_cash.purchase_date` is a `DATE` column (same `pg`/WITA pitfall).
    expect(created.purchaseDate).toBe(purchaseDate);

    const balBefore = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) =>
        client.query<{ qty_on_hand: string }>(
          `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [fx.outletId, fx.storageAreaOutlet, fx.itemId],
        ),
    );

    const verified = await withRollbackAs(
      { role: 'finance', userId: fin.userId, locationIds: [] },
      (client) => {
        const { pcService } = buildKit();
        return pcService.verify(client, fin, created.id, undefined);
      },
    );
    expect(verified.status).toBe('verified');

    const balAfter = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) =>
        client.query<{ qty_on_hand: string }>(
          `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [fx.outletId, fx.storageAreaOutlet, fx.itemId],
        ),
    );
    const before = Number(balBefore.rows[0]?.qty_on_hand ?? '0');
    const afterQty = Number(balAfter.rows[0]!.qty_on_hand);
    expect(afterQty - before).toBeCloseTo(2, 3);

    const pv = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) =>
        client.query<{ status: string; ref_type: string }>(
          `SELECT status, ref_type FROM payment_verifications WHERE ref_id = $1`,
          [created.id],
        ),
    );
    expect(pv.rows[0]?.ref_type).toBe('petty_cash');
  });
});
