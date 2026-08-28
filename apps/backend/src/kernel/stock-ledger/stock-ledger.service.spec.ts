import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MovementType, ReconciliationTier } from '@mimi/shared';
import { EventBus } from '../events/event-bus.service';
import { StockLedgerService } from './stock-ledger.service';
import { StockMovedEventEmitter } from './stock-ledger-events';
import {
  StockInsufficientError,
  StockMovementValidationError,
  type PostMovementInput,
} from './stock-ledger.types';

/**
 * Faithful-enough in-memory double of the exact query shapes
 * `StockLedgerService` issues (this file and the service are kept in sync
 * deliberately — see the class comment). Gives fast, deterministic coverage
 * of the dual-mode/idempotency/transfer logic without a live database;
 * `stock-ledger.integration.spec.ts` and `stock-ledger.property.spec.ts`
 * cover the same guarantees against real Postgres, which is the authority.
 */
class FakePoolClient {
  balances = new Map<string, string>();
  movements: {
    id: string;
    location_id: string;
    storage_area_id: string;
    item_id: string;
    movement_type: string;
    qty: string;
    unit_cost: string;
    ref_type: string;
    ref_id: string | null;
    sync_event_id: string | null;
  }[] = [];
  reconciliations: {
    id: string;
    location_id: string;
    storage_area_id: string;
    item_id: string;
    tier: string;
  }[] = [];
  private seq = 0;

  private key(locationId: string, storageAreaId: string, itemId: string): string {
    return `${locationId}::${storageAreaId}::${itemId}`;
  }

  async query<T = unknown>(sql: string, params: unknown[] = []): Promise<{ rows: T[] }> {
    const s = sql.replace(/\s+/g, ' ').trim();

    if (s.startsWith('SELECT pg_advisory_xact_lock')) {
      return { rows: [] as T[] };
    }

    if (s.startsWith('SELECT id FROM stock_movements')) {
      const [refType, refId, itemId, storageAreaId, movementType] = params as (string | null)[];
      const found = this.movements.find(
        (m) =>
          m.ref_type === refType &&
          m.ref_id === refId &&
          m.item_id === itemId &&
          m.storage_area_id === storageAreaId &&
          m.movement_type === movementType,
      );
      return { rows: (found ? [{ id: found.id }] : []) as T[] };
    }

    if (s.startsWith('SELECT qty_on_hand FROM stock_balances')) {
      const [locationId, storageAreaId, itemId] = params as [string, string, string];
      const qty = this.balances.get(this.key(locationId, storageAreaId, itemId));
      return { rows: (qty !== undefined ? [{ qty_on_hand: qty }] : []) as T[] };
    }

    if (s.startsWith('UPDATE stock_balances')) {
      const [locationId, storageAreaId, itemId, qty] = params as [string, string, string, string];
      this.balances.set(this.key(locationId, storageAreaId, itemId), qty);
      return { rows: [] as T[] };
    }

    if (s.startsWith('INSERT INTO stock_balances')) {
      const [locationId, storageAreaId, itemId, qty] = params as [string, string, string, string];
      this.balances.set(this.key(locationId, storageAreaId, itemId), qty);
      return { rows: [] as T[] };
    }

    if (s.startsWith('INSERT INTO stock_movements')) {
      const [
        locationId,
        storageAreaId,
        itemId,
        movementType,
        qty,
        unitCost,
        refType,
        refId,
        ,
        ,
        ,
        ,
        syncEventId,
      ] = params as (string | null)[];
      if (syncEventId && this.movements.some((m) => m.sync_event_id === syncEventId)) {
        throw new Error(
          'duplicate key value violates unique constraint "stock_movements_sync_event_id_key"',
        );
      }
      const id = `mov-${++this.seq}`;
      this.movements.push({
        id,
        location_id: locationId!,
        storage_area_id: storageAreaId!,
        item_id: itemId!,
        movement_type: movementType!,
        qty: qty!,
        unit_cost: unitCost!,
        ref_type: refType!,
        // These two columns are nullable; a params slot that was never
        // supplied reads `undefined`, which is not the same value.
        ref_id: refId ?? null,
        sync_event_id: syncEventId ?? null,
      });
      return { rows: [{ id }] as T[] };
    }

    if (s.startsWith('INSERT INTO stock_reconciliations')) {
      const [locationId, storageAreaId, itemId, tier] = params as [string, string, string, string];
      const id = `rec-${++this.seq}`;
      this.reconciliations.push({
        id,
        location_id: locationId,
        storage_area_id: storageAreaId,
        item_id: itemId,
        tier,
      });
      return { rows: [{ id }] as T[] };
    }

    throw new Error(`FakePoolClient: unhandled query: ${s}`);
  }
}

function makeService(bus: EventBus = new EventBus()) {
  const emitter = new StockMovedEventEmitter(bus);
  return new StockLedgerService(emitter);
}

const KEY = { locationId: 'loc-1', storageAreaId: 'area-1', itemId: 'item-1' };

function movement(overrides: Partial<PostMovementInput> = {}): PostMovementInput {
  return {
    ...KEY,
    movementType: MovementType.PURCHASE_IN,
    qty: '10.000',
    unitCost: '1000.00',
    refType: 'goods_receipt',
    refId: 'receipt-1',
    actorId: 'user-1',
    ...overrides,
  };
}

describe('StockLedgerService', () => {
  let client: FakePoolClient;

  beforeEach(() => {
    client = new FakePoolClient();
  });

  describe('validation', () => {
    it('rejects a zero qty before touching the database', async () => {
      const service = makeService();
      await expect(
        service.post(client as never, [movement({ qty: '0.000' })], 'strict'),
      ).rejects.toThrow(StockMovementValidationError);
      expect(client.movements).toHaveLength(0);
    });

    it('rejects a negative qty', async () => {
      const service = makeService();
      await expect(
        service.post(client as never, [movement({ qty: '-1.000' })], 'strict'),
      ).rejects.toThrow(StockMovementValidationError);
    });

    it('rejects a malformed qty decimal string', async () => {
      const service = makeService();
      await expect(
        service.post(client as never, [movement({ qty: 'not-a-number' })], 'strict'),
      ).rejects.toThrow(StockMovementValidationError);
    });
  });

  describe('basic posting', () => {
    it('posts a purchase_in from a zero balance and returns the new balance', async () => {
      const service = makeService();
      const result = await service.post(client as never, [movement()], 'strict');
      expect(result.movements).toHaveLength(1);
      expect(result.movements[0]).toMatchObject({
        balanceAfter: '10.000',
        wentNegative: false,
        skippedAsDuplicate: false,
      });
      expect(client.balances.get('loc-1::area-1::item-1')).toBe('10.000');
    });

    it('accumulates balance across sequential movements at the same key', async () => {
      const service = makeService();
      await service.post(client as never, [movement({ refId: 'r1' })], 'strict');
      const result = await service.post(
        client as never,
        [movement({ refId: 'r2', qty: '5.000' })],
        'strict',
      );
      expect(result.movements[0]!.balanceAfter).toBe('15.000');
    });

    it('applies usage_out as a negative delta', async () => {
      const service = makeService();
      await service.post(client as never, [movement({ refId: 'r1', qty: '10.000' })], 'strict');
      const result = await service.post(
        client as never,
        [movement({ refId: 'r2', movementType: MovementType.USAGE_OUT, qty: '3.000' })],
        'strict',
      );
      expect(result.movements[0]!.balanceAfter).toBe('7.000');
    });
  });

  describe('D-17a dual mode / SYNC-PROTOCOL C5', () => {
    it('strict mode rejects a movement that would drive the balance negative, writing nothing', async () => {
      const service = makeService();
      await expect(
        service.post(
          client as never,
          [movement({ movementType: MovementType.USAGE_OUT, qty: '5.000' })],
          'strict',
        ),
      ).rejects.toThrow(StockInsufficientError);
      expect(client.movements).toHaveLength(0);
      expect(client.balances.size).toBe(0);
    });

    it('strict mode error carries ERR_STOCK_INSUFFICIENT and the offending key', async () => {
      const service = makeService();
      try {
        await service.post(
          client as never,
          [movement({ movementType: MovementType.USAGE_OUT, qty: '5.000' })],
          'strict',
        );
        expect.fail('expected StockInsufficientError');
      } catch (err) {
        expect(err).toBeInstanceOf(StockInsufficientError);
        expect((err as StockInsufficientError).code).toBe('ERR_STOCK_INSUFFICIENT');
        expect((err as StockInsufficientError).key).toEqual(KEY);
      }
    });

    it('fact mode applies the same movement anyway, driving the balance negative', async () => {
      const service = makeService();
      const result = await service.post(
        client as never,
        [movement({ movementType: MovementType.USAGE_OUT, qty: '5.000' })],
        'fact',
      );
      expect(result.movements[0]).toMatchObject({ balanceAfter: '-5.000', wentNegative: true });
      expect(client.balances.get('loc-1::area-1::item-1')).toBe('-5.000');
    });

    it('fact mode opens a stock_reconciliations exception when it goes negative', async () => {
      const service = makeService();
      const result = await service.post(
        client as never,
        [movement({ movementType: MovementType.USAGE_OUT, qty: '5.000' })],
        'fact',
      );
      expect(result.reconciliationsOpened).toHaveLength(1);
      expect(client.reconciliations).toHaveLength(1);
      expect(client.reconciliations[0]).toMatchObject({
        location_id: 'loc-1',
        storage_area_id: 'area-1',
        item_id: 'item-1',
        tier: ReconciliationTier.CLOUD,
      });
    });

    it('fact mode does NOT open a reconciliation exception when the result is non-negative', async () => {
      const service = makeService();
      await service.post(client as never, [movement({ refId: 'r1', qty: '10.000' })], 'fact');
      const result = await service.post(
        client as never,
        [movement({ refId: 'r2', movementType: MovementType.USAGE_OUT, qty: '3.000' })],
        'fact',
      );
      expect(result.reconciliationsOpened).toHaveLength(0);
      expect(client.reconciliations).toHaveLength(0);
    });

    it('strict mode never produces a negative balance across a mixed batch', async () => {
      const service = makeService();
      await service.post(client as never, [movement({ refId: 'r1', qty: '10.000' })], 'strict');
      const result = await service.post(
        client as never,
        [movement({ refId: 'r2', movementType: MovementType.USAGE_OUT, qty: '10.000' })],
        'strict',
      );
      expect(result.movements[0]!.wentNegative).toBe(false);
      expect(result.movements[0]!.balanceAfter).toBe('0.000');
    });
  });

  describe('idempotent replay (natural-key dedup)', () => {
    it('replaying the exact same fact (ref_type/ref_id/item/area/type) is a no-op', async () => {
      const service = makeService();
      const first = await service.post(client as never, [movement({ refId: 'same-fact' })], 'fact');
      const second = await service.post(
        client as never,
        [movement({ refId: 'same-fact' })],
        'fact',
      );

      expect(first.movements[0]!.skippedAsDuplicate).toBe(false);
      expect(second.movements[0]!.skippedAsDuplicate).toBe(true);
      expect(second.movements[0]!.id).toBe(first.movements[0]!.id);
      expect(client.movements).toHaveLength(1);
      // Balance reflects ONE application, not two — replay never double-applies.
      expect(client.balances.get('loc-1::area-1::item-1')).toBe('10.000');
    });

    it('replaying does not re-open a reconciliation exception on the second call', async () => {
      const service = makeService();
      const m = movement({ refId: 'neg-fact', movementType: MovementType.USAGE_OUT, qty: '5.000' });
      const first = await service.post(client as never, [m], 'fact');
      const second = await service.post(client as never, [m], 'fact');
      expect(first.reconciliationsOpened).toHaveLength(1);
      expect(second.reconciliationsOpened).toHaveLength(0);
      expect(client.reconciliations).toHaveLength(1);
    });

    it('a movement with no refId is never treated as a duplicate', async () => {
      const service = makeService();
      await service.post(client as never, [movement({ refId: null, qty: '1.000' })], 'strict');
      await service.post(client as never, [movement({ refId: null, qty: '1.000' })], 'strict');
      expect(client.movements).toHaveLength(2);
    });

    it('sets sync_event_id on the row only when it is unique within the batch', async () => {
      const service = makeService();
      // Two movements sharing one syncEventId, as an exploded multi-line fact would —
      // the column must stay null for both (see stock-ledger.types.ts's doc comment).
      await service.post(
        client as never,
        [
          movement({ refId: 'multi-1', itemId: 'item-1', syncEventId: 'sync-evt-1' }),
          movement({
            refId: 'multi-1',
            itemId: 'item-2',
            storageAreaId: 'area-1',
            syncEventId: 'sync-evt-1',
          }),
        ],
        'strict',
      );
      expect(client.movements.every((m) => m.sync_event_id === null)).toBe(true);
    });

    it('sets sync_event_id when it appears exactly once in the batch', async () => {
      const service = makeService();
      await service.post(
        client as never,
        [movement({ refId: 'single-1', syncEventId: 'sync-evt-solo' })],
        'strict',
      );
      expect(client.movements[0]!.sync_event_id).toBe('sync-evt-solo');
    });
  });

  describe('transfers (paired movements, counterparty_* set)', () => {
    it('builds a same-location area transfer with counterpartyStorageAreaId set and counterpartyLocationId null', () => {
      const service = makeService();
      const [out, inbound] = service.buildTransferMovements({
        itemId: 'item-1',
        from: { locationId: 'loc-1', storageAreaId: 'area-a' },
        to: { locationId: 'loc-1', storageAreaId: 'area-b' },
        qty: '5.000',
        unitCost: '1000.00',
        refType: 'area_transfer',
        refId: 'transfer-1',
        actorId: 'user-1',
      });
      expect(out).toMatchObject({
        movementType: MovementType.TRANSFER_OUT,
        storageAreaId: 'area-a',
        counterpartyStorageAreaId: 'area-b',
        counterpartyLocationId: null,
      });
      expect(inbound).toMatchObject({
        movementType: MovementType.TRANSFER_IN,
        storageAreaId: 'area-b',
        counterpartyStorageAreaId: 'area-a',
        counterpartyLocationId: null,
      });
    });

    it('builds a cross-location transfer with counterpartyLocationId set on both sides', () => {
      const service = makeService();
      const [out, inbound] = service.buildTransferMovements({
        itemId: 'item-1',
        from: { locationId: 'loc-warehouse', storageAreaId: 'area-dry' },
        to: { locationId: 'loc-outlet', storageAreaId: 'area-kitchen' },
        qty: '5.000',
        unitCost: '1000.00',
        refType: 'sj_drop',
        refId: 'drop-1',
        actorId: 'user-1',
      });
      expect(out.counterpartyLocationId).toBe('loc-outlet');
      expect(inbound.counterpartyLocationId).toBe('loc-warehouse');
    });

    it("postTransfer posts both sides atomically and each side's balance reflects its own sign", async () => {
      const service = makeService();
      const result = await service.postTransfer(
        client as never,
        {
          itemId: 'item-1',
          from: { locationId: 'loc-1', storageAreaId: 'area-a' },
          to: { locationId: 'loc-1', storageAreaId: 'area-b' },
          qty: '5.000',
          unitCost: '1000.00',
          refType: 'area_transfer',
          refId: 'transfer-1',
          actorId: 'user-1',
        },
        'fact',
      );
      expect(result.movements).toHaveLength(2);
      expect(client.balances.get('loc-1::area-a::item-1')).toBe('-5.000');
      expect(client.balances.get('loc-1::area-b::item-1')).toBe('5.000');
    });
  });

  describe('StockMoved event emission (real EventBus, kernel/events)', () => {
    it('publishes one stock.moved event per applied movement, none for a skipped duplicate', async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.subscribe('stock.moved', handler);
      const service = makeService(bus);

      await service.post(client as never, [movement({ refId: 'evt-1' })], 'strict');
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toMatchObject({
        type: 'stock.moved',
        payload: { movementType: MovementType.PURCHASE_IN, qtyDelta: '10.000', mode: 'strict' },
      });

      handler.mockClear();
      await service.post(client as never, [movement({ refId: 'evt-1' })], 'strict'); // duplicate replay
      expect(handler).not.toHaveBeenCalled();
    });

    it('reports a negative signed qtyDelta for an _out movement type', async () => {
      const bus = new EventBus();
      const handler = vi.fn();
      bus.subscribe('stock.moved', handler);
      const service = makeService(bus);

      await service.post(client as never, [movement({ refId: 'evt-1', qty: '10.000' })], 'fact');
      await service.post(
        client as never,
        [movement({ refId: 'evt-2', movementType: MovementType.USAGE_OUT, qty: '4.000' })],
        'fact',
      );

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]![0]!.payload).toMatchObject({
        movementType: MovementType.USAGE_OUT,
        qtyDelta: '-4.000',
      });
    });

    it("a subscriber throwing does not prevent post() from resolving (EventBus's own fan-out-notifier contract)", async () => {
      const bus = new EventBus();
      bus.subscribe('stock.moved', () => {
        throw new Error('boom');
      });
      const service = makeService(bus);
      await expect(
        service.post(client as never, [movement({ refId: 'evt-3' })], 'strict'),
      ).resolves.toBeDefined();
    });
  });

  describe('reconcile()', () => {
    it('returns matches:true and writes nothing when the stored qty agrees with the fold of movements', async () => {
      const service = makeService();
      await service.post(client as never, [movement({ refId: 'r1', qty: '10.000' })], 'strict');

      // Minimal client stub for the reconcile() read path (SELECT ... FROM stock_movements without FOR UPDATE, no ref_type filter).
      const reconcileClient = {
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM stock_movements')) {
            return {
              rows: client.movements
                .filter(
                  (m) =>
                    m.location_id === 'loc-1' &&
                    m.storage_area_id === 'area-1' &&
                    m.item_id === 'item-1',
                )
                .map((m) => ({
                  id: m.id,
                  movement_type: m.movement_type,
                  qty: m.qty,
                  unit_cost: m.unit_cost,
                  ref_type: m.ref_type,
                  ref_id: m.ref_id,
                  occurred_at: new Date(),
                })),
            };
          }
          throw new Error(`unexpected query in reconcile test: ${sql}`);
        }),
      };

      const check = await service.reconcile(reconcileClient as never, KEY, '10.000');
      expect(check.matches).toBe(true);
      expect(check.reconciliationId).toBeUndefined();
    });

    it('opens a stock_reconciliations row and returns matches:false on divergence', async () => {
      const service = makeService();
      await service.post(client as never, [movement({ refId: 'r1', qty: '10.000' })], 'strict');

      const reconcileClient = {
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT id, movement_type')) {
            return {
              rows: client.movements
                .filter(
                  (m) =>
                    m.location_id === 'loc-1' &&
                    m.storage_area_id === 'area-1' &&
                    m.item_id === 'item-1',
                )
                .map((m) => ({
                  id: m.id,
                  movement_type: m.movement_type,
                  qty: m.qty,
                  unit_cost: m.unit_cost,
                  ref_type: m.ref_type,
                  ref_id: m.ref_id,
                  occurred_at: new Date(),
                })),
            };
          }
          if (sql.startsWith('INSERT INTO stock_reconciliations')) {
            return { rows: [{ id: 'rec-99' }] };
          }
          throw new Error(`unexpected query: ${sql} ${JSON.stringify(params)}`);
        }),
      };

      // Physical count says 4, but the ledger derives 10 from movements — a real opname variance.
      const check = await service.reconcile(reconcileClient as never, KEY, '4.000', {
        detail: { source: 'physical_count', opnameId: 'opn-1' },
      });
      expect(check.matches).toBe(false);
      expect(check.expectedQty).toBe('10.000');
      expect(check.storedQty).toBe('4.000');
      expect(check.divergence).toBe('6.000');
      expect(check.reconciliationId).toBe('rec-99');
    });
  });
});
