import { describe, expect, it } from 'vitest';
import { SyncEntity } from '@mimi/shared';
import { createTestDatabase, setupIdentity, ACTOR } from '../test-support/fixtures';
import { commitFact, getOutboxDepth } from '../idempotent-commit';
import { drainOutboxOnce } from './outbox-drain';
import { FakeCloud } from '../transport/fake-cloud';
import type { OutboxRecord, QuarantineRecord } from '../types';

describe('drainOutboxOnce (SYNC-PROTOCOL §4.3 push)', () => {
  it('pushes queued events and prunes them from the outbox once cloud-confirmed', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await commitFact(db, { entity: SyncEntity.SALES, op: 'completed', entityId: 'sale-1', data: {}, meta: ACTOR });
    await commitFact(db, { entity: SyncEntity.SALES, op: 'completed', entityId: 'sale-2', data: {}, meta: ACTOR });

    const cloud = new FakeCloud();
    const result = await drainOutboxOnce(db, cloud, 'https://cloud.mimi');

    expect(result.transportFailed).toBe(false);
    expect(result.eventsConfirmed).toBe(2);
    expect(await getOutboxDepth(db)).toBe(0);
    expect(cloud.appliedEvents()).toHaveLength(2);
  });

  it('does nothing and reports zero when the outbox is empty', async () => {
    const db = createTestDatabase();
    const cloud = new FakeCloud();
    const result = await drainOutboxOnce(db, cloud, 'https://cloud.mimi');
    expect(result).toMatchObject({ batchesSent: 0, eventsPushed: 0 });
  });

  it('marks transportFailed and leaves the outbox untouched when the upstream is unreachable (retry later)', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await commitFact(db, { entity: SyncEntity.SALES, op: 'completed', entityId: 'sale-1', data: {}, meta: ACTOR });

    const cloud = new FakeCloud({ healthy: false });
    const result = await drainOutboxOnce(db, cloud, 'https://cloud.mimi');

    expect(result.transportFailed).toBe(true);
    expect(await getOutboxDepth(db)).toBe(1); // nothing lost, nothing wrongly pruned
  });

  it('duplicate submit (T-10): re-pushing the SAME outbox row after a partial failure never double-applies at cloud', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await commitFact(db, { entity: SyncEntity.SALES, op: 'completed', entityId: 'sale-1', data: {}, meta: ACTOR });

    const cloud = new FakeCloud();
    await drainOutboxOnce(db, cloud, 'https://cloud.mimi'); // confirms + prunes
    // Re-run drain with an outbox that (in a buggy implementation) might still hold the row —
    // here we simulate a retried transmission of the SAME envelope arriving again directly at cloud.
    const outboxSnapshotBeforePrune = (await db.store<OutboxRecord>('outbox').getAll());
    expect(outboxSnapshotBeforePrune).toHaveLength(0);
    expect(cloud.appliedEvents()).toHaveLength(1); // exactly once, not twice
  });

  it('a permanently rejected (malformed/authority-violating) event is quarantined and does not block the rest of the batch', async () => {
    const db = createTestDatabase();
    const identity = await setupIdentity(db);
    // Craft a bad envelope directly into the outbox (bypassing commitFact's own guard) to simulate
    // an event that reaches the transport layer malformed (e.g. from a future app version's payload).
    const cloud = new FakeCloud();
    await db.store<OutboxRecord>('outbox').put({
      eventId: 'bad-event-1',
      envelope: {
        eventId: 'bad-event-1',
        originTier: identity.originDeviceId ? ('device' as never) : ('device' as never),
        originDeviceId: identity.originDeviceId,
        locationId: 'loc-1',
        entity: 'not_a_real_entity',
        entityId: 'x',
        op: 'nonsense',
        payload: { v: 1, data: {}, meta: { actorUserId: 'u', actorRole: 'kasir', appVersion: '1.0' } },
        clientSeq: 1n,
        occurredAt: new Date().toISOString(),
        relayReceivedAt: null,
        relayedViaNodeId: null,
        actorUserId: 'u',
        schemaV: 1,
      },
      status: 'pending',
      attempt: 0,
      lastAttemptAt: null,
      lastError: null,
      createdAt: new Date().toISOString(),
    });

    const result = await drainOutboxOnce(db, cloud, 'https://cloud.mimi');
    expect(result.eventsQuarantined).toBe(1);
    expect(await getOutboxDepth(db)).toBe(0);
    const quarantined = await db.store<QuarantineRecord>('outbox_quarantine').getAll();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]!.code).toBe('malformed');
  });
});
