/**
 * Live-DB integration test for `LowStockDetectorService.checkAndNotify` —
 * the actual detection query + cooldown gate, against a REAL `stock_balances`/
 * `min_stock_rules` state reached the only sanctioned way (`StockLedgerService`,
 * D-07 — this suite never inserts into either table directly). The generic
 * debounce TIMING mechanism (`KeyedDebouncer`) has its own fast, timer-based
 * unit suite (`debouncer.spec.ts`); this file proves the DETECTION step it
 * wraps is actually correct against Postgres, and that the cooldown gate
 * really does suppress a repeated notification for the same key.
 *
 * `NotificationService` is a hand-built spy, not a mock of the DB layer —
 * every balance/rule/recipient read below goes through the real pool.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MovementType } from '@mimi/shared';
import type {
  NotifyRequest,
  NotifyResult,
} from '../../../kernel/notification/notification.service';
import { EventBus } from '../../../kernel/events/event-bus.service';
import { StockLedgerService } from '../../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../../kernel/stock-ledger/stock-ledger-events';
import {
  closePool,
  createMinStockRule,
  deleteMinStockRule,
  getAppPool,
  getOwnerPool,
  loadFixtures,
  pickUnusedItemInLocation,
  purgeTestResidue,
  seedMovementCommitted,
  withRollback,
  type Fixtures,
} from '../test-support/live-db';
import {
  LowStockDetectorService,
  type LowStockDetectorOptions,
} from './low-stock-detector.service';

class SpyNotificationService {
  readonly calls: NotifyRequest[] = [];
  async notify(request: NotifyRequest): Promise<NotifyResult> {
    this.calls.push(request);
    return { inApp: [], email: [], whatsapp: [] };
  }
}

const OPTIONS: LowStockDetectorOptions = { debounceMs: 1, cooldownMs: 200 };

function detectorWith(spy: SpyNotificationService): LowStockDetectorService {
  return new LowStockDetectorService(
    getAppPool(),
    new EventBus(),
    spy as unknown as import('../../../kernel/notification/notification.service').NotificationService,
    OPTIONS,
  );
}

async function postFactMovement(
  locationId: string,
  storageAreaId: string,
  itemId: string,
  movementType: MovementType,
  qty: string,
): Promise<void> {
  const ledger = new StockLedgerService(new StockMovedEventEmitter(new EventBus()));
  await seedMovementCommitted((client) =>
    ledger.post(
      client,
      [
        {
          locationId,
          storageAreaId,
          itemId,
          movementType,
          qty,
          unitCost: '1000.00',
          refType: 'low_stock_test',
          refId: randomUUID(),
          actorId: null,
        },
      ],
      'fact',
    ),
  );
}

/**
 * `postFactMovement` commits for real (`seedMovementCommitted`, D-07 via the
 * real ledger) — this undoes exactly that, and nothing else, for one key.
 * Scoped by `storageAreaId` too, not just `(location, item)`: the seed
 * routinely already has a balance for this SAME item in a DIFFERENT area of
 * this location (`pickUnusedStockKey` only guarantees no balance at the
 * exact triple it picked) — an unscoped delete would collaterally wipe it.
 */
async function cleanupKey(
  locationId: string,
  storageAreaId: string,
  itemId: string,
): Promise<void> {
  await getOwnerPool().query(
    `DELETE FROM stock_movements WHERE ref_type = 'low_stock_test' AND location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [locationId, storageAreaId, itemId],
  );
  await getOwnerPool().query(
    `DELETE FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [locationId, storageAreaId, itemId],
  );
}

describe('LowStockDetectorService.checkAndNotify — live DB', () => {
  let fx: Fixtures;

  beforeAll(async () => {
    await purgeTestResidue(); // clears anything an interrupted previous run left behind
    fx = await loadFixtures();
  }, 30_000);

  afterAll(async () => {
    await closePool();
  });

  it('no active min_stock_rule — never notifies', async () => {
    const key = await freshKeyIn(fx.outletId);
    try {
      const spy = new SpyNotificationService();
      const detector = detectorWith(spy);

      await postFactMovement(
        key.locationId,
        key.storageAreaId,
        key.itemId,
        MovementType.OPENING_BALANCE,
        '5.000',
      );
      await detector.checkAndNotify(key.locationId, key.itemId);

      expect(spy.calls).toHaveLength(0);
    } finally {
      await cleanupKey(key.locationId, key.storageAreaId, key.itemId);
    }
  }, 20_000);

  it('balance below min_qty notifies exactly once for a burst of checks (cooldown), then again after the cooldown elapses', async () => {
    const key = await freshKeyIn(fx.outletId);
    await createMinStockRule(key.locationId, key.itemId, '10.000');
    try {
      const spy = new SpyNotificationService();
      const detector = detectorWith(spy);

      // Balance opens at 5, below the 10 min_qty — a real "already low" state.
      await postFactMovement(
        key.locationId,
        key.storageAreaId,
        key.itemId,
        MovementType.OPENING_BALANCE,
        '5.000',
      );

      // Simulate a busy shift: several checks fire in quick succession for
      // the SAME still-below balance (this is exactly what a burst of
      // `stock.moved` events, each debounced individually but landing close
      // together, looks like once they reach `checkAndNotify`).
      await detector.checkAndNotify(key.locationId, key.itemId);
      await detector.checkAndNotify(key.locationId, key.itemId);
      await detector.checkAndNotify(key.locationId, key.itemId);

      expect(spy.calls).toHaveLength(1);
      expect(spy.calls[0]!.templateKey).toBe('low_stock');
      expect(spy.calls[0]!.params.currentQty).toBe('5.000');
      expect(spy.calls[0]!.params.minQty).toBe('10.000');
      expect(spy.calls[0]!.locationId).toBe(key.locationId);

      // Still below, but the cooldown (200ms) has now elapsed — a genuinely
      // new alert cycle, not the same burst.
      await new Promise((resolve) => setTimeout(resolve, 250));
      await detector.checkAndNotify(key.locationId, key.itemId);
      expect(spy.calls).toHaveLength(2);
    } finally {
      await deleteMinStockRule(key.locationId, key.itemId);
      await cleanupKey(key.locationId, key.storageAreaId, key.itemId);
    }
  }, 20_000);

  it('recovering to/above min_qty and then no further movement never fires again', async () => {
    const key = await freshKeyIn(fx.outletId);
    await createMinStockRule(key.locationId, key.itemId, '10.000');
    try {
      const spy = new SpyNotificationService();
      const detector = detectorWith(spy);

      await postFactMovement(
        key.locationId,
        key.storageAreaId,
        key.itemId,
        MovementType.OPENING_BALANCE,
        '20.000',
      );
      await detector.checkAndNotify(key.locationId, key.itemId);
      expect(spy.calls).toHaveLength(0);
    } finally {
      await deleteMinStockRule(key.locationId, key.itemId);
      await cleanupKey(key.locationId, key.storageAreaId, key.itemId);
    }
  }, 20_000);

  it('resolves LDR + SPV for an outlet, and additionally KGD for the warehouse', async () => {
    const outletKey = await freshKeyIn(fx.outletId);
    const warehouseKey = await freshKeyIn(fx.warehouseId);
    await createMinStockRule(outletKey.locationId, outletKey.itemId, '10.000');
    await createMinStockRule(warehouseKey.locationId, warehouseKey.itemId, '10.000');
    try {
      const outletSpy = new SpyNotificationService();
      await postFactMovement(
        outletKey.locationId,
        outletKey.storageAreaId,
        outletKey.itemId,
        MovementType.OPENING_BALANCE,
        '1.000',
      );
      await detectorWith(outletSpy).checkAndNotify(outletKey.locationId, outletKey.itemId);
      expect(outletSpy.calls).toHaveLength(1);
      const outletRecipientIds = outletSpy.calls[0]!.userIds;

      const warehouseSpy = new SpyNotificationService();
      await postFactMovement(
        warehouseKey.locationId,
        warehouseKey.storageAreaId,
        warehouseKey.itemId,
        MovementType.OPENING_BALANCE,
        '1.000',
      );
      await detectorWith(warehouseSpy).checkAndNotify(warehouseKey.locationId, warehouseKey.itemId);
      expect(warehouseSpy.calls).toHaveLength(1);
      const warehouseRecipientIds = warehouseSpy.calls[0]!.userIds;

      const outletRoles = await rolesOf(outletRecipientIds);
      const warehouseRoles = await rolesOf(warehouseRecipientIds);

      expect(outletRoles.has('leader_outlet') || outletRoles.has('supervisor')).toBe(true);
      expect(outletRoles.has('kepala_gudang')).toBe(false);
      expect(warehouseRoles.has('kepala_gudang')).toBe(true);
    } finally {
      await deleteMinStockRule(outletKey.locationId, outletKey.itemId);
      await deleteMinStockRule(warehouseKey.locationId, warehouseKey.itemId);
      await cleanupKey(outletKey.locationId, outletKey.storageAreaId, outletKey.itemId);
      await cleanupKey(warehouseKey.locationId, warehouseKey.storageAreaId, warehouseKey.itemId);
    }
  }, 30_000);
});

async function freshKeyIn(
  locationId: string,
): Promise<{ locationId: string; storageAreaId: string; itemId: string }> {
  // `pickUnusedItemInLocation`, NOT `pickUnusedStockKey`: the detector sums
  // balance ACROSS every area of the location for one item, so the fixture
  // must guarantee zero balance anywhere in the location for this item, not
  // merely at one area — see that helper's doc comment for the bug this fixes.
  return withRollback((client) => pickUnusedItemInLocation(client, locationId));
}

async function rolesOf(userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  return withRollback(async (client) => {
    const res = await client.query<{ key: string }>(
      `SELECT DISTINCT r.key FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ANY($1::uuid[])`,
      [userIds],
    );
    return new Set(res.rows.map((r) => r.key));
  });
}
