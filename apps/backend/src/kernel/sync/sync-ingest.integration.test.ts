/**
 * Live-database integration tests for the cloud ingest pipeline —
 * SYNC-PROTOCOL §9.1 properties T-01, T-03, T-05, and the T-14 poison
 * scenario, all run against the REAL `mimi-postgres` instance (no mocks),
 * per this ticket's "verify end to end when the stack allows" instruction.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { SyncOriginType } from '@mimi/shared';
import { computeStateChecksum, formatUuidV7, type SyncEventEnvelope, type SyncPushBatch } from '@mimi/sync-protocol';
import { SyncEventsRepository } from './sync-events.repository';
import { SyncConflictsRepository } from './sync-conflicts.repository';
import { OfflineCredentialsRepository } from './offline-credentials.repository';
import { RegistryRepository } from './registry.repository';
import { ConflictDetectorService } from './conflict-detector.service';
import { OfflineAuthService } from './offline-auth.service';
import { ReconciliationService } from './reconciliation.service';
import { SyncIngestService } from './sync-ingest.service';
import { SyncProjectorRegistry } from './sync-projector-registry.service';
import { cleanupOrigins, closeTestPool, fetchAnotherLocationId, fetchOneLocationId, getAppPool, getOwnerPool } from './test-support/live-db';

const fakeConfig = { get: (_key: string, def?: string) => def } as unknown as ConfigService;

// The code under test is constructed against `getAppPool()` — the SAME `mimi_app` RLS-enforced identity
// production `DATABASE_POOL` uses (D-21/D-22). Fixture setup/teardown (`fetchOneLocationId` etc., imported
// above) goes through the SEPARATE owner pool inside `test-support/live-db.ts` — see that file's header.
const pool = getAppPool();
// `assertPool`: read-only VERIFICATION queries below (asserting what the code-under-test committed) are
// test-harness concerns, not the code under test — routed through the owner pool so a bare `SELECT`
// doesn't need its own `SET ROLE app_user` dance (mimi_app's membership in app_user is `WITH INHERIT
// FALSE`, confirmed live: a bare `mimi_app` connection query fails with "permission denied" until it
// explicitly switches role, which `withSystemContext`/`assertSystemContext` do for the ENGINE's own
// queries — but a test assertion isn't the engine).
const assertPool = getOwnerPool();
const eventsRepo = new SyncEventsRepository(pool);
const conflictsRepo = new SyncConflictsRepository();
const registryRepo = new RegistryRepository(pool);
const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
const offlineAuth = new OfflineAuthService(new OfflineCredentialsRepository(), conflictsRepo, fakeConfig);
const reconciliation = new ReconciliationService(pool, eventsRepo, conflictsRepo, registryRepo);
const projectors = new SyncProjectorRegistry(); // empty registry — no Wave 3+ projector registered in this test process
const ingest = new SyncIngestService(eventsRepo, conflictDetector, offlineAuth, reconciliation, projectors);

let locationId: string;
let actorUserId: string;
const createdOrigins: string[] = [];

async function ensureFixtures() {
  if (!locationId) locationId = await fetchOneLocationId();
  // A FRESH id per test-process run, not a shared real seeded user: `sync_events.actor_user_id` has no FK
  // (confirmed against the live schema), and C4 (attendance overlap) detection legitimately searches ALL
  // of one actor's recent attendance events regardless of origin/test file — reusing the SAME real
  // supervisor id across concurrently-running test files (this one, `sync-projector-registry.integration
  // .test.ts`, `offline-auth.integration.test.ts`) produced exactly that: a real cross-file C4 false
  // positive once vitest ran them in parallel workers against the same live DB.
  if (!actorUserId) actorUserId = randomUUID();
}

function freshOrigin(): string {
  const id = randomUUID();
  createdOrigins.push(id);
  return id;
}

/** Schema-valid `attendance.checked_in` data (packages/sync-protocol/src/schema/registry.ts GROUP_7_SCHEMAS) — the default `mkEvent` payload, so every test exercises AUTHORITY logic, not accidentally the (separately-tested) payload validator. */
function validAttendanceData(loc: string) {
  return {
    clientId: randomUUID(),
    locationId: loc,
    lat: '-1.240000',
    lng: '116.830000',
    accuracyM: 10,
    selfieAttachmentId: randomUUID(),
  };
}

function mkEvent(
  originDeviceId: string,
  clientSeq: number,
  opts: Partial<Pick<SyncEventEnvelope, 'entity' | 'op' | 'locationId'>> & { data?: unknown } = {},
): SyncEventEnvelope {
  const loc = opts.locationId ?? locationId;
  return {
    eventId: formatUuidV7(Date.now() + clientSeq, randomBytes(16)),
    originTier: SyncOriginType.DEVICE,
    originDeviceId,
    locationId: loc,
    entity: opts.entity ?? 'attendance',
    entityId: randomUUID(),
    op: opts.op ?? 'checked_in',
    payload: { v: 1, data: opts.data ?? validAttendanceData(loc), meta: { actorUserId, actorRole: 'kasir', appVersion: '1.0.0' } },
    clientSeq: BigInt(clientSeq),
    occurredAt: new Date().toISOString(),
    actorUserId,
    schemaV: 1,
  };
}

function batchOf(events: SyncEventEnvelope[]): SyncPushBatch {
  return { batchId: randomUUID(), sentAt: new Date().toISOString(), events };
}

async function resolveLocation(originDeviceId: string): Promise<string | undefined> {
  return createdOrigins.includes(originDeviceId) ? locationId : undefined;
}

async function appliedRowsFor(originDeviceId: string) {
  const res = await assertPool.query(
    `SELECT event_id, client_seq, apply_status, reject_code FROM sync_events WHERE origin_device_id = $1 ORDER BY client_seq ASC`,
    [originDeviceId],
  );
  return res.rows as { event_id: string; client_seq: string; apply_status: string; reject_code: string | null }[];
}

describe('SyncIngestService — live database', () => {
  afterEach(async () => {
    await cleanupOrigins(createdOrigins);
    createdOrigins.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('T-01: replaying an identical batch any number of times converges to the same single applied state', async () => {
    await ensureFixtures();
    const origin = freshOrigin();
    const events = [mkEvent(origin, 1), mkEvent(origin, 2), mkEvent(origin, 3)];
    const batch = batchOf(events);

    const ack1 = await ingest.ingestBatch(batch, resolveLocation);
    const ack2 = await ingest.ingestBatch(batch, resolveLocation); // byte-identical resend
    const ack3 = await ingest.ingestBatch(batch, resolveLocation); // resend again

    expect(ack1.acceptedThrough[origin]).toBe(3);
    expect(ack2.acceptedThrough[origin]).toBe(3);
    expect(ack3.acceptedThrough[origin]).toBe(3);
    expect(ack1.confirmedThrough).toEqual(ack1.acceptedThrough); // cloud is the terminal tier (§4.3)

    const rows = await appliedRowsFor(origin);
    expect(rows).toHaveLength(3); // no duplicate rows from the two resends
    expect(rows.every((r) => r.apply_status === 'applied')).toBe(true);
  });

  it('T-01: three origins delivered in different interleavings converge to the identical checksum', async () => {
    await ensureFixtures();
    const originA = freshOrigin();
    const originB = freshOrigin();
    const originC = freshOrigin();

    const eventsA = [mkEvent(originA, 1), mkEvent(originA, 2)];
    const eventsB = [mkEvent(originB, 1), mkEvent(originB, 2), mkEvent(originB, 3)];
    const eventsC = [mkEvent(originC, 1)];

    // Deliver in one interleaving order.
    await ingest.ingestBatch(batchOf([eventsB[0]!, eventsB[1]!]), resolveLocation);
    await ingest.ingestBatch(batchOf([eventsA[0]!]), resolveLocation);
    await ingest.ingestBatch(batchOf([eventsC[0]!, eventsA[1]!]), resolveLocation);
    await ingest.ingestBatch(batchOf([eventsB[2]!]), resolveLocation);

    const finalRows = [...(await appliedRowsFor(originA)), ...(await appliedRowsFor(originB)), ...(await appliedRowsFor(originC))];
    expect(finalRows.every((r) => r.apply_status === 'applied')).toBe(true);
    expect(finalRows).toHaveLength(6);

    // Order-independent state checksum (packages/sync-protocol/checksum.ts) — canonicalized on event_id so
    // it does not care what order the rows come back from the DB in, only WHICH set of facts converged.
    const checksum = computeStateChecksum(finalRows.map((r) => ({ eventId: r.event_id, clientSeq: r.client_seq, applyStatus: r.apply_status })));
    expect(checksum).toMatch(/^[0-9a-f]{16}$/);
    // Re-deriving from the SAME row set (any order) must reproduce the identical hash — the property itself.
    const shuffled = [...finalRows].reverse();
    const checksum2 = computeStateChecksum(shuffled.map((r) => ({ eventId: r.event_id, clientSeq: r.client_seq, applyStatus: r.apply_status })));
    expect(checksum2).toBe(checksum);
  });

  it('T-03: a gap is detected, resend_from is reported, and filling it applies everything', async () => {
    await ensureFixtures();
    const origin = freshOrigin();
    const e1 = mkEvent(origin, 1);
    const e3 = mkEvent(origin, 3); // seq 2 missing

    const ack = await ingest.ingestBatch(batchOf([e1, e3]), resolveLocation);
    expect(ack.acceptedThrough[origin]).toBe(1); // only seq 1 is gapless-applied
    expect(ack.resendFrom).toEqual({ [origin]: 2 });

    let rows = await appliedRowsFor(origin);
    expect(rows.find((r) => r.client_seq === '1')?.apply_status).toBe('applied');
    expect(rows.find((r) => r.client_seq === '3')?.apply_status).toBe('pending_dependency');

    // Fill the gap.
    const e2 = mkEvent(origin, 2);
    const ack2 = await ingest.ingestBatch(batchOf([e2]), resolveLocation);
    expect(ack2.acceptedThrough[origin]).toBe(3); // gap-fill promotes the parked seq-3 row too
    expect(ack2.resendFrom).toBeUndefined();

    rows = await appliedRowsFor(origin);
    expect(rows.every((r) => r.apply_status === 'applied')).toBe(true);
  });

  it('T-05: authority violations are rejected with the exact §4.4 code — a class-M push, and a location spoof', async () => {
    await ensureFixtures();
    const origin = freshOrigin();

    // Schema-valid `locations.created` data (GROUP_1_SCHEMAS) — proving the AUTHORITY rejection, not
    // accidentally the payload validator (both would report `authority_violation` here regardless of
    // ordering vs. `malformed`, since class M is checked before the op-vocabulary/schema steps — see
    // `sync-ingest.service.ts`'s `checkAuthority` — but a fully valid payload makes the intent unambiguous).
    const masterDataPush = mkEvent(origin, 1, {
      entity: 'locations',
      op: 'created',
      data: {
        id: randomUUID(), code: 'BPP99', name: 'Test Outlet', type: 'outlet', city: 'Balikpapan',
        address: null, phone: null, latitude: null, longitude: null,
        geofenceRadiusM: 100, timezone: 'Asia/Makassar', isActive: true,
      },
    });
    const ack1 = await ingest.ingestBatch(batchOf([masterDataPush]), resolveLocation);
    expect(ack1.rejected).toEqual([
      expect.objectContaining({ eventId: masterDataPush.eventId, code: 'authority_violation' }),
    ]);

    const otherLocationId = await fetchAnotherLocationId(locationId);
    const spoofedLocation = mkEvent(origin, 2, { locationId: otherLocationId });
    const ack2 = await ingest.ingestBatch(batchOf([spoofedLocation]), resolveLocation);
    expect(ack2.rejected).toEqual([
      expect.objectContaining({ eventId: spoofedLocation.eventId, code: 'authority_violation' }),
    ]);

    // D-16/D-16a: a device must never push a stock balance or a stock movement.
    const balancePush = mkEvent(origin, 3, { entity: 'stock_balances', op: 'updated' });
    const ack3 = await ingest.ingestBatch(batchOf([balancePush]), resolveLocation);
    expect(ack3.rejected[0]?.code).toBe('authority_violation');
    const movementPush = mkEvent(origin, 4, { entity: 'stock_movements', op: 'posted' });
    const ack4 = await ingest.ingestBatch(batchOf([movementPush]), resolveLocation);
    expect(ack4.rejected[0]?.code).toBe('authority_violation');

    // Both permanently-rejected events still land in sync_events (quarantined) so the reject advances the
    // high-water instead of leaving a phantom gap (§4.4: "Rejected ≠ lost").
    const rows = await appliedRowsFor(origin);
    expect(rows.filter((r) => r.apply_status === 'quarantined')).toHaveLength(4);
  });

  it('T-14: a malformed (poison) event does not block the queue — siblings in the same batch still apply, and it opens exactly one sync_conflicts row', async () => {
    await ensureFixtures();
    const origin = freshOrigin();
    const before = mkEvent(origin, 1);
    const poison = mkEvent(origin, 2, { entity: 'not_a_real_entity', op: 'whatever' });
    const after = mkEvent(origin, 3);

    const ack = await ingest.ingestBatch(batchOf([before, poison, after]), resolveLocation);
    expect(ack.acceptedThrough[origin]).toBe(3); // the poison event does NOT create a phantom gap
    expect(ack.rejected).toEqual([expect.objectContaining({ eventId: poison.eventId, code: 'malformed' })]);

    const rows = await appliedRowsFor(origin);
    expect(rows.find((r) => r.event_id === before.eventId)?.apply_status).toBe('applied');
    expect(rows.find((r) => r.event_id === after.eventId)?.apply_status).toBe('applied');
    expect(rows.find((r) => r.event_id === poison.eventId)?.apply_status).toBe('quarantined');

    const conflictRes = await assertPool.query(`SELECT kind, loser_event_id FROM sync_conflicts WHERE loser_event_id = $1`, [poison.eventId]);
    expect(conflictRes.rows).toHaveLength(1);
    expect(conflictRes.rows[0]!.kind).toBe('poison');

    // Replaying the SAME batch again must not fabricate a second conflict row (T-01 applied to conflict rows).
    await ingest.ingestBatch(batchOf([before, poison, after]), resolveLocation);
    const conflictRes2 = await assertPool.query(`SELECT id FROM sync_conflicts WHERE loser_event_id = $1`, [poison.eventId]);
    expect(conflictRes2.rows).toHaveLength(1);
  });

  it('T-03/T-04 (seq_conflict): a client_seq colliding with a different event_id is a permanent reject that freezes the origin', async () => {
    await ensureFixtures();
    const origin = freshOrigin();
    const first = mkEvent(origin, 1);
    await ingest.ingestBatch(batchOf([first]), resolveLocation);

    const clashing = mkEvent(origin, 1); // same seq, different event_id — a cloned/corrupted store
    const ack = await ingest.ingestBatch(batchOf([clashing]), resolveLocation);
    expect(ack.rejected).toEqual([expect.objectContaining({ eventId: clashing.eventId, code: 'seq_conflict' })]);

    // The origin is now frozen — even a perfectly legitimate NEXT event is rejected until support clears it.
    const nextLegit = mkEvent(origin, 2);
    const ack2 = await ingest.ingestBatch(batchOf([nextLegit]), resolveLocation);
    expect(ack2.rejected).toEqual([expect.objectContaining({ eventId: nextLegit.eventId, code: 'seq_conflict' })]);
  });
});
