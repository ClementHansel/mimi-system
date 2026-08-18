import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import {
  MovementType,
  OnlineOrderStatus,
  OnlinePlatform,
  PaymentMethod,
  PaymentStatus,
  SyncOriginType,
  VoidRefundType,
} from '@mimi/shared';
import { formatUuidV7, type SyncEventEnvelope, type SyncPushBatch } from '@mimi/sync-protocol';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { OfflineCredentialsRepository } from '../../kernel/sync/offline-credentials.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { OfflineAuthService } from '../../kernel/sync/offline-auth.service';
import { ReconciliationService } from '../../kernel/sync/reconciliation.service';
import { RegistryRepository } from '../../kernel/sync/registry.repository';
import { SyncIngestService } from '../../kernel/sync/sync-ingest.service';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import { PosShiftService } from './services/pos-shift.service';
import { PosSaleService } from './services/pos-sale.service';
import { PosVoidRefundService } from './services/pos-void-refund.service';
import { PosOnlineOrderService } from './services/pos-online-order.service';
import { PosSyncProjector } from './services/pos-sync-projector.service';
import {
  buildApprovalService,
  buildEventBus,
  buildNotificationService,
  buildPaymentVerificationsService,
  buildStockLedgerService,
  buildSyncEmitService,
  closePool,
  getAppPool,
  getOwnerPool,
  loadOutletFixture,
  withRollback,
  type OutletFixture,
} from './test-support/live-db';

/**
 * Proves the coordinator's brief: the domain-projection hook (`kernel/sync`'s
 * `SyncProjector`) actually turns a genuinely offline-shaped `sales.completed`
 * (+ its `pos_shifts.opened` sibling) into real `sales`/`sale_lines`/
 * `sale_payments` rows and a `StockLedgerService.post(..., 'fact')` call —
 * through the REAL `SyncIngestService.ingestBatch`, not a hand-rolled
 * shortcut. `ingestBatch` commits per-origin durably (SYNC-PROTOCOL §4.3),
 * so — unlike this module's other suites — this file does NOT use
 * `withRollback` for its ingest test; it cleans up explicitly afterward
 * (recomputing `stock_balances` from the remaining `stock_movements` rather
 * than snapshot/restore, so it is correct regardless of what else the shared
 * dev database is doing concurrently).
 *
 * The narrower guarantees (idempotent even bypassing the registry's own
 * dedupe, `'fact'`-mode negative-balance handling, `isConflictLoser`
 * semantics) are proven via DIRECT `PosSyncProjector.project()` calls inside
 * `withRollback` instead — nothing durable to clean up, and it isolates
 * exactly the behavior each requirement is about.
 */

function services(pool: Pool) {
  const eventBus = buildEventBus();
  const stockLedger = buildStockLedgerService(eventBus);
  const notifications = buildNotificationService(pool);
  const approvals = buildApprovalService();
  const syncEmit = buildSyncEmitService(pool);
  const shifts = new PosShiftService(pool, approvals, notifications);
  const sales = new PosSaleService(pool, stockLedger, buildPaymentVerificationsService(pool));
  const voidRefunds = new PosVoidRefundService(
    pool,
    approvals,
    stockLedger,
    syncEmit,
    notifications,
    eventBus,
  );
  const onlineOrders = new PosOnlineOrderService(stockLedger);
  const projector = new PosSyncProjector(shifts, sales, voidRefunds, onlineOrders);
  return { shifts, sales, voidRefunds, onlineOrders, projector, stockLedger };
}

function mkEvent(params: {
  originDeviceId: string;
  clientSeq: number;
  locationId: string;
  entity: string;
  entityId: string;
  op: string;
  data: unknown;
  actorUserId: string;
  occurredAt?: string;
}): SyncEventEnvelope {
  return {
    eventId: formatUuidV7(Date.now() + params.clientSeq, randomBytes(16)),
    originTier: SyncOriginType.DEVICE,
    originDeviceId: params.originDeviceId,
    locationId: params.locationId,
    entity: params.entity,
    entityId: params.entityId,
    op: params.op,
    payload: {
      v: 1,
      data: params.data,
      meta: { actorUserId: params.actorUserId, actorRole: 'kasir', appVersion: '1.0.0' },
    },
    clientSeq: BigInt(params.clientSeq),
    occurredAt: params.occurredAt ?? new Date().toISOString(),
    actorUserId: params.actorUserId,
    schemaV: 1,
  };
}

function batchOf(events: SyncEventEnvelope[]): SyncPushBatch {
  return { batchId: randomUUID(), sentAt: new Date().toISOString(), events };
}

/** Deletes exactly the rows this suite's REAL-INGEST test created, recomputing `stock_balances` from the remaining `stock_movements` for every key it touched — never a snapshot/restore (safe under concurrent activity from other agents on this shared dev database). */
async function cleanupRealIngestArtifacts(
  ownerPool: Pool,
  params: { originDeviceId: string; saleId: string; shiftId: string },
): Promise<void> {
  const keys = await ownerPool.query<{
    location_id: string;
    storage_area_id: string;
    item_id: string;
  }>(
    `SELECT DISTINCT location_id, storage_area_id, item_id FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1`,
    [params.saleId],
  );
  await ownerPool.query(`DELETE FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1`, [
    params.saleId,
  ]);
  for (const k of keys.rows) {
    const sum = await ownerPool.query<{ total: string }>(
      `SELECT COALESCE(SUM(CASE WHEN movement_type LIKE '%_in' THEN qty ELSE -qty END), 0) AS total
         FROM stock_movements WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
      [k.location_id, k.storage_area_id, k.item_id],
    );
    await ownerPool.query(
      `UPDATE stock_balances SET qty_on_hand = $4 WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
      [k.location_id, k.storage_area_id, k.item_id, sum.rows[0]!.total],
    );
  }
  await ownerPool.query(`DELETE FROM void_refunds WHERE sale_id = $1`, [params.saleId]);
  await ownerPool.query(`DELETE FROM sales WHERE id = $1`, [params.saleId]); // cascades sale_lines/sale_payments
  await ownerPool.query(`DELETE FROM pos_shifts WHERE id = $1`, [params.shiftId]);
  await ownerPool.query(
    `DELETE FROM sync_conflicts WHERE loser_event_id IN (SELECT event_id FROM sync_events WHERE origin_device_id = $1) OR winner_event_id IN (SELECT event_id FROM sync_events WHERE origin_device_id = $1)`,
    [params.originDeviceId],
  );
  await ownerPool.query(`DELETE FROM sync_events WHERE origin_device_id = $1`, [
    params.originDeviceId,
  ]);
  await ownerPool.query(`DELETE FROM sync_batches WHERE origin_device_id = $1`, [
    params.originDeviceId,
  ]);
  await ownerPool.query(`DELETE FROM sync_cursors WHERE subscriber_id = $1`, [
    params.originDeviceId,
  ]);
}

let fx: OutletFixture;

beforeAll(async () => {
  fx = await loadOutletFixture();
}, 30_000);

afterAll(async () => {
  await closePool();
});

describe('PosSyncProjector — the domain-projection hook, real ingest, live database', () => {
  it('a real offline-shaped shift + sale (bank_transfer) syncs through real SyncIngestService.ingestBatch into real sales/sale_lines/sale_payments rows with the correct payment status, posts stock, and is idempotent on replay', async () => {
    const pool = getAppPool();
    const ownerPool = getOwnerPool();
    const svc = services(pool);

    const eventsRepo = new SyncEventsRepository(pool);
    const conflictsRepo = new SyncConflictsRepository();
    const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
    const fakeConfig = { get: (_k: string, def?: string) => def } as never;
    const offlineAuth = new OfflineAuthService(
      new OfflineCredentialsRepository(),
      conflictsRepo,
      fakeConfig,
    );
    const reconciliation = new ReconciliationService(
      pool,
      eventsRepo,
      conflictsRepo,
      new RegistryRepository(pool),
    );
    const projectors = new SyncProjectorRegistry();
    projectors.register(svc.projector);
    const ingest = new SyncIngestService(
      eventsRepo,
      conflictDetector,
      offlineAuth,
      reconciliation,
      projectors,
    );

    const originDeviceId = randomUUID();
    const shiftId = randomUUID();
    const saleId = randomUUID();
    const shiftClientId = randomUUID();
    const saleClientId = randomUUID();
    const resolveLocation = async (id: string) =>
      id === originDeviceId ? fx.locationId : undefined;

    try {
      const shiftOpenedEvent = mkEvent({
        originDeviceId,
        clientSeq: 1,
        locationId: fx.locationId,
        entity: 'pos_shifts',
        entityId: shiftId,
        op: 'opened',
        actorUserId: fx.kasirId,
        data: {
          clientId: shiftClientId,
          locationId: fx.locationId,
          openingCash: '100000.00',
          openedAt: new Date().toISOString(),
          shiftNumber: `${fx.locationCode}-SIM1-S1`,
        },
      });
      const saleEvent = mkEvent({
        originDeviceId,
        clientSeq: 2,
        locationId: fx.locationId,
        entity: 'sales',
        entityId: saleId,
        op: 'completed',
        actorUserId: fx.kasirId,
        data: {
          clientId: saleClientId,
          locationId: fx.locationId,
          shiftId,
          occurredAt: new Date().toISOString(),
          lines: [{ productId: fx.productId, qty: '1.000', unitPrice: fx.productPrice }],
          // Bank transfer specifically — proves FR-ACCT-03's ladder survives the offline path.
          payments: [{ method: PaymentMethod.BANK_TRANSFER, amount: fx.productPrice }],
          receiptNumber: `${fx.locationCode}-SIM1-1`,
        },
      });

      const ack = await ingest.ingestBatch(batchOf([shiftOpenedEvent, saleEvent]), resolveLocation);
      expect(ack.rejected).toEqual([]);
      expect(ack.acceptedThrough[originDeviceId]).toBe(2);

      const shiftRow = await ownerPool.query(
        `SELECT id, status, shift_number FROM pos_shifts WHERE id = $1`,
        [shiftId],
      );
      expect(shiftRow.rows[0]?.status).toBe('open');
      expect(shiftRow.rows[0]?.shift_number).toBe(`${fx.locationCode}-SIM1-S1`);

      const saleRow = await ownerPool.query(
        `SELECT id, status, receipt_number, client_id FROM sales WHERE id = $1`,
        [saleId],
      );
      expect(saleRow.rows[0]?.status).toBe('completed');
      expect(saleRow.rows[0]?.receipt_number).toBe(`${fx.locationCode}-SIM1-1`);
      expect(saleRow.rows[0]?.client_id).toBe(saleClientId);

      const lineRows = await ownerPool.query(
        `SELECT product_id FROM sale_lines WHERE sale_id = $1`,
        [saleId],
      );
      expect(lineRows.rows).toHaveLength(1);

      const paymentRows = await ownerPool.query(
        `SELECT method, payment_status FROM sale_payments WHERE sale_id = $1`,
        [saleId],
      );
      expect(paymentRows.rows).toHaveLength(1);
      // Requirement 4: an offline transfer sale lands `pending`, never `paid`.
      expect(paymentRows.rows[0]?.method).toBe(PaymentMethod.BANK_TRANSFER);
      expect(paymentRows.rows[0]?.payment_status).toBe(PaymentStatus.PENDING);

      const movementRows = await ownerPool.query(
        `SELECT movement_type FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1`,
        [saleId],
      );
      expect(movementRows.rows.length).toBeGreaterThan(0);
      expect(movementRows.rows.every((r) => r.movement_type === MovementType.USAGE_OUT)).toBe(true);

      // ── Replay the identical batch — the registry's own event-id dedupe must make this a no-op ──
      const replayAck = await ingest.ingestBatch(
        batchOf([shiftOpenedEvent, saleEvent]),
        resolveLocation,
      );
      expect(replayAck.rejected).toEqual([]);

      const saleCountAfterReplay = await ownerPool.query(
        `SELECT COUNT(*) FROM sales WHERE id = $1`,
        [saleId],
      );
      expect(Number(saleCountAfterReplay.rows[0]!.count)).toBe(1);
      const lineCountAfterReplay = await ownerPool.query(
        `SELECT COUNT(*) FROM sale_lines WHERE sale_id = $1`,
        [saleId],
      );
      expect(Number(lineCountAfterReplay.rows[0]!.count)).toBe(1);
      const paymentCountAfterReplay = await ownerPool.query(
        `SELECT COUNT(*) FROM sale_payments WHERE sale_id = $1`,
        [saleId],
      );
      expect(Number(paymentCountAfterReplay.rows[0]!.count)).toBe(1);
      const movementCountAfterReplay = await ownerPool.query(
        `SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1`,
        [saleId],
      );
      expect(Number(movementCountAfterReplay.rows[0]!.count)).toBe(movementRows.rows.length);
    } finally {
      await cleanupRealIngestArtifacts(ownerPool, { originDeviceId, saleId, shiftId });
    }
  }, 30_000);
});

describe('PosSyncProjector — direct-call guarantees (rolled back, no cleanup needed)', () => {
  it("is idempotent even when called TWICE for the same event, bypassing SyncProjectorRegistry's own dedupe entirely", async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'owner', locationIds: [] },
      async (client) => {
        const svc = services(getAppPool());

        const shiftId = randomUUID();
        const saleId = randomUUID();
        const originDeviceId = randomUUID();

        const shiftEvent = mkEvent({
          originDeviceId,
          clientSeq: 1,
          locationId: fx.locationId,
          entity: 'pos_shifts',
          entityId: shiftId,
          op: 'opened',
          actorUserId: fx.kasirId,
          data: {
            clientId: randomUUID(),
            locationId: fx.locationId,
            openingCash: '50000.00',
            openedAt: new Date().toISOString(),
            shiftNumber: `${fx.locationCode}-SIM2-S1`,
          },
        });
        await svc.projector.project(client, shiftEvent, { isConflictLoser: false });

        const saleEvent = mkEvent({
          originDeviceId,
          clientSeq: 2,
          locationId: fx.locationId,
          entity: 'sales',
          entityId: saleId,
          op: 'completed',
          actorUserId: fx.kasirId,
          data: {
            clientId: randomUUID(),
            locationId: fx.locationId,
            shiftId,
            occurredAt: new Date().toISOString(),
            lines: [{ productId: fx.productId, qty: '1.000', unitPrice: fx.productPrice }],
            payments: [{ method: PaymentMethod.CASH, amount: fx.productPrice }],
            receiptNumber: `${fx.locationCode}-SIM2-1`,
          },
        });

        // Called TWICE, directly — the registry's own event-id skip never enters into this at all.
        await svc.projector.project(client, saleEvent, { isConflictLoser: false });
        await svc.projector.project(client, saleEvent, { isConflictLoser: false });

        const saleCount = await client.query(`SELECT COUNT(*) FROM sales WHERE id = $1`, [saleId]);
        expect(Number(saleCount.rows[0].count)).toBe(1);
        const lineCount = await client.query(`SELECT COUNT(*) FROM sale_lines WHERE sale_id = $1`, [
          saleId,
        ]);
        expect(Number(lineCount.rows[0].count)).toBe(1);
        const paymentCount = await client.query(
          `SELECT COUNT(*) FROM sale_payments WHERE sale_id = $1`,
          [saleId],
        );
        expect(Number(paymentCount.rows[0].count)).toBe(1);
        const movementCount = await client.query(
          `SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1`,
          [saleId],
        );
        const firstCount = Number(movementCount.rows[0].count);
        expect(firstCount).toBeGreaterThan(0);

        // A THIRD direct call — still exactly the same movement count (StockLedgerService's own natural-key dedup).
        await svc.projector.project(client, saleEvent, { isConflictLoser: false });
        const movementCountAgain = await client.query(
          `SELECT COUNT(*) FROM stock_movements WHERE ref_type = 'sale' AND ref_id = $1`,
          [saleId],
        );
        expect(Number(movementCountAgain.rows[0].count)).toBe(firstCount);
      },
    );
  }, 30_000);

  it('"fact" mode: a replayed sale drives a balance negative rather than being rejected, and opens a stock_reconciliations exception', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'owner', locationIds: [] },
      async (client) => {
        const svc = services(getAppPool());

        const shiftId = randomUUID();
        const originDeviceId = randomUUID();
        await svc.projector.project(
          client,
          mkEvent({
            originDeviceId,
            clientSeq: 1,
            locationId: fx.locationId,
            entity: 'pos_shifts',
            entityId: shiftId,
            op: 'opened',
            actorUserId: fx.kasirId,
            data: {
              clientId: randomUUID(),
              locationId: fx.locationId,
              openingCash: '50000.00',
              openedAt: new Date().toISOString(),
              shiftNumber: `${fx.locationCode}-SIM3-S1`,
            },
          }),
          { isConflictLoser: false },
        );

        // Force every ingredient this product's recipe touches deep into negative territory first, so
        // ANY usage_out this sale posts is guaranteed to push the balance further negative — proving
        // 'fact' mode applies the movement (and opens a reconciliation exception) rather than throwing.
        const recipeItems = await client.query<{ item_id: string; unit_id: string }>(
          `SELECT rl.item_id, rl.unit_id
           FROM recipes r JOIN recipe_lines rl ON rl.recipe_id = r.id
          WHERE r.product_id = $1 AND r.is_active`,
          [fx.productId],
        );
        expect(recipeItems.rows.length).toBeGreaterThan(0);
        for (const row of recipeItems.rows) {
          await client.query(
            `INSERT INTO stock_balances (location_id, storage_area_id, item_id, qty_on_hand)
           VALUES ($1, $2, $3, '-1000.000')
           ON CONFLICT (location_id, storage_area_id, item_id) DO UPDATE SET qty_on_hand = '-1000.000'`,
            [fx.locationId, fx.kitchenLineAreaId, row.item_id],
          );
        }

        const saleId = randomUUID();
        await svc.projector.project(
          client,
          mkEvent({
            originDeviceId,
            clientSeq: 2,
            locationId: fx.locationId,
            entity: 'sales',
            entityId: saleId,
            op: 'completed',
            actorUserId: fx.kasirId,
            data: {
              clientId: randomUUID(),
              locationId: fx.locationId,
              shiftId,
              occurredAt: new Date().toISOString(),
              lines: [{ productId: fx.productId, qty: '1.000', unitPrice: fx.productPrice }],
              payments: [{ method: PaymentMethod.CASH, amount: fx.productPrice }],
              receiptNumber: `${fx.locationCode}-SIM3-1`,
            },
          }),
          { isConflictLoser: false },
        );

        // Never threw (D-17a) — the movement posted, and the balance went negative.
        const balances = await client.query<{ qty_on_hand: string }>(
          `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = ANY($3::uuid[])`,
          [fx.locationId, fx.kitchenLineAreaId, recipeItems.rows.map((r) => r.item_id)],
        );
        expect(balances.rows.some((r) => Number(r.qty_on_hand) < -1000)).toBe(true);

        const reconciliations = await client.query(
          `SELECT status FROM stock_reconciliations WHERE location_id = $1 AND storage_area_id = $2 AND item_id = ANY($3::uuid[]) AND detail->>'reason' = 'negative_balance'`,
          [fx.locationId, fx.kitchenLineAreaId, recipeItems.rows.map((r) => r.item_id)],
        );
        expect(reconciliations.rows.length).toBeGreaterThan(0);
      },
    );
  }, 30_000);

  it('isConflictLoser=true on void_refunds.approved_offline is NOT applied — an online decision already won the C3 race', async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'owner', locationIds: [] },
      async (client) => {
        const svc = services(getAppPool());
        const originDeviceId = randomUUID();
        const shiftId = randomUUID();
        const saleId = randomUUID();

        await svc.projector.project(
          client,
          mkEvent({
            originDeviceId,
            clientSeq: 1,
            locationId: fx.locationId,
            entity: 'pos_shifts',
            entityId: shiftId,
            op: 'opened',
            actorUserId: fx.kasirId,
            data: {
              clientId: randomUUID(),
              locationId: fx.locationId,
              openingCash: '50000.00',
              openedAt: new Date().toISOString(),
              shiftNumber: `${fx.locationCode}-SIM4-S1`,
            },
          }),
          { isConflictLoser: false },
        );
        await svc.projector.project(
          client,
          mkEvent({
            originDeviceId,
            clientSeq: 2,
            locationId: fx.locationId,
            entity: 'sales',
            entityId: saleId,
            op: 'completed',
            actorUserId: fx.kasirId,
            data: {
              clientId: randomUUID(),
              locationId: fx.locationId,
              shiftId,
              occurredAt: new Date().toISOString(),
              lines: [{ productId: fx.productId, qty: '1.000', unitPrice: fx.productPrice }],
              payments: [{ method: PaymentMethod.CASH, amount: fx.productPrice }],
              receiptNumber: `${fx.locationCode}-SIM4-1`,
            },
          }),
          { isConflictLoser: false },
        );
        await svc.projector.project(
          client,
          mkEvent({
            originDeviceId,
            clientSeq: 3,
            locationId: fx.locationId,
            entity: 'void_refunds',
            entityId: saleId,
            op: 'requested',
            actorUserId: fx.kasirId,
            data: {
              clientId: randomUUID(),
              type: VoidRefundType.VOID,
              reason: 'test — C3 loser path',
            },
          }),
          { isConflictLoser: false },
        );

        // The offline approval LOST a decision race (an online decision already won, per §5.3) —
        // the projector must not flip the row to 'approved'.
        await svc.projector.project(
          client,
          mkEvent({
            originDeviceId,
            clientSeq: 4,
            locationId: fx.locationId,
            entity: 'void_refunds',
            entityId: saleId,
            op: 'approved_offline',
            actorUserId: fx.kasirId,
            data: {},
          }),
          { isConflictLoser: true },
        );

        const voidRow = await client.query(
          `SELECT status, offline_authorized FROM void_refunds WHERE sale_id = $1`,
          [saleId],
        );
        expect(voidRow.rows[0]?.status).toBe('pending');
        expect(voidRow.rows[0]?.offline_authorized).toBe(false);

        const saleRow = await client.query(`SELECT status FROM sales WHERE id = $1`, [saleId]);
        expect(saleRow.rows[0]?.status).toBe('completed'); // never reversed — the losing decision had no effect
      },
    );
  }, 30_000);

  it("isConflictLoser=true on online_orders.recorded (C8) never creates a second row — CONTRACTS' UNIQUE(platform, order_ref) makes that structurally impossible; the winner row is returned unchanged", async () => {
    await withRollback(
      { userId: fx.kasirId, roleKey: 'owner', locationIds: [] },
      async (client) => {
        const svc = services(getAppPool());
        const orderRef = `GF-DUP-${randomUUID().slice(0, 8)}`;
        const orderData = {
          clientId: randomUUID(),
          locationId: fx.locationId,
          platform: OnlinePlatform.GOFOOD,
          orderRef,
          orderDate: new Date().toISOString().slice(0, 10),
          grossAmount: '50000.00',
          discountAmount: '0.00',
          platformFee: '0.00',
          otherFee: '0.00',
          netReceived: '50000.00',
          status: OnlineOrderStatus.COMPLETED,
        };
        const firstId = randomUUID();
        const first = mkEvent({
          originDeviceId: randomUUID(),
          clientSeq: 1,
          locationId: fx.locationId,
          entity: 'online_orders',
          entityId: firstId,
          op: 'recorded',
          actorUserId: fx.kasirId,
          data: orderData,
        });
        const second = mkEvent({
          originDeviceId: randomUUID(),
          clientSeq: 1,
          locationId: fx.locationId,
          entity: 'online_orders',
          entityId: randomUUID(),
          op: 'recorded',
          actorUserId: fx.kasirId,
          data: { ...orderData, clientId: randomUUID() },
        });

        await svc.projector.project(client, first, { isConflictLoser: false });
        await svc.projector.project(client, second, { isConflictLoser: true }); // C8's verdict on the duplicate

        const rows = await client.query<{ id: string }>(
          `SELECT id FROM online_orders WHERE platform = $1 AND order_ref = $2`,
          [OnlinePlatform.GOFOOD, orderRef],
        );
        expect(rows.rows).toHaveLength(1);
        expect(rows.rows[0]!.id).toBe(firstId); // the winner, untouched by the loser's replay
      },
    );
  }, 30_000);
});
