import { describe, expect, it } from 'vitest';
import { SyncEntity } from '@mimi/shared';
import { createTestDatabase, setupIdentity, ACTOR } from '../test-support/fixtures';
import { commitFact, getOutboxDepth } from '../idempotent-commit';
import { drainOutboxOnce } from './outbox-drain';
import { FakeCloud } from '../transport/fake-cloud';
import type { SyncTransport } from '../transport/types';

/**
 * W6-02 adversarial case: "kill network mid-sale". On a flaky outlet Wi-Fi
 * (or a browser tab that backgrounds/dies a beat after `fetch()` fires) the
 * REQUEST can reach the cloud and be durably applied there while the
 * response never makes it back to the device. `drainOutboxOnce` cannot tell
 * this apart from an ordinary transport failure — its `catch` fires, the
 * outbox row is left `pending` for a retry (`outbox-drain.ts`'s own header:
 * "mark attempts... stop draining, let the caller back off"). This file
 * proves the RETRY that follows, landing at a cloud that already has the
 * fact, converges to exactly one applied event — never a second sale, never
 * a lost one.
 *
 * Deliberately distinct from `sync-engine.scenario.test.ts`'s "T-06 variant"
 * (which drains once (a clean confirm-and-prune), then drains again with an
 * ALREADY-EMPTY outbox — nothing left to resend, so cloud-side dedupe is
 * never actually exercised there). Here the outbox row is genuinely still
 * `pending` when the resend happens: this is what puts `processOriginBatch`'s
 * duplicate-detection (`packages/sync-protocol/src/cursor.ts`), not the
 * device's own `commitFact` double-tap guard, on trial.
 */

/**
 * A transport whose `push()` reaches the real `FakeCloud` (so the fact IS
 * durably applied) and then throws for the first `dropAckForCalls` calls —
 * modeling "the response never reached the device" rather than "the cloud
 * never saw the request". Every other transport method passes straight
 * through unmodified.
 */
function ackDroppingTransport(cloud: FakeCloud, dropAckForCalls: number): SyncTransport {
  let calls = 0;
  return {
    health: (baseUrl) => cloud.health(baseUrl),
    hello: (baseUrl, req) => cloud.hello(baseUrl, req),
    heartbeat: (baseUrl, payload) => cloud.heartbeat(baseUrl, payload),
    pull: (baseUrl, cursor, limit) => cloud.pull(baseUrl, cursor, limit),
    async push(baseUrl, batch) {
      calls += 1;
      const ack = await cloud.push(baseUrl, batch); // applied at "cloud" regardless of what happens next
      if (calls <= dropAckForCalls) {
        throw new Error('simulated: ack never reached the device (network killed / tab died)');
      }
      return ack;
    },
  };
}

describe('kill-network-mid-sale: the cloud already applied the push, but the device never learned that (ack lost)', () => {
  it('a single sale survives an ack-lost retry with exactly one applied event at cloud', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: 'sale-mid-kill',
      data: { total: '25000.00' },
      meta: ACTOR,
    });

    const cloud = new FakeCloud();
    const flaky = ackDroppingTransport(cloud, 1);

    const firstAttempt = await drainOutboxOnce(db, flaky, 'https://cloud.mimi');
    expect(firstAttempt.transportFailed).toBe(true);
    // The device does not know the cloud already has it — the row is still queued locally.
    expect(await getOutboxDepth(db)).toBe(1);
    // But the cloud DID apply it on that same call — the request landed, only the ack was lost.
    expect(cloud.appliedEvents()).toHaveLength(1);

    const retry = await drainOutboxOnce(db, flaky, 'https://cloud.mimi');
    expect(retry.transportFailed).toBe(false);
    expect(retry.eventsConfirmed).toBe(1);
    expect(await getOutboxDepth(db)).toBe(0);

    // The load-bearing assertion: still exactly one applied event, never two.
    expect(cloud.appliedEvents()).toHaveLength(1);
  });

  it('double-tap + ack-loss compound: two rapid submits of one draft, whose first transmission also loses its ack, still lands exactly once', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    const draftId = 'draft-mid-kill';

    // Two rapid taps BEFORE any network activity — commitFact's own double-tap
    // guard (§2.2 rule 3) already collapses these to one outbox row.
    await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: draftId,
      data: { total: '1000.00' },
      meta: ACTOR,
    });
    const secondTap = await commitFact(db, {
      entity: SyncEntity.SALES,
      op: 'completed',
      entityId: draftId,
      data: { total: '1000.00' },
      meta: ACTOR,
    });
    expect(secondTap.wasAlreadyCommitted).toBe(true);
    expect(await getOutboxDepth(db)).toBe(1);

    const cloud = new FakeCloud();
    const flaky = ackDroppingTransport(cloud, 1);
    await drainOutboxOnce(db, flaky, 'https://cloud.mimi'); // transportFailed to the device, but cloud already applied it
    await drainOutboxOnce(db, flaky, 'https://cloud.mimi'); // resend of the SAME row; cloud dedupes by (originDeviceId, clientSeq)

    expect(cloud.appliedEvents()).toHaveLength(1);
    expect(await getOutboxDepth(db)).toBe(0);
  });

  it('a multi-event batch whose ack is lost twice in a row eventually converges with zero duplicates once the ack finally gets through', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);
    for (let i = 0; i < 6; i++) {
      await commitFact(db, {
        entity: SyncEntity.SALES,
        op: 'completed',
        entityId: `sale-batch-${i}`,
        data: {},
        meta: ACTOR,
      });
    }
    const cloud = new FakeCloud();
    const flaky = ackDroppingTransport(cloud, 2); // ack lost on the first TWO push attempts

    await drainOutboxOnce(db, flaky, 'https://cloud.mimi');
    await drainOutboxOnce(db, flaky, 'https://cloud.mimi');
    // From the device's point of view nothing has confirmed yet ...
    expect(await getOutboxDepth(db)).toBe(6);
    // ... but the cloud already durably has all 6, applied exactly once each across both attempts.
    expect(cloud.appliedEvents()).toHaveLength(6);

    const finalAttempt = await drainOutboxOnce(db, flaky, 'https://cloud.mimi');
    expect(finalAttempt.eventsConfirmed).toBe(6);
    expect(await getOutboxDepth(db)).toBe(0);
    expect(cloud.appliedEvents()).toHaveLength(6); // never 12, never 18
  });
});
