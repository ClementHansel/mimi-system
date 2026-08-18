import { describe, expect, it } from 'vitest';
import { SyncEntity } from '@mimi/shared';
import { commitFact, getOutboxDepth } from './idempotent-commit';
import {
  createTestDatabase,
  createSeededRandom,
  setupIdentity,
  ACTOR,
} from './test-support/fixtures';
import type { OutboxRecord } from './types';

describe('commitFact (SYNC-PROTOCOL §2.2 atomic outbox commit)', () => {
  it('mints a gapless client_seq starting at 1 and increments per commit', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const random = createSeededRandom();

    const r1 = await commitFact(
      db,
      { entity: SyncEntity.SALES, op: 'completed', entityId: 'sale-1', data: {}, meta: ACTOR },
      [],
      random,
    );
    const r2 = await commitFact(
      db,
      { entity: SyncEntity.SALES, op: 'completed', entityId: 'sale-2', data: {}, meta: ACTOR },
      [],
      random,
    );

    expect(r1.envelope.clientSeq).toBe(1n);
    expect(r2.envelope.clientSeq).toBe(2n);
    expect(await getOutboxDepth(db)).toBe(2);
  });

  it('mints a UUIDv7 event_id, never reused across commits', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const r1 = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-1',
      data: {},
      meta: ACTOR,
    });
    const r2 = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-2',
      data: {},
      meta: ACTOR,
    });
    expect(r1.envelope.eventId).not.toEqual(r2.envelope.eventId);
    expect(r1.envelope.eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  });

  it('double-tap guard (rule 3): retrying the SAME (entity, entityId, op) returns the original committed event, never a second one', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);

    const draftId = 'draft-sale-1';
    const first = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: draftId,
      data: { total: '10000.00' },
      meta: ACTOR,
    });
    const second = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: draftId,
      data: { total: '99999.00' },
      meta: ACTOR,
    });

    expect(second.wasAlreadyCommitted).toBe(true);
    expect(second.record.eventId).toBe(first.record.eventId);
    expect(second.envelope.payload.data).toEqual({ total: '10000.00' }); // the retry's new data is discarded — the ORIGINAL commit is authoritative
    expect(await getOutboxDepth(db)).toBe(1);
  });

  it('a genuinely new entityId is a new fact even if identical in content (two identical sales are legal)', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const r1 = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-a',
      data: { total: '5000.00' },
      meta: ACTOR,
    });
    const r2 = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-b',
      data: { total: '5000.00' },
      meta: ACTOR,
    });
    expect(r1.envelope.eventId).not.toEqual(r2.envelope.eventId);
    expect(await getOutboxDepth(db)).toBe(2);
  });

  it('rejects an attempt to originate a class-M (master-data) push — authority_violation, per §3.4 step 2', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await expect(
      commitFact(db, {
        entity: SyncEntity.PRODUCTS,
        op: 'price_changed',
        entityId: 'p-1',
        data: {},
        meta: ACTOR,
      }),
    ).rejects.toThrow(/ERR_SYNC_AUTHORITY_VIOLATION/);
    expect(await getOutboxDepth(db)).toBe(0);
  });

  it('rejects an op outside the entity vocabulary (malformed)', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await expect(
      commitFact(db, {
        entity: SyncEntity.SALES,
        op: 'made_up_op',
        entityId: 'sale-1',
        data: {},
        meta: ACTOR,
      }),
    ).rejects.toThrow();
  });

  it('T-08: a thrown error partway through the transaction leaves NEITHER the outbox row NOR the local projection behind (never a receipt for an unqueued event)', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);

    let projected = false;
    await expect(
      commitFact(db, {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: 'sale-crash',
        data: {},
        meta: ACTOR,
        projectWithin: async () => {
          projected = true;
          throw new Error('simulated crash after the outbox write, before commit');
        },
      }),
    ).rejects.toThrow('simulated crash');

    // The projection callback DID run (proving the crash happened mid-transaction, not before it) ...
    expect(projected).toBe(true);
    // ... yet nothing committed: no outbox row exists for this action.
    expect(await getOutboxDepth(db)).toBe(0);
  });

  it('T-08 counterpart: a successful commit leaves BOTH the outbox row and the projection in place together', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    let projectedEventId: string | undefined;

    const result = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-ok',
      data: {},
      meta: ACTOR,
      projectWithin: async (_tx, envelope) => {
        projectedEventId = envelope.eventId;
      },
    });

    expect(projectedEventId).toBe(result.envelope.eventId);
    expect(await getOutboxDepth(db)).toBe(1);
  });

  it('stamps occurred_at/rawDeviceTime/clockOffsetMs from the current clock state', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await db
      .store('clock_state')
      .put({ id: 'self', offsetMs: 5000, samples: [5000], lastMeasuredAt: null });

    const result = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-1',
      data: {},
      meta: ACTOR,
    });
    expect(result.envelope.payload.meta.clockOffsetMs).toBe(5000);
    expect(
      new Date(result.envelope.occurredAt).getTime() -
        new Date(result.envelope.payload.meta.rawDeviceTime!).getTime(),
    ).toBe(5000);
  });

  it('throws if device identity was never initialized', async () => {
    const db = createTestDatabase();
    await expect(
      commitFact(db, {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: 'sale-1',
        data: {},
        meta: ACTOR,
      }),
    ).rejects.toThrow(/Device identity not initialized/);
  });

  it('outbox rows carry the full envelope needed for push', async () => {
    const db = createTestDatabase();
    const identity = await setupIdentity(db);
    const result = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-1',
      data: { x: 1 },
      meta: ACTOR,
    });
    const stored = await db.store<OutboxRecord>('outbox').get(result.record.eventId);
    expect(stored?.envelope.originDeviceId).toBe(identity.originDeviceId);
    expect(stored?.envelope.locationId).toBe('loc-1');
    expect(stored?.status).toBe('pending');
  });
});
