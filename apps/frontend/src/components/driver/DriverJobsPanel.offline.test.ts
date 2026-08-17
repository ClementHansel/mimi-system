import { describe, it, expect, vi } from 'vitest';
import { createMemoryDatabase } from '@/lib/local/store/memory-database';
import { STORE_KEY_PATH } from '@/lib/local/types';
import { createLocalRuntime } from '@/lib/local/api/local-runtime';
import type { SyncTransport } from '@/lib/local/transport/types';
import type { ConnectivityReporter } from '@/lib/local/sync/sync-engine';

/**
 * Proves this ticket's Done-when scenario against the actual `LocalRuntime`
 * (not `DriverJobsPanel`'s React tree, which would need a full jsdom +
 * IndexedDB shim to exercise meaningfully — same reasoning
 * `ReceivingPanel.offline.test.ts` documents, which this file mirrors): a
 * driver 200km from the warehouse, signal down, runs the FULL per-drop
 * lifecycle — depart → arrive (seal + temp) → serah terima (photo,
 * signature, per-line qty) — plus a mid-route temperature reading, and
 * every one of those queues locally instead of blocking on connectivity.
 *
 * The transport below throws on every method and is never given to
 * `runtime.start()`/`syncNow()`, so the only way this test could pass by
 * accident is if one of `commitDropDeparted`/`commitDropArrived`/
 * `commitDropReceived`/`commitTempLog`/`captureEvidence` secretly reached
 * across the network itself. None of them do — all write to the local
 * IndexedDB-shaped store only.
 */
function unreachableTransport(): SyncTransport {
  const fail = () => {
    throw new Error('network disabled — this transport must never be called by a local commit');
  };
  return { health: fail, hello: fail, push: fail, pull: fail, heartbeat: fail } as unknown as SyncTransport;
}

const noopConnectivity: ConnectivityReporter = {
  setTier: vi.fn(),
  setCloudReachable: vi.fn(),
  setQueueDepth: vi.fn(),
  setLastSyncAt: vi.fn(),
  setSyncing: vi.fn(),
};

const ACTOR = { actorUserId: 'driver-user-1', actorRole: 'driver', appVersion: 'test' };

describe('Driver drop lifecycle — offline queuing via LocalRuntime (this ticket\'s Done-when scenario)', () => {
  it('queues depart → temp log → arrive → temp log → serah terima end to end with zero network calls, outbox growing one row per fact', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({
      db,
      transport: unreachableTransport(),
      candidates: [], // no upstream configured — nothing for the engine to even try reaching
      connectivity: noopConnectivity,
    });
    await runtime.init();

    expect(await runtime.getOutboxDepth()).toBe(0);

    const dropId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const sjId = 'f1b2c3d4-e5f6-7890-abcd-ef1234567890';

    // 1. Depart — frozen shipment, load temp entered.
    await runtime.commitDropDeparted(dropId, { dropId, at: '2026-08-17T01:00:00.000Z', tempC: '-18.0' }, ACTOR);
    await runtime.commitTempLog(crypto.randomUUID(), { sjId, dropId, stage: 'depart', tempC: '-18.0' }, ACTOR);
    expect(await runtime.getOutboxDepth()).toBe(2);

    // 2. Arrive — seal verified intact, arrival temp logged (registry requires tempC on arrive).
    await runtime.commitDropArrived(
      dropId,
      { dropId, at: '2026-08-17T04:00:00.000Z', tempC: '-19.0', sealCheck: { sealId: crypto.randomUUID(), status: 'verified_intact' } },
      ACTOR,
    );
    await runtime.commitTempLog(crypto.randomUUID(), { sjId, dropId, stage: 'arrive', tempC: '-19.0' }, ACTOR);
    expect(await runtime.getOutboxDepth()).toBe(4);

    // 3. Serah terima — evidence captured locally first (no upload attempted here).
    const photoBlob = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
    const signatureBlob = new Blob(['fake-png-bytes'], { type: 'image/png' });
    const photoRef = await runtime.captureEvidence(photoBlob, 'image/jpeg', 'delivery_receiving_photo');
    const signatureRef = await runtime.captureEvidence(signatureBlob, 'image/png', 'delivery_receiving_signature');
    expect(photoRef.attachmentId).toBeTruthy();
    expect(signatureRef.attachmentId).toBeTruthy();
    // The two captured blobs get distinct attachment ids — each one must
    // correlate back to its OWN blob (attachment-store.ts's "two
    // identities, one row"), not share a single minted id.
    expect(photoRef.attachmentId).not.toBe(signatureRef.attachmentId);

    const result = await runtime.commitDropReceived(
      dropId,
      {
        dropId,
        lines: [{ lineId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890', qtyReceived: '10.000', receivedStorageAreaId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }],
        photoAttachmentIds: [photoRef.attachmentId],
        signatureAttachmentId: signatureRef.attachmentId,
        tempC: '-19.5',
        clientId: crypto.randomUUID(),
      },
      ACTOR,
    );

    expect(result.envelope.eventId).toBeTruthy();
    expect(result.wasAlreadyCommitted).toBe(false);

    // Every fact in the whole drop lifecycle is sitting in the outbox, not
    // lost, not blocked on connectivity: 2 drop-status facts + 2 temp logs
    // + 1 receipt = 5.
    expect(await runtime.getOutboxDepth()).toBe(5);
  });

  it('is idempotent on retry: resubmitting depart against the SAME entityId does not double-queue (double-tap guard)', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({ db, transport: unreachableTransport(), candidates: [], connectivity: noopConnectivity });
    await runtime.init();

    const dropId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567891';
    const payload = { dropId, at: '2026-08-17T01:00:00.000Z', tempC: '-18.0' };

    await runtime.commitDropDeparted(dropId, payload, ACTOR);
    await runtime.commitDropDeparted(dropId, payload, ACTOR); // double-tap submit, same drop

    expect(await runtime.getOutboxDepth()).toBe(1);
  });

  it('never blocks a LATER drop on an EARLIER one — two drops on the same route depart independently', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({ db, transport: unreachableTransport(), candidates: [], connectivity: noopConnectivity });
    await runtime.init();

    const dropA = 'a1b2c3d4-e5f6-7890-abcd-ef1234567892';
    const dropB = 'a1b2c3d4-e5f6-7890-abcd-ef1234567893';

    // Drop B departs (driver skipped ahead — drop A's outlet was
    // unreachable) even though drop A never departed. Each drop is its own
    // `(entity, entityId, op)` row, so this must NOT collide with, or be
    // blocked by, drop A's untouched state.
    await runtime.commitDropDeparted(dropB, { dropId: dropB, at: '2026-08-17T01:00:00.000Z' }, ACTOR);
    expect(await runtime.getOutboxDepth()).toBe(1);

    // Drop A can still depart independently afterwards — no ordering lock.
    await runtime.commitDropDeparted(dropA, { dropId: dropA, at: '2026-08-17T05:00:00.000Z' }, ACTOR);
    expect(await runtime.getOutboxDepth()).toBe(2);
  });
});
