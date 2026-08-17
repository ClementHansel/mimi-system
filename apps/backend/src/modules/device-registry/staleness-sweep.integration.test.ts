/**
 * Live-database integration test for the D-13 staleness sweep — CONTRACTS.md
 * §7.3, and the Wave 3 gate item this ticket names explicitly: "G2 could not
 * test that a node's disappearance flips its devices offline within the
 * staleness window, because the sweep lives in your module. That test is
 * now a Wave 3 gate condition."
 *
 * Runs against the REAL `mimi-postgres` instance (two-pool pattern, see
 * `test-support/live-db.ts` and `kernel/sync/test-support/live-db.ts`'s own
 * header for why) — no mocks on the DB path. `NotificationService` and
 * `TopologyGateway` are stubbed (their own real-delivery mechanics —
 * SMTP/WA/socket.io — are W2-C's/this file's OWN unit surface elsewhere,
 * not what this test is verifying); every `devices`/`branch_nodes`/
 * `device_events`/`sync_events` row this test asserts on is real.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { DeviceRegistryRepository } from './device-registry.repository';
import { StalenessSweepService } from './staleness-sweep.service';
import type { NotificationService } from '../../kernel/notification/notification.service';
import type { TopologyGateway } from './topology.gateway';
import {
  backdateDeviceLastSeen,
  backdateNodeLastSeen,
  cleanupNodesAndDevices,
  closeTestPool,
  deleteLocation,
  deviceEventsFor,
  getAppPool,
  insertIsolatedOutletLocation,
  insertTestDeviceForNode,
  insertTestNode,
  readDeviceStatus,
  readNodeStatus,
} from './test-support/live-db';

const pool = getAppPool();
const eventsRepo = new SyncEventsRepository(pool);
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);
const devicesRepo = new DeviceRegistryRepository();

const notifyCalls: unknown[] = [];
const fakeNotifications = { notify: async (req: unknown) => { notifyCalls.push(req); return { inApp: [], email: [], whatsapp: [] }; } } as unknown as NotificationService;

const topologyUpdates: unknown[] = [];
const fakeTopologyGateway = { emitUpdate: (p: unknown) => topologyUpdates.push(p) } as unknown as TopologyGateway;

const sweep = new StalenessSweepService(pool, devicesRepo, syncEmit, fakeNotifications, fakeTopologyGateway);

describe('StalenessSweepService — live database (Wave 3 gate item)', () => {
  const createdNodeIds: string[] = [];
  const createdDeviceIds: string[] = [];
  // Every test that inserts a `branch_nodes` row uses ITS OWN throwaway location, never a shared
  // seeded one: `branch_nodes.location_id` is UNIQUE (one node per location, CONTRACTS §1.12), and
  // this suite's files run as CONCURRENT vitest workers — two tests racing to insert a node at the
  // SAME seeded outlet collide on that constraint. This is the exact "shared-database test
  // interference" class BUILD-PLAN §5's Wave 2 gate note documents; the fix there was a serial
  // re-run, the fix here (cheaper, no coordination needed) is per-test location isolation.
  const createdLocationIds: string[] = [];

  afterEach(async () => {
    await cleanupNodesAndDevices({ nodeIds: createdNodeIds, deviceIds: createdDeviceIds, locationIds: createdLocationIds });
    for (const id of createdLocationIds) await deleteLocation(id);
    createdNodeIds.length = 0;
    createdDeviceIds.length = 0;
    createdLocationIds.length = 0;
    notifyCalls.length = 0;
    topologyUpdates.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('a node past its 300s offline threshold flips to offline and raises device_events + topology:update', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    await backdateNodeLastSeen(node.id, 301);

    expect(await readNodeStatus(node.id)).toBe('online'); // pre-condition: still marked online until the sweep runs

    await sweep.runSweep();

    expect(await readNodeStatus(node.id)).toBe('offline');
    const events = await deviceEventsFor({ nodeId: node.id });
    expect(events.map((e) => e.type)).toContain('offline');
    expect(topologyUpdates).toContainEqual(expect.objectContaining({ nodeId: node.id, status: 'offline' }));
  });

  it('a node past its 90s stale threshold (but not yet 300s) flips to stale, not offline', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    await backdateNodeLastSeen(node.id, 120);

    await sweep.runSweep();

    expect(await readNodeStatus(node.id)).toBe('stale');
  });

  it("a device past its 600s offline threshold flips to offline, independent of its node's own status", async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const deviceId = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
    createdDeviceIds.push(deviceId);
    await backdateDeviceLastSeen(deviceId, 601);

    await sweep.runSweep();

    expect(await readDeviceStatus(deviceId)).toBe('offline');
    const events = await deviceEventsFor({ deviceId });
    expect(events.map((e) => e.type)).toContain('offline');
  });

  it(
    'THE GATE SCENARIO: a paired node AND its devices disappearing together (total outage, not just a node failover) ' +
      'flips both the node and every one of its devices offline within their respective staleness windows, and raises the outlet_offline alert',
    async () => {
      // An ISOLATED location (not one of W1-C's seeded outlets, which already carry their own
      // devices from seed data) — the outlet-level rule below asserts "ALL devices/node at this
      // location," which must mean only the ones THIS test created, not whatever else the shared
      // dev database happens to hold.
      const locationId = await insertIsolatedOutletLocation();
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const deviceA = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
      const deviceB = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
      createdDeviceIds.push(deviceA, deviceB);

      try {
        // Everything was alive a moment ago (simulating "paired, heartbeated, appeared in the
        // topology tree" — the state the coordinator's report asks this test to start from)...
        expect(await readNodeStatus(node.id)).toBe('online');
        expect(await readDeviceStatus(deviceA)).toBe('online');
        expect(await readDeviceStatus(deviceB)).toBe('online');

        // ...then everything goes dark past every relevant threshold at once: node past its OWN
        // 300s threshold, both devices past their OWN 600s threshold, AND the MOST RECENTLY seen
        // of the three (the node, since node.last_seen_at > device.last_seen_at below) past the
        // outlet-level "> 10 min" (600s) derived rule too — the outlet rule anchors on the latest
        // sighting across the whole location, not on each entity's own threshold.
        await backdateNodeLastSeen(node.id, 650);
        await backdateDeviceLastSeen(deviceA, 700);
        await backdateDeviceLastSeen(deviceB, 700);

        await sweep.runSweep();

        expect(await readNodeStatus(node.id)).toBe('offline');
        expect(await readDeviceStatus(deviceA)).toBe('offline');
        expect(await readDeviceStatus(deviceB)).toBe('offline');

        const nodeEvents = await deviceEventsFor({ nodeId: node.id });
        expect(nodeEvents.map((e) => e.type)).toContain('offline');
        const deviceAEvents = await deviceEventsFor({ deviceId: deviceA });
        expect(deviceAEvents.map((e) => e.type)).toContain('offline');
        const deviceBEvents = await deviceEventsFor({ deviceId: deviceB });
        expect(deviceBEvents.map((e) => e.type)).toContain('offline');

        // The outlet-level derived rule (§7.3: ALL devices AND node offline > 10 min) — this
        // isolated location's OWN outlet_offline edge, guarded to fire once per edge.
        const outletEvents = await deviceEventsFor({ locationId });
        expect(outletEvents.some((e) => e.type === 'outlet_offline')).toBe(true);
        expect(notifyCalls.length).toBeGreaterThan(0);

        // Running the sweep again must NOT re-fire the same edges (§7.3: "never repeats, only edges").
        const beforeSecondRun = (await deviceEventsFor({ nodeId: node.id })).length;
        await sweep.runSweep();
        const afterSecondRun = (await deviceEventsFor({ nodeId: node.id })).length;
        expect(afterSecondRun).toBe(beforeSecondRun);
      } finally {
        // Node/device rows are cleaned by the shared `afterEach` (they're already pushed onto
        // `createdNodeIds`/`createdDeviceIds` above); only this test's own throwaway LOCATION needs
        // its own teardown, and it must run after that cleanup (FK: device_events/pairing_tokens
        // reference it) — hence deleting it in a follow-up `afterEach`-adjacent step here via a
        // direct, ordered cleanup rather than relying on ordering between two separate hooks.
        await cleanupNodesAndDevices({ nodeIds: [node.id], deviceIds: [deviceA, deviceB], locationIds: [locationId] });
        createdNodeIds.length = 0;
        createdDeviceIds.length = 0;
        await deleteLocation(locationId);
      }
    },
  );

  it('recovery: a device heartbeat arriving after it was marked offline is detected as a distinct concern from the sweep (sweep never moves a row back online)', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const deviceId = await insertTestDeviceForNode(locationId, node.id, randomBytes(16).toString('hex'));
    createdDeviceIds.push(deviceId);
    await backdateDeviceLastSeen(deviceId, 700);

    await sweep.runSweep();
    expect(await readDeviceStatus(deviceId)).toBe('offline');

    // The sweep alone never resurrects anything — recovery is the heartbeat handler's job
    // (`DevicesController.heartbeat`/`BridgeGateway.onHeartbeat`), tested separately.
    await sweep.runSweep();
    expect(await readDeviceStatus(deviceId)).toBe('offline');
  });
});
