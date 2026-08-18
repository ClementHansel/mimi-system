import { describe, it, expect, vi } from 'vitest';
import { createMemoryDatabase } from '@/lib/local/store/memory-database';
import { STORE_KEY_PATH } from '@/lib/local/types';
import { createLocalRuntime } from '@/lib/local/api/local-runtime';
import type { SyncTransport } from '@/lib/local/transport/types';
import type { ConnectivityReporter } from '@/lib/local/sync/sync-engine';

/**
 * Proves the scenario the coordinator called out: a staff member checks in
 * from a car park at 6am with no signal. Under the FIRST version of
 * `AbsenPanel` this called `POST /hr/attendance/check-in` directly and
 * simply failed offline — turning a connectivity problem into an *alpha* day
 * (POUT-03: a missed check-in is a wage deduction). The fix routes check-in/
 * out through `LocalRuntime.commitAttendanceCheckIn`/`commitAttendanceCheckOut`
 * instead (same as `ReceivingPanel.offline.test.ts` proves for F04's
 * `commitDropReceived`).
 *
 * The transport below throws on every method and is never handed to
 * `runtime.start()`/`syncNow()`, so this can only pass if the commit and the
 * selfie evidence capture are genuinely local-only — a test that mocks
 * `fetch` instead would not prove that.
 */
function unreachableTransport(): SyncTransport {
  const fail = () => {
    throw new Error('network disabled — this transport must never be called by a local commit');
  };
  return {
    health: fail,
    hello: fail,
    push: fail,
    pull: fail,
    heartbeat: fail,
  } as unknown as SyncTransport;
}

const noopConnectivity: ConnectivityReporter = {
  setTier: vi.fn(),
  setCloudReachable: vi.fn(),
  setQueueDepth: vi.fn(),
  setLastSyncAt: vi.fn(),
  setSyncing: vi.fn(),
};

const ACTOR = { actorUserId: 'user-1', actorRole: 'leader_outlet', appVersion: 'test' };
const LOCATION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

describe('Absen check-in/out — offline queuing via commitAttendanceCheckIn/Out', () => {
  it('captures the wajib selfie and queues the check-in fact with zero network calls', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({
      db,
      transport: unreachableTransport(),
      candidates: [], // no upstream configured — nothing for the engine to even try reaching
      connectivity: noopConnectivity,
    });
    await runtime.init();

    expect(await runtime.getOutboxDepth()).toBe(0);

    const selfieBlob = new Blob(['fake-jpeg-bytes'], { type: 'image/jpeg' });
    const selfieRef = await runtime.captureEvidence(selfieBlob, 'image/jpeg', 'selfie');
    expect(selfieRef.attachmentId).toBeTruthy();
    expect(selfieRef.sha256).toBeTruthy();

    const attendanceId = crypto.randomUUID();
    const result = await runtime.commitAttendanceCheckIn(
      attendanceId,
      {
        clientId: crypto.randomUUID(),
        locationId: LOCATION_ID,
        lat: '-1.234567',
        lng: '116.123456',
        accuracyM: 12,
        selfieAttachmentId: selfieRef.attachmentId,
        at: new Date().toISOString(),
      },
      ACTOR,
    );

    expect(result.envelope.eventId).toBeTruthy();
    expect(result.wasAlreadyCommitted).toBe(false);

    // The check-in is sitting in the outbox — queued, not lost, not blocked
    // on connectivity. This is what stands between a dead phone signal and
    // an unwarranted POUT-03 wage deduction.
    expect(await runtime.getOutboxDepth()).toBe(1);
  });

  it('queues check-out against the SAME attendanceId as check-in, still with zero network calls', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({
      db,
      transport: unreachableTransport(),
      candidates: [],
      connectivity: noopConnectivity,
    });
    await runtime.init();

    const attendanceId = crypto.randomUUID();
    const selfieRef = await runtime.captureEvidence(
      new Blob(['a'], { type: 'image/jpeg' }),
      'image/jpeg',
      'selfie',
    );

    await runtime.commitAttendanceCheckIn(
      attendanceId,
      {
        clientId: crypto.randomUUID(),
        locationId: LOCATION_ID,
        lat: '-1.2',
        lng: '116.1',
        accuracyM: 10,
        selfieAttachmentId: selfieRef.attachmentId,
        at: new Date().toISOString(),
      },
      ACTOR,
    );
    expect(await runtime.getOutboxDepth()).toBe(1);

    await runtime.commitAttendanceCheckOut(
      attendanceId,
      {
        clientId: crypto.randomUUID(),
        locationId: LOCATION_ID,
        lat: '-1.2',
        lng: '116.1',
        accuracyM: 10,
        selfieAttachmentId: selfieRef.attachmentId,
        at: new Date().toISOString(),
      },
      ACTOR,
    );

    // Two distinct facts (checked_in + checked_out) against one attendanceId.
    expect(await runtime.getOutboxDepth()).toBe(2);
  });

  it('is idempotent on retry: resubmitting the SAME check-in does not double-queue', async () => {
    const db = createMemoryDatabase(STORE_KEY_PATH);
    const runtime = createLocalRuntime({
      db,
      transport: unreachableTransport(),
      candidates: [],
      connectivity: noopConnectivity,
    });
    await runtime.init();

    const attendanceId = crypto.randomUUID();
    const selfieRef = await runtime.captureEvidence(
      new Blob(['a'], { type: 'image/jpeg' }),
      'image/jpeg',
      'selfie',
    );
    const payload = {
      clientId: crypto.randomUUID(),
      locationId: LOCATION_ID,
      lat: '-1.2',
      lng: '116.1',
      accuracyM: 10,
      selfieAttachmentId: selfieRef.attachmentId,
      at: new Date().toISOString(),
    };

    await runtime.commitAttendanceCheckIn(attendanceId, payload, ACTOR);
    await runtime.commitAttendanceCheckIn(attendanceId, payload, ACTOR); // double-tap submit

    expect(await runtime.getOutboxDepth()).toBe(1);
  });
});
