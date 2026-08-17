import { describe, expect, it } from 'vitest';
import { SyncEntity, SyncOriginType } from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import { MemoryStore } from './store/memory-store';
import { applyWhitelistedEvent, deriveMovements } from './projector';

function makeEvent(overrides: Partial<SyncEventEnvelope>): SyncEventEnvelope {
  return {
    eventId: 'evt-1' as UUID,
    originTier: SyncOriginType.DEVICE,
    originDeviceId: 'device-1' as UUID,
    locationId: 'loc-1' as UUID,
    entity: SyncEntity.SALES,
    entityId: 'sale-1' as UUID,
    op: 'completed',
    payload: { v: 1, data: {}, meta: { actorUserId: 'user-1' as UUID, actorRole: 'kasir', appVersion: '1.0.0' } },
    clientSeq: 1n,
    occurredAt: '2026-08-17T01:00:00.000Z',
    actorUserId: 'user-1' as UUID,
    schemaV: 1,
    ...overrides,
  };
}

describe('deriveMovements', () => {
  it('derives a transfer_in movement from sj_drops.received', () => {
    const event = makeEvent({
      entity: SyncEntity.SJ_DROPS,
      entityId: 'drop-1' as UUID,
      op: 'received',
      payload: {
        v: 1,
        data: { lines: [{ storageAreaId: 'area-1', itemId: 'item-1', qtyReceived: '10.000', unitCost: '5000.00' }] },
        meta: { actorUserId: 'user-1' as UUID, actorRole: 'leader_outlet', appVersion: '1.0.0' },
      },
    });
    const movements = deriveMovements(event);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ movementType: 'transfer_in', qty: '10.000', unitCost: '5000.00', itemId: 'item-1' });
  });

  it('derives a waste_out movement from waste_records.approved', () => {
    const event = makeEvent({
      entity: SyncEntity.WASTE_RECORDS,
      entityId: 'waste-1' as UUID,
      op: 'approved',
      payload: {
        v: 1,
        data: { lines: [{ storage_area_id: 'area-1', item_id: 'item-2', qty: 2, unit_cost: 3000 }] },
        meta: { actorUserId: 'user-1' as UUID, actorRole: 'supervisor', appVersion: '1.0.0' },
      },
    });
    const movements = deriveMovements(event);
    expect(movements).toHaveLength(1);
    expect(movements[0]).toMatchObject({ movementType: 'waste_out', qty: '2.000', unitCost: '3000.00' });
  });

  it('derives an adjustment movement from stock_adjustments.posted', () => {
    const event = makeEvent({
      entity: SyncEntity.STOCK_ADJUSTMENTS,
      entityId: 'adj-1' as UUID,
      op: 'posted',
      payload: {
        v: 1,
        data: { storageAreaId: 'area-1', itemId: 'item-1', qty: '1.500', unitCost: '5000.00', direction: 'shortage' },
        meta: { actorUserId: 'user-1' as UUID, actorRole: 'kepala_gudang', appVersion: '1.0.0' },
      },
    });
    const movements = deriveMovements(event);
    expect(movements[0]).toMatchObject({ movementType: 'adjustment_out' });
  });

  it('never throws and derives nothing for a mismatched payload shape', () => {
    const event = makeEvent({
      entity: SyncEntity.SJ_DROPS,
      op: 'received',
      payload: { v: 1, data: { somethingElse: true }, meta: { actorUserId: 'user-1' as UUID, actorRole: 'x', appVersion: '1.0.0' } },
    });
    expect(() => deriveMovements(event)).not.toThrow();
    expect(deriveMovements(event)).toEqual([]);
  });

  it('returns nothing for a non-whitelisted entity', () => {
    const event = makeEvent({ entity: SyncEntity.LOCATIONS, op: 'updated' });
    expect(deriveMovements(event)).toEqual([]);
  });
});

describe('applyWhitelistedEvent', () => {
  it('caches class-M events as master data', async () => {
    const store = new MemoryStore();
    const event = makeEvent({
      entity: SyncEntity.PRODUCTS,
      entityId: 'prod-1' as UUID,
      op: 'created',
      locationId: null,
      payload: { v: 1, data: { name: 'Ayam Geprek' }, meta: { actorUserId: 'user-1' as UUID, actorRole: 'admin', appVersion: '1.0.0' } },
    });
    await applyWhitelistedEvent(store, event);
    expect(await store.getMasterData('products', 'prod-1' as UUID)).toEqual({ name: 'Ayam Geprek' });
  });

  it('projects a whitelisted F/B entity for LAN fan-out visibility', async () => {
    const store = new MemoryStore();
    const event = makeEvent({
      entity: SyncEntity.POS_SHIFTS,
      entityId: 'shift-1' as UUID,
      op: 'opened',
      payload: { v: 1, data: { openingFloat: '500000.00' }, meta: { actorUserId: 'user-1' as UUID, actorRole: 'kasir', appVersion: '1.0.0' } },
    });
    await applyWhitelistedEvent(store, event);
    const rows = await store.listProjections('pos_shifts', 'loc-1' as UUID);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toEqual({ openingFloat: '500000.00' });
  });

  it('is a no-op for an entity outside the authority matrix (opaque relay only)', async () => {
    const store = new MemoryStore();
    const event = makeEvent({ entity: 'some_future_entity' as never, op: 'whatever' });
    await expect(applyWhitelistedEvent(store, event)).resolves.toBeUndefined();
    expect(await store.listProjections('some_future_entity')).toEqual([]);
  });

  it('derives stock movements for a whitelisted stock-affecting op', async () => {
    const store = new MemoryStore();
    const event = makeEvent({
      entity: SyncEntity.GOODS_RECEIPTS,
      entityId: 'gr-1' as UUID,
      op: 'recorded',
      payload: {
        v: 1,
        data: { lines: [{ storageAreaId: 'area-1', itemId: 'item-9', qty: '4.000', unitCost: '1000.00' }] },
        meta: { actorUserId: 'user-1' as UUID, actorRole: 'leader_outlet', appVersion: '1.0.0' },
      },
    });
    await applyWhitelistedEvent(store, event);
    const balance = await store.getBalance({ locationId: 'loc-1' as UUID, storageAreaId: 'area-1' as UUID, itemId: 'item-9' as UUID });
    expect(balance).toBe('4.000');
  });
});
