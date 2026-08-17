import { describe, it, expect, vi } from 'vitest';
import { createMemoryDatabase } from '@/lib/local/store/memory-database';
import { STORE_KEY_PATH } from '@/lib/local/types';
import { createLocalRuntime } from '@/lib/local/api/local-runtime';
import { getAttachmentByAttachmentId } from '@/lib/local/attachments/attachment-store';
import type { SyncTransport } from '@/lib/local/transport/types';
import type { ConnectivityReporter } from '@/lib/local/sync/sync-engine';

/**
 * Proves RISK-02's scenario against the actual `LocalRuntime`, not against
 * `ReceivingPanel`'s React tree (which would need a full jsdom + IndexedDB
 * shim to exercise meaningfully): a Surat Jalan arrives at an outlet with no
 * internet, staff captures the wajib photo + signature, and the receipt
 * queues locally instead of being blocked on connectivity.
 *
 * The transport below throws on every method — standing in for "network
 * disabled" — and is never given to `runtime.start()`/`syncNow()`, so the
 * only way this test could pass by accident is if `commitDropReceived` or
 * `captureEvidence` secretly reached across the network themselves. They
 * don't: both write to the local IndexedDB-shaped store only.
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

const ACTOR = { actorUserId: 'user-1', actorRole: 'leader_outlet', appVersion: 'test' };

describe('ReceiveDropForm submit path — offline queuing via commitDropReceived (RISK-02)', () => {
  it('captures photo + signature evidence and commits the receipt to the local outbox with zero network calls', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({
      db,
      transport: unreachableTransport(),
      candidates: [], // no upstream configured — nothing for the engine to even try reaching
      connectivity: noopConnectivity,
    });
    await runtime.init();

    expect(await runtime.getOutboxDepth()).toBe(0);

    const photoBlob = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
    const signatureBlob = new Blob(['fake-png-bytes'], { type: 'image/png' });

    // Wajib evidence capture — local-only, no upload attempted here.
    const photoRef = await runtime.captureEvidence(photoBlob, 'image/jpeg', 'receiving_photo');
    const signatureRef = await runtime.captureEvidence(signatureBlob, 'image/png', 'receiving_signature');
    expect(photoRef.sha256).toBeTruthy();
    expect(signatureRef.sha256).toBeTruthy();

    const dropId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const result = await runtime.commitDropReceived(
      dropId,
      {
        dropId,
        lines: [{ lineId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890', qtyReceived: '10.000', receivedStorageAreaId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }],
        // Regression guard for B-12: this MUST be the ref's own `attachmentId`
        // (resolvable back to the captured blob), never a freshly minted id —
        // a minted id here would point at nothing and the FR-LOG-15 wajib-foto
        // evidence would be unretrievable at inspection time.
        photoAttachmentIds: [photoRef.attachmentId],
        signatureAttachmentId: signatureRef.attachmentId,
        clientId: crypto.randomUUID(),
      },
      ACTOR,
    );

    expect(result.envelope.eventId).toBeTruthy();
    expect(result.wasAlreadyCommitted).toBe(false);

    // The receipt is sitting in the outbox, not lost, not blocked on connectivity.
    expect(await runtime.getOutboxDepth()).toBe(1);

    // The property that actually matters: the QUEUED EVENT's own attachment
    // reference resolves back to the exact blob that was captured — not just
    // that some UUID-shaped field is populated (W2-E's own test shape for
    // this, per the coordinator's note on B-12).
    const queuedPhotoId = (result.envelope.payload.data as { photoAttachmentIds: string[] }).photoAttachmentIds[0]!;
    const resolved = await getAttachmentByAttachmentId(db, queuedPhotoId);
    expect(resolved).toBeDefined();
    expect(resolved?.sha256).toBe(photoRef.sha256);
  });

  it('is idempotent on retry: resubmitting against the SAME entityId does not double-queue', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({
      db,
      transport: unreachableTransport(),
      candidates: [],
      connectivity: noopConnectivity,
    });
    await runtime.init();

    const photoRef = await runtime.captureEvidence(new Blob(['x']), 'image/jpeg', 'receiving_photo');
    const signatureRef = await runtime.captureEvidence(new Blob(['y']), 'image/png', 'receiving_signature');

    const dropId = 'a1b2c3d4-e5f6-7890-abcd-ef1234567891';
    const payload = {
      dropId,
      lines: [{ lineId: 'b1b2c3d4-e5f6-7890-abcd-ef1234567890', qtyReceived: '10.000', receivedStorageAreaId: 'c1b2c3d4-e5f6-7890-abcd-ef1234567890' }],
      photoAttachmentIds: [photoRef.attachmentId],
      signatureAttachmentId: signatureRef.attachmentId,
      clientId: crypto.randomUUID(),
    };

    await runtime.commitDropReceived(dropId, payload, ACTOR);
    await runtime.commitDropReceived(dropId, payload, ACTOR); // double-tap submit, same drop

    expect(await runtime.getOutboxDepth()).toBe(1);
  });
});
