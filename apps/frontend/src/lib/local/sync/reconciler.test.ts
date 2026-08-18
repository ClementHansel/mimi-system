import { describe, expect, it } from 'vitest';
import { SyncOriginType } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import { createTestDatabase } from '../test-support/fixtures';
import { reconcilePulledEvents } from './reconciler';
import { getBalance } from '../stock/stock-cache';
import { isRevoked } from '../credentials/offline-credentials';
import type { AppliedEventRecord, MasterDataRecord } from '../types';

function pulledEvent(overrides: Partial<SyncEventEnvelope>): SyncEventEnvelope {
  return {
    eventId: 'evt-default',
    originTier: SyncOriginType.CLOUD,
    originDeviceId: '00000000-0000-0000-0000-0000000000c1',
    locationId: 'loc-1',
    entity: 'settings',
    entityId: 'settings-1',
    op: 'updated',
    payload: {
      v: 1,
      data: {},
      meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
    },
    clientSeq: 1n,
    occurredAt: new Date().toISOString(),
    relayReceivedAt: new Date().toISOString(),
    relayedViaNodeId: null,
    actorUserId: 'sys',
    schemaV: 1,
    ...overrides,
  };
}

describe('reconciler (pulled-event apply, §4.5)', () => {
  it('upserts a master_data row for a pulled class-M event', async () => {
    const db = createTestDatabase();
    const event = pulledEvent({
      eventId: 'evt-1',
      entity: 'items',
      entityId: 'item-1',
      op: 'created',
      payload: {
        v: 1,
        data: { name: 'Ayam' },
        meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
      },
    });

    await reconcilePulledEvents(db, [event]);

    const row = await db.store<MasterDataRecord>('master_data').get('items:item-1');
    expect(row?.data).toEqual({ name: 'Ayam' });
  });

  it('is idempotent: re-delivering the same event twice applies it only once (T-01 at device scale)', async () => {
    const db = createTestDatabase();
    const event = pulledEvent({ eventId: 'evt-dup', entity: 'items', entityId: 'item-1' });

    const first = await reconcilePulledEvents(db, [event]);
    const second = await reconcilePulledEvents(db, [event]);

    expect(first).toEqual({ applied: 1, skippedDuplicate: 0 });
    expect(second).toEqual({ applied: 0, skippedDuplicate: 1 });

    const appliedRow = await db.store<AppliedEventRecord>('applied_events').get('evt-dup');
    expect(appliedRow).toBeDefined();
  });

  it('projects a stock_adjustments.posted pulled fact into the local movements store', async () => {
    const db = createTestDatabase();
    const event = pulledEvent({
      eventId: 'evt-adj',
      entity: 'stock_adjustments',
      entityId: 'adj-1',
      op: 'posted',
      payload: {
        v: 1,
        data: {
          locationId: 'loc-1',
          storageAreaId: 'area-1',
          itemId: 'item-1',
          qty: '4.000',
          unitCost: '1000.00',
          direction: 'overage',
        },
        meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
      },
    });

    await reconcilePulledEvents(db, [event]);
    const balance = await getBalance(db, {
      locationId: 'loc-1',
      storageAreaId: 'area-1',
      itemId: 'item-1',
    });
    expect(balance).toBe('4.000');
  });

  it('a malformed/unexpected payload shape for a stock-affecting op is caught and does not fail the whole reconcile (defensive adapters)', async () => {
    const db = createTestDatabase();

    // A recipe must be cached first so `sales.completed`'s explosion actually attempts to parse the
    // (here, deliberately invalid) qty string — otherwise "no cached recipe for this product" would
    // legitimately skip the line without ever exercising the defensive catch.
    await reconcilePulledEvents(db, [
      pulledEvent({
        eventId: 'evt-recipe',
        entity: 'recipes',
        entityId: 'product-bad',
        op: 'updated',
        payload: {
          v: 1,
          data: { lines: [{ itemId: 'item-1', qtyPerUnit: '1.000', unitCost: '2000.00' }] },
          meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
        },
      }),
    ]);

    const event = pulledEvent({
      eventId: 'evt-bad',
      entity: 'sales',
      entityId: 'sale-bad',
      op: 'completed',
      payload: {
        v: 1,
        data: {
          lines: [{ productId: 'product-bad', qty: 'not-a-decimal' }],
          target: { locationId: 'loc-1', storageAreaId: 'area-1' },
        },
        meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
      },
    });

    const warnings: string[] = [];
    const result = await reconcilePulledEvents(db, [event], {
      onWarning: (msg) => warnings.push(msg),
    });

    expect(result.applied).toBe(1); // master-data upsert still happened
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('applies an offline_authorizations.revoked pull as a local CRL entry', async () => {
    const db = createTestDatabase();
    const event = pulledEvent({
      eventId: 'evt-revoke',
      entity: 'offline_authorizations',
      entityId: 'auth-1',
      op: 'revoked',
      payload: {
        v: 1,
        data: { credentialId: 'cred-1' },
        meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
      },
    });

    await reconcilePulledEvents(db, [event]);
    expect(await isRevoked(db, 'cred-1')).toBe(true);
  });

  it('applies a sales.completed pull (e.g. node fan-out of a sibling device sale) using cached recipe data', async () => {
    const db = createTestDatabase();
    // Recipe must already be cached (pulled earlier) for the sale to explode into a movement.
    await reconcilePulledEvents(db, [
      pulledEvent({
        eventId: 'evt-recipe',
        entity: 'recipes',
        entityId: 'product-1',
        op: 'updated',
        payload: {
          v: 1,
          data: { lines: [{ itemId: 'item-1', qtyPerUnit: '1.000', unitCost: '2000.00' }] },
          meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
        },
      }),
    ]);
    await reconcilePulledEvents(db, [
      pulledEvent({
        eventId: 'evt-receipt',
        entity: 'stock_adjustments',
        entityId: 'adj-pre',
        op: 'posted',
        payload: {
          v: 1,
          data: {
            locationId: 'loc-1',
            storageAreaId: 'area-1',
            itemId: 'item-1',
            qty: '10.000',
            unitCost: '2000.00',
            direction: 'overage',
          },
          meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
        },
      }),
    ]);
    await reconcilePulledEvents(db, [
      pulledEvent({
        eventId: 'evt-sale',
        entity: 'sales',
        entityId: 'sale-sibling-1',
        op: 'completed',
        payload: {
          v: 1,
          data: {
            lines: [{ productId: 'product-1', qty: '3.000' }],
            target: { locationId: 'loc-1', storageAreaId: 'area-1' },
          },
          meta: { actorUserId: 'sys', actorRole: 'system', appVersion: '1.0.0' },
        },
      }),
    ]);

    const balance = await getBalance(db, {
      locationId: 'loc-1',
      storageAreaId: 'area-1',
      itemId: 'item-1',
    });
    expect(balance).toBe('7.000'); // 10 - 3
  });
});
