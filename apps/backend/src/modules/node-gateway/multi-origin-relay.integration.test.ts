/**
 * Live-database integration test for the multi-origin relay fix — BUILD-PLAN
 * §1's carried item: "kernel/sync currently accepts single-origin batches
 * only... node→cloud relay is broken until this is fixed." The production
 * fix lives in `kernel/sync/registry.repository.ts` (`findNodeByTokenHash`,
 * `findDeviceLocationForNode`) and `kernel/sync/sync.gateway.ts` (the
 * per-tier `onPush` branch) — a cross-boundary edit reported in full in the
 * W3-10 report, since the bug could not be fixed from inside this module
 * alone (a real branch node's `/sync` traffic is `kernel/sync`'s namespace
 * regardless of anything `node-gateway` does). This test lives here (inside
 * an owned directory) and exercises that fix exactly the way
 * `sync.gateway.ts`'s node branch does — authenticate the CONNECTION as one
 * node, authorize each EVENT independently by its own `originDeviceId`.
 *
 * Runs against the REAL `mimi-postgres` instance — real `devices`/
 * `branch_nodes` rows, real `sync_events` rows, no mocks on the DB path.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import { SyncOriginType } from '@mimi/shared';
import { formatUuidV7, type SyncEventEnvelope, type SyncPushBatch } from '@mimi/sync-protocol';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { OfflineCredentialsRepository } from '../../kernel/sync/offline-credentials.repository';
import { RegistryRepository } from '../../kernel/sync/registry.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { OfflineAuthService } from '../../kernel/sync/offline-auth.service';
import { ReconciliationService } from '../../kernel/sync/reconciliation.service';
import { SyncIngestService } from '../../kernel/sync/sync-ingest.service';
import { SyncProjectorRegistry } from '../../kernel/sync/sync-projector-registry.service';
import {
  cleanupOrigins,
  cleanupNodesAndDevices,
  closeTestPool,
  deleteLocation,
  fetchOneUserId,
  getAppPool,
  getOwnerPool,
  insertIsolatedOutletLocation,
  insertTestDeviceForNode,
  insertTestNode,
} from '../device-registry/test-support/live-db';

const fakeConfig = { get: (_key: string, def?: string) => def } as unknown as import('@nestjs/config').ConfigService;

const pool = getAppPool();
// Verification-only reads (asserting what the code-under-test committed) go through the OWNER pool,
// same reasoning as `kernel/sync/sync-ingest.integration.test.ts`'s own `assertPool`: `mimi_app`'s
// membership in `app_user` is `NOINHERIT`, so a bare app-pool query fails "permission denied" unless
// it is inside the engine's own `SET LOCAL ROLE app_user` transaction — which a test assertion isn't.
const assertPool = getOwnerPool();
const eventsRepo = new SyncEventsRepository(pool);
const conflictsRepo = new SyncConflictsRepository();
const registryRepo = new RegistryRepository(pool);
const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
const offlineAuth = new OfflineAuthService(new OfflineCredentialsRepository(), conflictsRepo, fakeConfig);
const reconciliation = new ReconciliationService(pool, eventsRepo, conflictsRepo, registryRepo);
const projectors = new SyncProjectorRegistry(); // empty registry — no Wave 3+ projector registered in this test process (matches kernel/sync's own sync-ingest.integration.test.ts)
const ingest = new SyncIngestService(eventsRepo, conflictDetector, offlineAuth, reconciliation, projectors);

function validAttendanceData(loc: string) {
  return { clientId: randomUUID(), locationId: loc, lat: '-1.240000', lng: '116.830000', accuracyM: 10, selfieAttachmentId: randomUUID() };
}

function mkEvent(originDeviceId: string, clientSeq: number, locationId: string, actorUserId: string): SyncEventEnvelope {
  return {
    eventId: formatUuidV7(Date.now() + clientSeq, randomBytes(16)),
    originTier: SyncOriginType.DEVICE,
    originDeviceId,
    locationId,
    entity: 'attendance',
    entityId: randomUUID(),
    op: 'checked_in',
    payload: { v: 1, data: validAttendanceData(locationId), meta: { actorUserId, actorRole: 'kasir', appVersion: '1.0.0' } },
    clientSeq: BigInt(clientSeq),
    occurredAt: new Date().toISOString(),
    actorUserId,
    schemaV: 1,
  };
}

function batchOf(events: SyncEventEnvelope[]): SyncPushBatch {
  return { batchId: randomUUID(), sentAt: new Date().toISOString(), events };
}

describe('Multi-origin relay — live database (node-token connection, per-event authorization)', () => {
  const createdNodeIds: string[] = [];
  const createdDeviceIds: string[] = [];
  // Every node this file creates gets its OWN throwaway location: `branch_nodes.location_id` is
  // UNIQUE (one node per location, CONTRACTS §1.12), and this suite's files run as CONCURRENT
  // vitest workers alongside `device-registry`'s own node tests — sharing a seeded outlet across
  // files racing to insert a node at the SAME location_id collides on that constraint. Cheaper fix
  // than serializing the whole run: isolate the location per test instead.
  const createdLocationIds: string[] = [];

  afterEach(async () => {
    await cleanupOrigins(createdDeviceIds);
    await cleanupNodesAndDevices({ nodeIds: createdNodeIds, deviceIds: createdDeviceIds, locationIds: createdLocationIds });
    for (const id of createdLocationIds) await deleteLocation(id);
    createdNodeIds.length = 0;
    createdDeviceIds.length = 0;
    createdLocationIds.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('RegistryRepository.findNodeByTokenHash resolves a real branch_nodes row by its token hash', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);

    const found = await registryRepo.findNodeByTokenHash(node.tokenHash);
    expect(found).toEqual({ id: node.id, locationId, status: 'online' });

    const notFound = await registryRepo.findNodeByTokenHash(randomBytes(24).toString('hex'));
    expect(notFound).toBeUndefined();
  });

  it("findDeviceLocationForNode resolves a device's location ONLY when it is actually registered to that node", async () => {
    const locationId = await insertIsolatedOutletLocation();
    const otherLocationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId, otherLocationId);
    const node = await insertTestNode(locationId);
    const otherNode = await insertTestNode(otherLocationId);
    createdNodeIds.push(node.id, otherNode.id);

    const ownDevice = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
    const foreignDevice = await insertTestDeviceForNode(otherLocationId, otherNode.id, randomBytes(16).toString('hex'));
    createdDeviceIds.push(ownDevice, foreignDevice);

    expect(await registryRepo.findDeviceLocationForNode(ownDevice, node.id)).toBe(locationId);
    // A device genuinely registered to a DIFFERENT node must resolve to `undefined` for THIS node —
    // this is the exact check that closes the relay hole: a node must never get a foreign device's
    // location trusted just because the node's OWN connection is authenticated.
    expect(await registryRepo.findDeviceLocationForNode(foreignDevice, node.id)).toBeUndefined();
    expect(await registryRepo.findDeviceLocationForNode(randomUUID(), node.id)).toBeUndefined();
  });

  it('a batch spanning TWO different origin devices relayed "by" one node applies both origins independently (the actual multi-origin fix)', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const actorUserId = await fetchOneUserId('kasir');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const deviceA = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
    const deviceB = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
    createdDeviceIds.push(deviceA, deviceB);

    // Exactly what `sync.gateway.ts`'s node branch builds: `(originDeviceId) =>
    // registry.findDeviceLocationForNode(originDeviceId, nodeId)` — no special-casing per event,
    // no trusting the node's own location for an event it didn't actually relay.
    const resolveLocation = (originDeviceId: string) => registryRepo.findDeviceLocationForNode(originDeviceId, node.id);

    const batch = batchOf([
      mkEvent(deviceA, 1, locationId, actorUserId),
      mkEvent(deviceB, 1, locationId, actorUserId),
    ]);

    const ack = await ingest.ingestBatch(batch, resolveLocation);

    expect(ack.rejected).toEqual([]);
    expect(ack.acceptedThrough[deviceA]).toBe(1);
    expect(ack.acceptedThrough[deviceB]).toBe(1);

    const rows = await assertPool.query<{ origin_device_id: string; apply_status: string }>(
      `SELECT origin_device_id, apply_status FROM sync_events WHERE origin_device_id = ANY($1::uuid[]) ORDER BY origin_device_id`,
      [[deviceA, deviceB]],
    );
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((r) => r.apply_status === 'applied')).toBe(true);
  });

  it('a batch claiming a device NOT registered to the relaying node is rejected as authority_violation, per-event (siblings still apply)', async () => {
    const locationId = await insertIsolatedOutletLocation();
    const otherLocationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId, otherLocationId);
    const actorUserId = await fetchOneUserId('kasir');
    const node = await insertTestNode(locationId);
    const foreignNode = await insertTestNode(otherLocationId);
    createdNodeIds.push(node.id, foreignNode.id);

    const ownDevice = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
    const foreignDevice = await insertTestDeviceForNode(otherLocationId, foreignNode.id, randomBytes(16).toString('hex'));
    createdDeviceIds.push(ownDevice, foreignDevice);

    const resolveLocation = (originDeviceId: string) => registryRepo.findDeviceLocationForNode(originDeviceId, node.id);

    const batch = batchOf([
      mkEvent(ownDevice, 1, locationId, actorUserId),
      mkEvent(foreignDevice, 1, otherLocationId, actorUserId), // claims a device this node does NOT relay
    ]);

    const ack = await ingest.ingestBatch(batch, resolveLocation);

    expect(ack.acceptedThrough[ownDevice]).toBe(1); // the legitimate sibling origin still applies
    expect(ack.rejected).toHaveLength(1);
    expect(ack.rejected[0]?.code).toBe('authority_violation');

    const foreignRows = await assertPool.query(`SELECT * FROM sync_events WHERE origin_device_id = $1`, [foreignDevice]);
    expect(foreignRows.rows).toHaveLength(0); // never stored — rejected before any insert (unresolved origin path)
  });
});
