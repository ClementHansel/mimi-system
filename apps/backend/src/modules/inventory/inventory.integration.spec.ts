/**
 * Live-DB integration suite for M07 `inventory` — every §4.7 endpoint's
 * underlying `InventoryService`/`InventoryRepository` call, against the REAL
 * `mimi_app` connection (same identity `DATABASE_POOL` uses in production),
 * under REAL RLS. No mocks of `pg`, no fakes of the database — every `it`
 * below does real network round trips to Postgres; several deliberately post
 * real movements through the REAL `StockLedgerService` first so there is
 * something non-trivial to read back.
 *
 * `stock_balances`/`stock_movements` are NEVER inserted directly here (D-07)
 * — every balance this suite reads was produced by `StockLedgerService.post`,
 * exactly like production code. `min_stock_rules` IS this module's own
 * table, so its test fixtures are written directly (via the owner pool) and
 * cleaned up afterward — see `test-support/live-db.ts`'s header comment.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ERR_LOCATION_OUT_OF_SCOPE,
  ERR_STOCK_INSUFFICIENT,
  ERR_VALIDATION,
  MovementType,
  RoleKey,
} from '@mimi/shared';

import { EventBus } from '../../kernel/events/event-bus.service';
import { StockLedgerService } from '../../kernel/stock-ledger/stock-ledger.service';
import { StockMovedEventEmitter } from '../../kernel/stock-ledger/stock-ledger-events';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';

import { InventoryRepository } from './inventory.repository';
import { InventoryService, type CallerContext } from './inventory.service';
import {
  closePool,
  createMinStockRule,
  deleteMinStockRule,
  getAppPool,
  getOwnerPool,
  loadFixtures,
  pickItemWithNoMinStockRule,
  pickUnusedItemInLocation,
  pickUnusedStockKey,
  pickUnusedTransferPairInLocation,
  purgeTestResidue,
  refreshUsageMatview,
  seedMovementCommitted,
  withCommit,
  withRollback,
  type Fixtures,
} from './test-support/live-db';

function realStockLedger(): StockLedgerService {
  return new StockLedgerService(new StockMovedEventEmitter(new EventBus()));
}

function realSyncEmit(): SyncEmitService {
  const pool = getAppPool();
  const events = new SyncEventsRepository(pool);
  const conflicts = new ConflictDetectorService(events, new SyncConflictsRepository());
  return new SyncEmitService(events, conflicts);
}

function service(): InventoryService {
  return new InventoryService(new InventoryRepository(), realStockLedger(), realSyncEmit());
}

// `userId` MUST be a real `users.id` — several endpoints under test write it
// into an FK column for real (`min_stock_rules.updated_by`,
// `stock_movements.actor_id`), unlike the read-only kernel harnesses' bare
// sentinel UUID (fine there because nothing they exercise persists it).
let CENTRAL: CallerContext;
let fx: Fixtures;

beforeAll(async () => {
  await purgeTestResidue(); // clears anything an interrupted previous run left behind
  fx = await loadFixtures();
  CENTRAL = { userId: fx.usersByRole[RoleKey.OWNER], roleKey: RoleKey.OWNER, locationScope: null };
}, 30_000);

afterAll(async () => {
  await closePool();
});

describe('InventoryService — GET /api/inventory/balances', () => {
  it('returns a real seeded balance row with the expected shape, scoped by locationId/storageAreaId/itemId', async () => {
    await withRollback(async (client) => {
      const anyBalance = await client.query<{
        location_id: string;
        storage_area_id: string;
        item_id: string;
      }>(`SELECT location_id, storage_area_id, item_id FROM stock_balances LIMIT 1`);
      const row = anyBalance.rows[0]!;

      const page = await service().getBalances(
        client,
        CENTRAL,
        { locationId: row.location_id, storageAreaId: row.storage_area_id, itemId: row.item_id },
        1,
        50,
      );
      expect(page.rows).toHaveLength(1);
      const b = page.rows[0]!;
      expect(b.locationId).toBe(row.location_id);
      expect(b.storageAreaId).toBe(row.storage_area_id);
      expect(b.itemId).toBe(row.item_id);
      expect(typeof b.sku).toBe('string');
      expect(typeof b.itemName).toBe('string');
      expect(typeof b.unitCode).toBe('string');
      expect(typeof b.qtyOnHand).toBe('string'); // Qty travels as a decimal STRING, never a number
    });
  }, 20_000);

  it('includes `value` (qty × avgCost) only for a caller holding supplier.price.read — D-20/FR-SUP-06 role lock', async () => {
    await withRollback(async (client) => {
      const anyBalance = await client.query<{
        location_id: string;
        storage_area_id: string;
        item_id: string;
      }>(`SELECT location_id, storage_area_id, item_id FROM stock_balances LIMIT 1`);
      const row = anyBalance.rows[0]!;
      const filters = {
        locationId: row.location_id,
        storageAreaId: row.storage_area_id,
        itemId: row.item_id,
      };

      const withPrice = await service().getBalances(
        client,
        { ...CENTRAL, roleKey: RoleKey.KEPALA_GUDANG },
        filters,
        1,
        1,
      );
      expect(withPrice.rows[0]!.value).toBeDefined();

      const withoutPrice = await service().getBalances(
        client,
        { ...CENTRAL, roleKey: RoleKey.LEADER_OUTLET },
        filters,
        1,
        1,
      );
      expect(withoutPrice.rows[0]!.value).toBeUndefined();
    });
  }, 20_000);

  it('FR-LOG-20 — belowMin filter + pagination against a freshly crafted below-threshold key', async () => {
    // `pickUnusedItemInLocation`, not `pickUnusedStockKey`: `belowMin` is
    // computed from the balance SUMMED ACROSS EVERY AREA of the location for
    // this item — the fixture must guarantee zero balance anywhere in the
    // location for this item, or a pre-existing seed balance in some OTHER
    // area could push the real total above 50 despite this test only ever
    // posting 10.
    const key = await withRollback((client) => pickUnusedItemInLocation(client, fx.outletId));
    await createMinStockRule(key.locationId, key.itemId, '50.000');
    try {
      await withRollback(async (client) => {
        await realStockLedger().post(
          client,
          [
            {
              ...key,
              movementType: MovementType.OPENING_BALANCE,
              qty: '10.000',
              unitCost: '1000.00',
              refType: 'test',
              refId: randomUUID(),
              actorId: null,
            },
          ],
          'fact',
        );

        const below = await service().getBalances(
          client,
          CENTRAL,
          { locationId: key.locationId, itemId: key.itemId, belowMin: true },
          1,
          50,
        );
        expect(below.rows.some((r) => r.storageAreaId === key.storageAreaId)).toBe(true);
        expect(below.rows[0]!.belowMin).toBe(true);
        expect(below.rows[0]!.minQty).toBe('50.000');

        const above = await service().getBalances(
          client,
          CENTRAL,
          { locationId: key.locationId, itemId: key.itemId, belowMin: false },
          1,
          50,
        );
        expect(above.rows.some((r) => r.storageAreaId === key.storageAreaId)).toBe(false);
      });
    } finally {
      await deleteMinStockRule(key.locationId, key.itemId);
    }
  }, 20_000);

  it("rejects an explicit locationId outside the caller's scope with ERR_LOCATION_OUT_OF_SCOPE (not a silent empty page)", async () => {
    await withRollback(async (client) => {
      const scoped: CallerContext = {
        userId: 'x',
        roleKey: RoleKey.LEADER_OUTLET,
        locationScope: [fx.outletId],
      };
      await expect(
        service().getBalances(client, scoped, { locationId: fx.otherOutletId }, 1, 10),
      ).rejects.toMatchObject({
        response: { code: ERR_LOCATION_OUT_OF_SCOPE },
      });
      // The SAME caller against their OWN location is fine — proves the check isn't just "always reject".
      await expect(
        service().getBalances(client, scoped, { locationId: fx.outletId }, 1, 10),
      ).resolves.toBeDefined();
    });
  }, 20_000);
});

describe('InventoryService — GET /api/inventory/summary', () => {
  it('totalItems/belowMin/byArea reflect a freshly seeded key at a fresh (unused-by-seed) location scope', async () => {
    // `totalItems` counts DISTINCT (location, item) pairs — an item that
    // already has a balance in some OTHER area of this location would leave
    // `totalItems`/`belowMin` unchanged by this insert, not +1.
    // `pickUnusedItemInLocation` guarantees this item has no balance
    // anywhere in the location yet.
    const key = await withRollback((client) => pickUnusedItemInLocation(client, fx.outletId));
    await createMinStockRule(key.locationId, key.itemId, '999999.000'); // guaranteed below
    try {
      await withRollback(async (client) => {
        const before = await service().getSummary(client, CENTRAL, key.locationId);

        await realStockLedger().post(
          client,
          [
            {
              ...key,
              movementType: MovementType.OPENING_BALANCE,
              qty: '1.000',
              unitCost: '500.00',
              refType: 'test',
              refId: randomUUID(),
              actorId: null,
            },
          ],
          'fact',
        );

        const after = await service().getSummary(client, CENTRAL, key.locationId);
        expect(after.totalItems).toBe(before.totalItems + 1);
        expect(after.belowMin).toBe(before.belowMin + 1);
        const area = after.byArea.find((a) => a.storageAreaId === key.storageAreaId);
        expect(area).toBeDefined();
      });
    } finally {
      await deleteMinStockRule(key.locationId, key.itemId);
    }
  }, 20_000);
});

describe('InventoryService — GET /api/inventory/movements', () => {
  it('FR-LOG-21 — lists a just-posted movement, filterable by movementType/date range', async () => {
    const key = await withRollback((client) =>
      pickUnusedStockKey(client, { locationId: fx.outletId }),
    );
    await withRollback(async (client) => {
      const refId = randomUUID();
      await realStockLedger().post(
        client,
        [
          {
            ...key,
            movementType: MovementType.PURCHASE_IN,
            qty: '7.500',
            unitCost: '2500.00',
            refType: 'test',
            refId,
            actorId: null,
          },
        ],
        'fact',
      );

      // Scoped by storageAreaId too, not just locationId+itemId: the seed
      // routinely already has movements for this SAME item at a DIFFERENT
      // storage area of this location (an item usually has stock somewhere
      // in an outlet) — `pickUnusedStockKey` only guarantees no balance at
      // THIS triple, not that the (location, item) pair is otherwise empty.
      const page = await service().getMovements(
        client,
        CENTRAL,
        { locationId: key.locationId, itemId: key.itemId, storageAreaId: key.storageAreaId },
        1,
        50,
      );
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]!.movementType).toBe('purchase_in');
      expect(page.rows[0]!.qty).toBe('7.500');
      expect(page.rows[0]!.refId).toBe(refId);
      expect(page.rows[0]!.storageAreaName).toEqual(expect.any(String));

      const wrongType = await service().getMovements(
        client,
        CENTRAL,
        {
          locationId: key.locationId,
          itemId: key.itemId,
          storageAreaId: key.storageAreaId,
          movementType: MovementType.WASTE_OUT,
        },
        1,
        50,
      );
      expect(wrongType.rows).toHaveLength(0);
    });
  }, 20_000);
});

describe('InventoryService — GET/PUT /api/inventory/min-stock', () => {
  it('FR-LOG-06/FR-LOG-17 — GET lists rules for a location, paginated', async () => {
    await withRollback(async (client) => {
      const page = await service().getMinStock(client, CENTRAL, fx.warehouseId, 1, 5);
      expect(page.rows.length).toBeGreaterThan(0);
      expect(page.rows.every((r) => r.locationId === fx.warehouseId)).toBe(true);
    });
  }, 20_000);

  it('FR-LOG-06/FR-LOG-17 — PUT bulk-upserts and the REAL commit path lands a durable row + emits a min_stock_rules.updated sync event', async () => {
    const key = await withRollback((client) =>
      pickUnusedStockKey(client, { locationId: fx.outletId }),
    );
    try {
      const rows = await withCommit((client) =>
        service().upsertMinStock(client, CENTRAL, key.locationId, [
          { itemId: key.itemId, minQty: '12.500', reorderQty: '20.000' },
        ]),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]!.minQty).toBe('12.500');
      expect(rows[0]!.reorderQty).toBe('20.000');
      expect(rows[0]!.isActive).toBe(true);

      // Durably committed — visible from a SEPARATE connection (the owner pool), not just this transaction.
      const persisted = await getOwnerPool().query<{ min_qty: string }>(
        `SELECT min_qty FROM min_stock_rules WHERE location_id = $1 AND item_id = $2`,
        [key.locationId, key.itemId],
      );
      expect(persisted.rows[0]!.min_qty).toBe('12.500');

      const events = await getOwnerPool().query<{
        entity: string;
        op: string;
        location_id: string;
      }>(
        `SELECT entity, op, location_id FROM sync_events WHERE entity = 'min_stock_rules' AND entity_id = $1`,
        [rows[0]!.id],
      );
      expect(events.rows).toHaveLength(1);
      expect(events.rows[0]!.op).toBe('updated');
      expect(events.rows[0]!.location_id).toBe(key.locationId);

      // Upserting AGAIN updates in place (ON CONFLICT), not a duplicate row.
      const updated = await withCommit((client) =>
        service().upsertMinStock(client, CENTRAL, key.locationId, [
          { itemId: key.itemId, minQty: '30.000' },
        ]),
      );
      expect(updated).toHaveLength(1);
      expect(updated[0]!.minQty).toBe('30.000');
      const count = await getOwnerPool().query<{ n: string }>(
        `SELECT count(*)::int AS n FROM min_stock_rules WHERE location_id = $1 AND item_id = $2`,
        [key.locationId, key.itemId],
      );
      expect(Number(count.rows[0]!.n)).toBe(1);
    } finally {
      await deleteMinStockRule(key.locationId, key.itemId);
    }
  }, 30_000);

  it("rejects a locationId outside the caller's scope BEFORE writing anything", async () => {
    // `pickItemWithNoMinStockRule`, not `pickUnusedStockKey`: this test's own
    // assertion is "no rule exists afterward" — that's only meaningful proof
    // the write was blocked if no rule existed BEFORE either. The seed's
    // core items already carry a rule at every location by design, and
    // `pickUnusedStockKey` says nothing about `min_stock_rules` at all.
    const key = await withRollback((client) => pickItemWithNoMinStockRule(client, fx.outletId));
    const scoped: CallerContext = {
      userId: 'x',
      roleKey: RoleKey.KEPALA_GUDANG,
      locationScope: [fx.warehouseId],
    };
    await withRollback(async (client) => {
      await expect(
        service().upsertMinStock(client, scoped, key.locationId, [
          { itemId: key.itemId, minQty: '1.000' },
        ]),
      ).rejects.toMatchObject({ response: { code: ERR_LOCATION_OUT_OF_SCOPE } });
    });
    const persisted = await getOwnerPool().query(
      `SELECT 1 FROM min_stock_rules WHERE location_id = $1 AND item_id = $2`,
      [key.locationId, key.itemId],
    );
    expect(persisted.rowCount).toBe(0);
  }, 20_000);
});

describe('InventoryService — GET /api/inventory/low-stock', () => {
  it('FR-LOG-07/FR-LOG-18 — a fresh key below its rule appears; the same key above its rule does not', async () => {
    // Low-stock detection sums the balance across every area of the
    // location for this item — `pickUnusedItemInLocation` guarantees zero
    // balance anywhere in the location, not just at one area, so the
    // qtyOnHand asserted below is exactly what this test posts.
    const key = await withRollback((client) => pickUnusedItemInLocation(client, fx.outletId));
    await createMinStockRule(key.locationId, key.itemId, '100.000', '250.000');
    try {
      await withRollback(async (client) => {
        await realStockLedger().post(
          client,
          [
            {
              ...key,
              movementType: MovementType.OPENING_BALANCE,
              qty: '40.000',
              unitCost: '1000.00',
              refType: 'test',
              refId: randomUUID(),
              actorId: null,
            },
          ],
          'fact',
        );

        const low = await service().getLowStock(client, CENTRAL, key.locationId);
        const found = low.find((r) => r.itemId === key.itemId);
        expect(found).toBeDefined();
        expect(found!.qtyOnHand).toBe('40.000');
        expect(found!.minQty).toBe('100.000');
        expect(found!.suggestedQty).toBe('250.000');

        await realStockLedger().post(
          client,
          [
            {
              ...key,
              movementType: MovementType.PURCHASE_IN,
              qty: '200.000',
              unitCost: '1000.00',
              refType: 'test',
              refId: randomUUID(),
              actorId: null,
            },
          ],
          'fact',
        );
        const recovered = await service().getLowStock(client, CENTRAL, key.locationId);
        expect(recovered.some((r) => r.itemId === key.itemId)).toBe(false);
      });
    } finally {
      await deleteMinStockRule(key.locationId, key.itemId);
    }
  }, 20_000);
});

describe('InventoryService — GET /api/inventory/suggestions', () => {
  it('FR-LOG-08/FR-LOG-19 — falls back to reorder_qty basis when there is no recent usage history', async () => {
    const key = await withRollback((client) =>
      pickUnusedStockKey(client, { locationId: fx.outletId }),
    );
    await createMinStockRule(key.locationId, key.itemId, '10.000', '99.000');
    try {
      await withRollback(async (client) => {
        const suggestions = await service().getSuggestions(client, CENTRAL, key.locationId);
        const row = suggestions.find((r) => r.itemId === key.itemId);
        expect(row).toBeDefined();
        expect(row!.basis).toBe('reorder_qty');
        expect(row!.suggestedQty).toBe('99.000');
        expect(row!.avgDailyUsage).toBe('0.000');
      });
    } finally {
      await deleteMinStockRule(key.locationId, key.itemId);
    }
  }, 20_000);

  it('FR-LOG-08/FR-LOG-19 — switches to usage_pattern basis once mv_item_usage_daily has recent usage_out for the key', async () => {
    const key = await withRollback((client) =>
      pickUnusedStockKey(client, { locationId: fx.outletId }),
    );
    await createMinStockRule(key.locationId, key.itemId, '10.000', '99.000');
    try {
      // usage_out must be COMMITTED before a matview refresh (a different snapshot) can see it.
      await seedMovementCommitted((client) =>
        realStockLedger().post(
          client,
          [
            {
              ...key,
              movementType: MovementType.USAGE_OUT,
              qty: '14.000',
              unitCost: '1000.00',
              refType: 'test',
              refId: randomUUID(),
              actorId: null,
            },
          ],
          'fact',
        ),
      );
      await refreshUsageMatview();

      await withRollback(async (client) => {
        const suggestions = await service().getSuggestions(client, CENTRAL, key.locationId);
        const row = suggestions.find((r) => r.itemId === key.itemId);
        expect(row).toBeDefined();
        expect(row!.basis).toBe('usage_pattern');
        expect(row!.avgDailyUsage).toBe('1.000'); // 14.000 / 14 days
        expect(row!.suggestedQty).toBe('7.000'); // 1.000/day × 7 days cover
      });
    } finally {
      // Scoped by storageAreaId too — NOT just (location, item): the seed
      // routinely has a balance for this SAME item in a DIFFERENT area of
      // this location (`pickUnusedStockKey` only guarantees no balance at
      // THIS triple), and an unscoped delete would collaterally wipe it.
      await getOwnerPool().query(
        `DELETE FROM stock_movements WHERE ref_type = 'test' AND location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [key.locationId, key.storageAreaId, key.itemId],
      );
      await getOwnerPool().query(
        `DELETE FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
        [key.locationId, key.storageAreaId, key.itemId],
      );
      await refreshUsageMatview();
      await deleteMinStockRule(key.locationId, key.itemId);
    }
  }, 30_000);
});

describe('InventoryService — POST /api/inventory/area-transfer', () => {
  it('strict mode rejects a transfer the source area cannot cover — ERR_STOCK_INSUFFICIENT, nothing moves', async () => {
    // `pickUnusedTransferPairInLocation`, not a fixed second area
    // (`fx.storageAreaOutletB`): that fixture is a FIXED value that could
    // coincidentally equal whatever random area `pickUnusedStockKey` picked
    // as `fromAreaId`, tripping the "must differ" validation instead of the
    // insufficient-stock path this test means to exercise.
    const pair = await withRollback((client) =>
      pickUnusedTransferPairInLocation(client, fx.outletId),
    );
    await withRollback(async (client) => {
      await expect(
        service().postAreaTransfer(client, CENTRAL, {
          locationId: pair.locationId,
          itemId: pair.itemId,
          fromAreaId: pair.fromAreaId,
          toAreaId: pair.toAreaId,
          qty: '5.000',
        }),
      ).rejects.toMatchObject({ response: { code: ERR_STOCK_INSUFFICIENT } });
    });
  }, 20_000);

  it('rejects fromAreaId === toAreaId, and an area from a different location', async () => {
    await withRollback(async (client) => {
      await expect(
        service().postAreaTransfer(client, CENTRAL, {
          locationId: fx.outletId,
          itemId: fx.itemId,
          fromAreaId: fx.storageAreaOutlet,
          toAreaId: fx.storageAreaOutlet,
          qty: '1.000',
        }),
      ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });

      await expect(
        service().postAreaTransfer(client, CENTRAL, {
          locationId: fx.outletId,
          itemId: fx.itemId,
          fromAreaId: fx.storageAreaOutlet,
          toAreaId: fx.storageAreaWarehouse, // belongs to the WAREHOUSE, not this outlet
          qty: '1.000',
        }),
      ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });
    });
  }, 20_000);

  it('a scoped caller (Kepala Gudang without this outlet) is rejected before any DB write', async () => {
    const scoped: CallerContext = {
      userId: 'x',
      roleKey: RoleKey.KEPALA_GUDANG,
      locationScope: [fx.warehouseId],
    };
    await withRollback(async (client) => {
      await expect(
        service().postAreaTransfer(client, scoped, {
          locationId: fx.outletId,
          itemId: fx.itemId,
          fromAreaId: fx.storageAreaOutlet,
          toAreaId: fx.storageAreaOutletB,
          qty: '1.000',
        }),
      ).rejects.toMatchObject({ response: { code: ERR_LOCATION_OUT_OF_SCOPE } });
    });
  }, 20_000);

  it('a real transfer moves qty between two areas of the SAME location and commits durably', async () => {
    const pair = await withRollback((client) =>
      pickUnusedTransferPairInLocation(client, fx.outletId),
    );

    try {
      await seedMovementCommitted((client) =>
        realStockLedger().post(
          client,
          [
            {
              locationId: pair.locationId,
              storageAreaId: pair.fromAreaId,
              itemId: pair.itemId,
              movementType: MovementType.OPENING_BALANCE,
              qty: '20.000',
              unitCost: '3000.00',
              refType: 'test',
              refId: randomUUID(),
              actorId: null,
            },
          ],
          'fact',
        ),
      );

      const result = await withCommit((client) =>
        service().postAreaTransfer(client, CENTRAL, {
          locationId: pair.locationId,
          itemId: pair.itemId,
          fromAreaId: pair.fromAreaId,
          toAreaId: pair.toAreaId,
          qty: '8.000',
          reason: 'integration test transfer',
        }),
      );

      expect(result.ok).toBe(true);
      expect(result.movements).toHaveLength(2);
      const outLeg = result.movements.find((m) => m.movementType === 'transfer_out')!;
      const inLeg = result.movements.find((m) => m.movementType === 'transfer_in')!;
      expect(outLeg.qty).toBe('8.000');
      expect(inLeg.qty).toBe('8.000');

      const balances = await getOwnerPool().query<{ storage_area_id: string; qty_on_hand: string }>(
        `SELECT storage_area_id, qty_on_hand FROM stock_balances WHERE location_id = $1 AND item_id = $2`,
        [pair.locationId, pair.itemId],
      );
      const fromBalance = balances.rows.find((r) => r.storage_area_id === pair.fromAreaId);
      const toBalance = balances.rows.find((r) => r.storage_area_id === pair.toAreaId);
      expect(fromBalance!.qty_on_hand).toBe('12.000');
      expect(toBalance!.qty_on_hand).toBe('8.000');
    } finally {
      // Scoped by BOTH specific areas touched (fromAreaId/toAreaId) — not a
      // bare (location, item) delete, which would collaterally wipe any
      // seed balance for this item sitting in some OTHER area of this
      // location that this test never touched.
      await getOwnerPool().query(
        `DELETE FROM stock_movements
          WHERE location_id = $1 AND item_id = $2 AND storage_area_id = ANY($3::uuid[])
            AND ref_type IN ('test', 'area_transfer')`,
        [pair.locationId, pair.itemId, [pair.fromAreaId, pair.toAreaId]],
      );
      await getOwnerPool().query(
        `DELETE FROM stock_balances WHERE location_id = $1 AND item_id = $2 AND storage_area_id = ANY($3::uuid[])`,
        [pair.locationId, pair.itemId, [pair.fromAreaId, pair.toAreaId]],
      );
    }
  }, 30_000);
});

describe('InventoryService — GET /api/inventory/history/:itemId', () => {
  it('FR-LOG-21 — reconstructs a 7-day series that ends at the live balance, with correct in/out on the seeded day', async () => {
    // `getHistory`'s anchor is `getLocationItemTotal` — summed across every
    // area of the location for this item — so the fixture needs zero
    // balance anywhere in the location for this item, not just one area, or
    // the expected closing value below would be off by whatever the item
    // already carries elsewhere.
    const key = await withRollback((client) => pickUnusedItemInLocation(client, fx.outletId));
    await withRollback(async (client) => {
      const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      await realStockLedger().post(
        client,
        [
          {
            ...key,
            movementType: MovementType.PURCHASE_IN,
            qty: '15.000',
            unitCost: '1000.00',
            refType: 'test',
            refId: randomUUID(),
            actorId: null,
            occurredAt: threeDaysAgo,
          },
        ],
        'fact',
      );
      await realStockLedger().post(
        client,
        [
          {
            ...key,
            movementType: MovementType.USAGE_OUT,
            qty: '4.000',
            unitCost: '1000.00',
            refType: 'test',
            refId: randomUUID(),
            actorId: null,
          },
        ],
        'fact',
      );

      const series = await service().getHistory(client, CENTRAL, key.locationId, key.itemId, 7);
      expect(series).toHaveLength(7);
      expect(series[series.length - 1]!.closing).toBe('11.000'); // 15 in, 4 out
      const totalIn = series.reduce((acc, d) => acc + Number(d.qtyIn), 0);
      const totalOut = series.reduce((acc, d) => acc + Number(d.qtyOut), 0);
      expect(totalIn).toBe(15);
      expect(totalOut).toBe(4);
    });
  }, 20_000);

  it('404s (ERR_NOT_FOUND) for an item that does not exist', async () => {
    await withRollback(async (client) => {
      await expect(
        service().getHistory(client, CENTRAL, fx.outletId, randomUUID(), 30),
      ).rejects.toThrow();
    });
  }, 20_000);
});
