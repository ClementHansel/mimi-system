/**
 * Integration tests against the LIVE database for M12 `waste-return`
 * (CONTRACTS.md §4.12, §5.5/§5.6). Wired by hand (`new`) — every dependency
 * is a REAL kernel class, never a mock.
 *
 * Same lifecycle-per-request pattern as
 * `modules/purchasing/purchasing.integration.spec.ts` (see that file's
 * header): every mutating method here SELF-COMMITS (`db-tx.ts`'s
 * `withWrite()`), so each step of a flow opens its OWN `withRollbackAs` —
 * one call = one simulated HTTP request — and rows are cleaned up via the
 * owner pool afterward.
 *
 * Exercises BOTH retur directions with their genuinely different step-1
 * approvers (outlet→gudang: Supervisor; gudang→supplier: Kepala Gudang —
 * `kernel/approvals`' `document-context.resolver.ts` resolves this from
 * `returns.direction` itself), plus a real `ERR_APPROVAL_STEP_ROLE` pin
 * showing a Supervisor cannot approve the supplier leg.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ERR_NOT_FOUND,
  ERR_PHOTO_REQUIRED,
  ERR_VALIDATION,
  ReturnDirection,
  RoleKey,
  WasteReason,
} from '@mimi/shared';
import { Pool } from 'pg';

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

import { WasteRepository } from './waste.repository';
import { WasteService, type ActorContext } from './waste.service';
import { ReturnRepository } from './return.repository';
import { ReturnService } from './return.service';
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

function buildKit() {
  const events = new SyncEventsRepository(appPoolForDi());
  const conflicts = new SyncConflictsRepository();
  const conflictDetector = new ConflictDetectorService(events, conflicts);
  const sync = new SyncEmitService(events, conflictDetector);
  const ledger = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));
  const approvals = new ApprovalService(new ApprovalsRepository());

  // B-16: `WasteService`/`ReturnService` now publish `journal.action` (JOUT-04/05, JGUD-04/05) —
  // a fresh, unsubscribed `EventBus` here is deliberate: this file exercises the waste/return
  // lifecycle itself, not the GL leg (that is `waste-gl-posting.spec.ts`/`return-gl-posting.spec.ts`),
  // so `publish()` simply finding no handlers and no-op'ing is correct, not a gap.
  const wasteService = new WasteService(
    new WasteRepository(),
    approvals,
    ledger,
    sync,
    new EventBus(),
  );
  const returnService = new ReturnService(
    new ReturnRepository(),
    approvals,
    ledger,
    sync,
    new EventBus(),
  );
  return { wasteService, returnService };
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

/**
 * QA-ISOLATION finding: `stock_movements` rows this suite posts durably increment
 * `stock_balances.qty_on_hand` (real `StockLedgerService` calls, self-committed — see file
 * header). The two cleanup functions below used to delete the ref-scoped `stock_movements`
 * rows and stop there, leaving the balance permanently reflecting a movement that no longer
 * exists — a silent leak `stock-ledger.integration.spec.ts`'s G1 invariant (balance == fold
 * of movements, checked against the WHOLE table from a later file in the same live DB)
 * catches. Capture the touched (location, storage_area, item) keys before deleting, then
 * reconcile the balance to the fold of whatever movements remain — never blind-delete the
 * balance row itself, since the key may carry real seed history this suite never touched.
 */
async function deletedMovementKeys(
  refType: string,
  refIdCondition: string,
  params: unknown[],
): Promise<{ location_id: string; storage_area_id: string; item_id: string }[]> {
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
  return keys.rows;
}

async function cleanupWasteBatch(batchId: string): Promise<void> {
  const rows = await cleanupPool.query<{ id: string }>(
    `SELECT id FROM waste_records WHERE batch_id = $1`,
    [batchId],
  );
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
    const keys = await deletedMovementKeys('waste_record', `ref_id = $1`, [row.id]);
    for (const key of keys)
      await reconcileStockBalance(key.location_id, key.storage_area_id, key.item_id);
  }
  await cleanupPool.query(`DELETE FROM waste_records WHERE batch_id = $1`, [batchId]);
}

async function cleanupReturn(id: string): Promise<void> {
  await cleanupPool.query(`UPDATE returns SET approval_id = NULL WHERE id = $1`, [id]);
  const keys = await deletedMovementKeys('return', `ref_id = $1`, [id]);
  for (const key of keys)
    await reconcileStockBalance(key.location_id, key.storage_area_id, key.item_id);
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

describe('Waste & Return — live database', () => {
  let fx: Fixtures;
  const attachmentIds: string[] = [];
  const batchIds: string[] = [];
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
    await ensureStock(fx.outletId, fx.storageAreaOutlet, fx.itemId2, '100.000');
    await ensureStock(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId2, '100.000');
  });

  afterEach(async () => {
    while (attachmentIds.length) await deleteAttachment(attachmentIds.pop()!);
    while (batchIds.length) await cleanupWasteBatch(batchIds.pop()!);
    while (returnIds.length) await cleanupReturn(returnIds.pop()!);
  });

  afterAll(async () => {
    // Reconcile the 4 keys `beforeAll`'s `ensureStock` bootstrapped directly (no matching
    // `stock_movements` row for the bootstrap itself — see that function's header) back to
    // the fold of whatever movements this suite's own tests actually posted against them.
    await reconcileStockBalance(fx.outletId, fx.storageAreaOutlet, fx.itemId);
    await reconcileStockBalance(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId);
    await reconcileStockBalance(fx.outletId, fx.storageAreaOutlet, fx.itemId2);
    await reconcileStockBalance(fx.warehouseId, fx.storageAreaWarehouse, fx.itemId2);
    await cleanupPool.end();
    await closePool();
  });

  it('waste create (Leader Outlet) -> approve (Supervisor, outlet step) posts waste_out (FR-WST-01 / FR-WST-02/04)', async () => {
    const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
    const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);

    const photoId = await createAttachment(fx.leaderOutletUserId, 'waste_photo');
    attachmentIds.push(photoId);

    const created = await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { wasteService } = buildKit();
        return wasteService.create(client, ldr, {
          locationId: fx.outletId,
          items: [
            {
              storageAreaId: fx.storageAreaOutlet,
              itemId: fx.itemId,
              qty: '3.000',
              reason: WasteReason.EXPIRED,
              reasonDetail: 'Kadaluarsa',
            },
          ],
          photoAttachmentIds: [photoId],
        });
      },
    );
    expect(created).toHaveLength(1);
    batchIds.push(created[0]!.batchId);
    expect(created[0]!.status).toBe('pending');
    expect(created[0]!.photoUrls).toEqual([photoId]);

    const before = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) =>
        client.query<{ qty_on_hand: string }>(
          `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [fx.outletId, fx.storageAreaOutlet, fx.itemId],
        ),
    );

    const approved = await withRollbackAs(
      { role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] },
      (client) => {
        const { wasteService } = buildKit();
        return wasteService.approve(client, spv, created[0]!.batchId, {});
      },
    );
    expect(approved[0]!.status).toBe('approved');

    const after = await withRollbackAs(
      { role: 'owner', userId: fx.usersByRole[RoleKey.OWNER], locationIds: [] },
      (client) =>
        client.query<{ qty_on_hand: string }>(
          `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
          [fx.outletId, fx.storageAreaOutlet, fx.itemId],
        ),
    );
    expect(Number(before.rows[0]!.qty_on_hand) - Number(after.rows[0]!.qty_on_hand)).toBeCloseTo(
      3,
      3,
    );
  });

  it('waste create without a photo is rejected (wajib foto, FR-WST-01)', async () => {
    const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
    await expect(
      withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { wasteService } = buildKit();
          return wasteService.create(client, ldr, {
            locationId: fx.outletId,
            items: [
              {
                storageAreaId: fx.storageAreaOutlet,
                itemId: fx.itemId,
                qty: '1.000',
                reason: WasteReason.DAMAGED,
              },
            ],
            photoAttachmentIds: [],
          });
        },
      ),
    ).rejects.toMatchObject({ response: { code: ERR_PHOTO_REQUIRED } });
  });

  it('FR-WST-03 — return outlet -> warehouse: create -> submit -> approve (Supervisor) -> ship -> receive (Kepala Gudang) -> complete (FR-WST-01..04, §5.5)', async () => {
    const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
    const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

    const creationPhoto = await createAttachment(fx.leaderOutletUserId, 'defect_photo');
    attachmentIds.push(creationPhoto);

    const created = await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
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
    expect(created.status).toBe('draft');

    await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.submit(client, ldr, created.id);
      },
    );

    const approved = await withRollbackAs(
      { role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.approve(client, spv, created.id, undefined);
      },
    );
    expect(approved.status).toBe('approved');

    const proofShip = await createAttachment(fx.leaderOutletUserId, 'return_proof');
    attachmentIds.push(proofShip);
    const shipped = await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.ship(client, ldr, created.id, { proofAttachmentIds: [proofShip] });
      },
    );
    expect(shipped.status).toBe('in_transit');

    const proofReceive = await createAttachment(fx.kepalaGudangUserId, 'receiving_photo');
    attachmentIds.push(proofReceive);
    const received = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.receive(client, kgd, created.id, {
          lines: [
            {
              lineId: shipped.lines[0]!.lineId,
              qtyReceived: '2.000',
              storageAreaId: fx.storageAreaWarehouse,
            },
          ],
          proofAttachmentIds: [proofReceive],
        });
      },
    );
    expect(received.status).toBe('received');

    const completed = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.complete(client, created.id, {});
      },
    );
    expect(completed.status).toBe('completed');
  });

  it('a return with two lines is keyed by a stable lineId, not itemId — each line receives its OWN qty independently (coordinator W4-08 pin)', async () => {
    // `return_lines` carries `UNIQUE (return_id, item_id)` (migration block 081) — two lines can never
    // share ONE item within a return, so this test uses two DIFFERENT items to exercise the thing that
    // actually matters here: `GET /returns/:id`'s `lines[].lineId` must be a real, distinct per-line
    // key the receive call can bind to, not a derived/duplicated value — the exact gap W4-08 hit
    // building the warehouse receive form (they had `itemId` only, with no stable per-line identifier).
    const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
    const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);

    const creationPhoto = await createAttachment(fx.leaderOutletUserId, 'defect_photo');
    attachmentIds.push(creationPhoto);

    const created = await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.create(client, ldr, {
          direction: ReturnDirection.OUTLET_TO_WAREHOUSE,
          fromLocationId: fx.outletId,
          toLocationId: fx.warehouseId,
          lines: [
            {
              itemId: fx.itemId,
              storageAreaId: fx.storageAreaOutlet,
              qty: '5.000',
              condition: 'damaged' as never,
              reason: 'Kemasan rusak',
            },
            {
              itemId: fx.itemId2,
              storageAreaId: fx.storageAreaOutlet,
              qty: '4.000',
              condition: 'expired' as never,
              reason: 'Kadaluarsa',
            },
          ],
          photoAttachmentIds: [creationPhoto],
        });
      },
    );
    returnIds.push(created.id);
    expect(created.lines).toHaveLength(2);
    const [lineA, lineB] = created.lines;
    // The real bug this pins: every line MUST carry its own `lineId`, and it must be distinct per line
    // (not silently reusing the parent return's id, or one line's id for both).
    expect(lineA!.lineId).toBeTruthy();
    expect(lineB!.lineId).toBeTruthy();
    expect(lineA!.lineId).not.toBe(lineB!.lineId);
    expect(lineA!.lineId).not.toBe(created.id);

    await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.submit(client, ldr, created.id);
      },
    );
    await withRollbackAs(
      { role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.approve(client, spv, created.id, undefined);
      },
    );
    const proofShip = await createAttachment(fx.leaderOutletUserId, 'return_proof');
    attachmentIds.push(proofShip);
    const shipped = await withRollbackAs(
      { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.ship(client, ldr, created.id, { proofAttachmentIds: [proofShip] });
      },
    );

    const shippedLineForItem = (itemId: string) => shipped.lines.find((l) => l.itemId === itemId)!;

    // Received with DIFFERENT quantities per line, addressed purely by `lineId` — proves a client can
    // key off `lineId` alone and never needs to fall back to `itemId` disambiguation.
    const proofReceive = await createAttachment(fx.kepalaGudangUserId, 'receiving_photo');
    attachmentIds.push(proofReceive);
    const received = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.receive(client, kgd, created.id, {
          lines: [
            {
              lineId: shippedLineForItem(fx.itemId).lineId,
              qtyReceived: '5.000',
              storageAreaId: fx.storageAreaWarehouse,
            },
            {
              lineId: shippedLineForItem(fx.itemId2).lineId,
              qtyReceived: '3.000',
              storageAreaId: fx.storageAreaWarehouse,
            },
          ],
          proofAttachmentIds: [proofReceive],
        });
      },
    );
    expect(received.status).toBe('received');

    const receivedLineA = received.lines.find((l) => l.itemId === fx.itemId)!;
    const receivedLineB = received.lines.find((l) => l.itemId === fx.itemId2)!;
    expect(receivedLineA.qtyReceived).toBe('5.000');
    expect(receivedLineB.qtyReceived).toBe('3.000');
  });

  it('a return with the same item repeated across two lines is rejected cleanly (return_lines UNIQUE(return_id, item_id) — the ambiguity a lineId key exists to prevent structurally cannot arise)', async () => {
    const ldr = actorFor(fx, RoleKey.LEADER_OUTLET, [fx.outletId]);
    const photoId = await createAttachment(fx.leaderOutletUserId, 'defect_photo');
    attachmentIds.push(photoId);
    await expect(
      withRollbackAs(
        { role: 'leader_outlet', userId: ldr.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit();
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
                reason: 'Sebagian rusak',
              },
              {
                itemId: fx.itemId,
                storageAreaId: fx.storageAreaOutlet,
                qty: '1.000',
                condition: 'expired' as never,
                reason: 'Sebagian kadaluarsa',
              },
            ],
            photoAttachmentIds: [photoId],
          });
        },
      ),
    ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });
  });

  it('return warehouse -> supplier: different step-1 approver (Kepala Gudang, not Supervisor) — §5.6, and a real ERR_APPROVAL_STEP_ROLE permission-denied pin', async () => {
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
    const spv = actorFor(fx, RoleKey.SUPERVISOR, [fx.outletId]);

    const creationPhoto = await createAttachment(fx.kepalaGudangUserId, 'defect_photo');
    attachmentIds.push(creationPhoto);

    const created = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { returnService } = buildKit();
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
        const { returnService } = buildKit();
        return returnService.submit(client, kgd, created.id);
      },
    );

    // Permission-denied pin: a Supervisor (the outlet-leg approver, scoped only to their own outlet)
    // has no authority over the supplier leg at all — `returns`' own location-scoped RLS (CONTRACTS.md
    // §1.14) hides the warehouse-origin row from their session entirely (a real `ERR_NOT_FOUND`, not a
    // silent allow) before the request could ever reach the approval-role check.
    await expect(
      withRollbackAs(
        { role: 'supervisor', userId: spv.userId, locationIds: [fx.outletId] },
        (client) => {
          const { returnService } = buildKit();
          return returnService.approve(client, spv, created.id, undefined);
        },
      ),
    ).rejects.toMatchObject({ response: { code: ERR_NOT_FOUND } });

    const approved = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.approve(client, kgd, created.id, undefined);
      },
    );
    expect(approved.status).toBe('approved');

    const proofShip = await createAttachment(fx.kepalaGudangUserId, 'return_proof');
    attachmentIds.push(proofShip);
    const shipped = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.ship(client, kgd, created.id, { proofAttachmentIds: [proofShip] });
      },
    );
    expect(shipped.status).toBe('in_transit');

    const completed = await withRollbackAs(
      { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
      (client) => {
        const { returnService } = buildKit();
        return returnService.complete(client, created.id, { creditNoteRef: 'CN-TEST-001' });
      },
    );
    expect(completed.status).toBe('completed');
  });

  it('return without a supplierId for warehouse_to_supplier is rejected', async () => {
    const kgd = actorFor(fx, RoleKey.KEPALA_GUDANG, [fx.warehouseId]);
    await expect(
      withRollbackAs(
        { role: 'kepala_gudang', userId: kgd.userId, locationIds: [fx.warehouseId] },
        (client) => {
          const { returnService } = buildKit();
          return returnService.create(client, kgd, {
            direction: ReturnDirection.WAREHOUSE_TO_SUPPLIER,
            fromLocationId: fx.warehouseId,
            lines: [
              {
                itemId: fx.itemId,
                storageAreaId: fx.storageAreaWarehouse,
                qty: '1.000',
                condition: 'other' as never,
                reason: 'x',
              },
            ],
            photoAttachmentIds: [],
          });
        },
      ),
    ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });
  });
});
