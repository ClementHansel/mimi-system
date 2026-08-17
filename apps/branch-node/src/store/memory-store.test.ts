import { describe, expect, it } from 'vitest';
import type { MovementFact } from '@mimi/sync-protocol';
import { MovementType, SyncOriginType } from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import { MemoryStore } from './memory-store';
import type { StoredSyncEvent } from './types';

function makeEvent(overrides: Partial<Omit<StoredSyncEvent, 'serverSeq'>> = {}) {
  return {
    eventId: overrides.eventId ?? (`evt-${Math.random()}` as UUID),
    originTier: SyncOriginType.DEVICE,
    originDeviceId: 'device-1' as UUID,
    locationId: 'loc-1' as UUID,
    entity: 'sales',
    entityId: 'sale-1' as UUID,
    op: 'completed',
    payload: { v: 1, data: {}, meta: { actorUserId: 'user-1', actorRole: 'kasir', appVersion: '1.0.0' } },
    clientSeq: 1n,
    occurredAt: new Date().toISOString(),
    relayReceivedAt: new Date().toISOString(),
    actorUserId: 'user-1' as UUID,
    schemaV: 1,
    ...overrides,
  };
}

describe('MemoryStore', () => {
  it('appendEvent is idempotent by eventId', async () => {
    const store = new MemoryStore();
    const event = makeEvent({ eventId: 'evt-1' as UUID });
    const first = await store.appendEvent(event);
    const second = await store.appendEvent(event);
    expect(second.serverSeq).toBe(first.serverSeq);
    const page = await store.getEventsSince(0, 10);
    expect(page.events).toHaveLength(1);
  });

  it('assigns increasing serverSeq and paginates with hasMore', async () => {
    const store = new MemoryStore();
    for (let i = 0; i < 5; i++) {
      await store.appendEvent(makeEvent({ eventId: `evt-${i}` as UUID, clientSeq: BigInt(i + 1) }));
    }
    const page1 = await store.getEventsSince(0, 3);
    expect(page1.events).toHaveLength(3);
    expect(page1.hasMore).toBe(true);
    const page2 = await store.getEventsSince(page1.nextCursor, 3);
    expect(page2.events).toHaveLength(2);
    expect(page2.hasMore).toBe(false);
  });

  it('detects seq_conflict via eventIdAtOriginSeq', async () => {
    const store = new MemoryStore();
    await store.appendEvent(makeEvent({ eventId: 'evt-a' as UUID, originDeviceId: 'origin-x' as UUID, clientSeq: 7n }));
    const conflicting = await store.eventIdAtOriginSeq('origin-x' as UUID, 7n);
    expect(conflicting).toBe('evt-a');
    const clean = await store.eventIdAtOriginSeq('origin-x' as UUID, 8n);
    expect(clean).toBeUndefined();
  });

  it('tracks per-origin high-water marks independently', async () => {
    const store = new MemoryStore();
    expect(await store.getHighWater('origin-1' as UUID)).toBe(0n);
    await store.setHighWater('origin-1' as UUID, 5n);
    await store.setHighWater('origin-2' as UUID, 9n);
    expect(await store.getHighWater('origin-1' as UUID)).toBe(5n);
    expect(await store.getHighWater('origin-2' as UUID)).toBe(9n);
  });

  it('tracks the relay outbox via per-origin cloud-confirmed high-water', async () => {
    const store = new MemoryStore();
    await store.appendEvent(makeEvent({ eventId: 'evt-1' as UUID, originDeviceId: 'origin-a' as UUID, clientSeq: 1n }));
    await store.appendEvent(makeEvent({ eventId: 'evt-2' as UUID, originDeviceId: 'origin-a' as UUID, clientSeq: 2n }));
    let unconfirmed = await store.getUnconfirmedByCloud(10);
    expect(unconfirmed.map((e) => e.eventId).sort()).toEqual(['evt-1', 'evt-2']);
    await store.setCloudConfirmedHighWater('origin-a' as UUID, 1n);
    unconfirmed = await store.getUnconfirmedByCloud(10);
    expect(unconfirmed.map((e) => e.eventId)).toEqual(['evt-2']);
    // monotonic: a lower value never regresses what's already confirmed.
    await store.setCloudConfirmedHighWater('origin-a' as UUID, 0n);
    expect(await store.getCloudConfirmedHighWater('origin-a' as UUID)).toBe(1n);
  });

  it('cursors are independent per subscriber and per stream', async () => {
    const store = new MemoryStore();
    await store.setCursor('device-a', 3);
    await store.setCursor('device-b', 7);
    expect(await store.getCursor('device-a')).toBe(3);
    expect(await store.getCursor('device-b')).toBe(7);
    expect(await store.getCursor('device-c')).toBe(0);
  });

  it('upserts discovered devices keyed by ip+mac and revives a disappeared row', async () => {
    const store = new MemoryStore();
    const input = {
      source: 'mdns' as const,
      ipAddress: '192.168.1.50',
      macAddress: 'aa:bb:cc:dd:ee:ff',
      vendor: 'Epson',
      model: 'TM-88',
      suggestedCategory: 'printer',
      suggestedName: 'Kitchen Printer',
      raw: {},
    };
    const first = await store.upsertDiscoveredDevice(input);
    expect(first.status).toBe('new');
    await store.markMissingAsDisappeared([]);
    const afterSweep = await store.listDiscoveredDevices();
    expect(afterSweep[0]!.status).toBe('disappeared');
    const revived = await store.upsertDiscoveredDevice(input);
    expect(revived.id).toBe(first.id);
    expect(revived.status).toBe('new');
  });

  it('derives stock balances from movements, deduped by factId (D-16a)', async () => {
    const store = new MemoryStore();
    const key = { locationId: 'loc-1' as UUID, storageAreaId: 'area-1' as UUID, itemId: 'item-1' as UUID };
    const movements: MovementFact[] = [
      { ...key, factId: 'fact-1', movementType: MovementType.PURCHASE_IN, qty: '10.000', unitCost: '5000.00', refType: 'receipt', refId: 'r1' as UUID, occurredAt: new Date().toISOString() },
      { ...key, factId: 'fact-2', movementType: MovementType.USAGE_OUT, qty: '3.000', unitCost: '5000.00', refType: 'sale', refId: 's1' as UUID, occurredAt: new Date().toISOString() },
    ];
    await store.appendMovements(movements);
    await store.appendMovements(movements); // replay — must not double-count (T-02)
    const balance = await store.getBalance(key);
    expect(balance).toBe('7.000');
    const all = await store.listBalances('loc-1' as UUID);
    expect(all).toHaveLength(1);
    expect(all[0]!.qtyOnHand).toBe('7.000');
  });
});
