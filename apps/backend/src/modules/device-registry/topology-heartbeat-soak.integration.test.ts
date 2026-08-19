/**
 * W6-06 "topology/heartbeat soak" (BUILD-PLAN.md: "30 simulated devices
 * flapping for 24h; alert precision (no false 'outlet offline' on a 20s
 * blip)") — live-database integration test, same harness pattern as
 * `staleness-sweep.integration.test.ts` and
 * `device-and-node-lifecycle.integration.test.ts`.
 *
 * A literal 24h wall-clock soak with real hardware is not something CI can
 * run, and this file does not pretend otherwise (see the report handed back
 * with this PR for what genuinely still needs one). What IS deterministic,
 * and therefore properly unit/integration-testable, is the state machine's
 * PRECISION: does a brief gap get misreported as an outage, does a real
 * outage get reported at all, and does repeated flapping produce repeated
 * (duplicate/oscillating) alerts instead of one clean edge each way. That is
 * exactly what `StalenessSweepService` implements (§7.3) and what this file
 * exercises against the REAL thresholds it defines — this file does not
 * invent thresholds, it imports the constants the sweep itself exports and
 * asserts behaviour AT those boundaries.
 *
 * Everything here runs against the real `mimi-postgres` instance, using
 * `insertIsolatedOutletLocation` (never a shared seeded location/device) so
 * this file can safely run alongside every other agent's work on the same
 * database, and cleans up everything it creates.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { DeviceRegistryRepository } from './device-registry.repository';
import {
  StalenessSweepService,
  DEVICE_STALE_AFTER_MS,
  DEVICE_OFFLINE_AFTER_MS,
  NODE_STALE_AFTER_MS,
  NODE_OFFLINE_AFTER_MS,
} from './staleness-sweep.service';
import { TopologyService } from './topology.service';
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
  getOwnerPool,
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
const topology = new TopologyService(pool);

const notifyCalls: unknown[] = [];
const fakeNotifications = {
  notify: async (req: unknown) => {
    notifyCalls.push(req);
    return { inApp: [], email: [], whatsapp: [] };
  },
} as unknown as NotificationService;

const topologyUpdates: unknown[] = [];
const fakeTopologyGateway = {
  emitUpdate: (p: unknown) => topologyUpdates.push(p),
} as unknown as TopologyGateway;

const sweep = new StalenessSweepService(
  pool,
  devicesRepo,
  syncEmit,
  fakeNotifications,
  fakeTopologyGateway,
);

/** Directly sets `last_seen_at` to "now" — stands in for a real heartbeat's bookkeeping effect on `last_seen_at`/status without going through the HTTP layer (that path is `device-and-node-lifecycle.integration.test.ts`'s own surface). Used here only to simulate a device/node "coming back" mid-flap. */
async function heartbeatNowDevice(deviceId: string): Promise<void> {
  await getOwnerPool().query(
    `UPDATE devices SET last_seen_at = NOW(), status = 'online' WHERE id = $1`,
    [deviceId],
  );
}
async function heartbeatNowNode(nodeId: string): Promise<void> {
  await getOwnerPool().query(
    `UPDATE branch_nodes SET last_seen_at = NOW(), status = 'online' WHERE id = $1`,
    [nodeId],
  );
}

/** Wraps a `PoolClient` to count `query()` invocations without altering behaviour — the scale test's only tool for proving `TopologyService.buildTree` issues a FIXED number of queries regardless of device count (no N+1 per device/outlet). */
function countingClient(client: PoolClient): { client: PoolClient; counter: { n: number } } {
  const counter = { n: 0 };
  const wrapped = new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (...args: unknown[]) => {
          counter.n += 1;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          return (target.query as any)(...args);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return { client: wrapped as PoolClient, counter };
}

describe('W6-06 topology/heartbeat soak — alert precision, live database', () => {
  const createdNodeIds: string[] = [];
  const createdDeviceIds: string[] = [];
  const createdLocationIds: string[] = [];

  afterEach(async () => {
    await cleanupNodesAndDevices({
      nodeIds: createdNodeIds,
      deviceIds: createdDeviceIds,
      locationIds: createdLocationIds,
    });
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

  describe('a 20s blip must not be reported as offline (or even stale)', () => {
    it('device: last_seen_at 20s in the past survives a sweep untouched — no status change, no device_events row', async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const deviceId = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      createdDeviceIds.push(deviceId);

      await backdateDeviceLastSeen(deviceId, 20); // a 20s blip — the exact scenario BUILD-PLAN W6-06 names

      await sweep.runSweep();

      expect(await readDeviceStatus(deviceId)).toBe('online');
      const events = await deviceEventsFor({ deviceId });
      expect(events).toHaveLength(0);
    });

    it('node: last_seen_at 20s in the past survives a sweep untouched', async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);

      await backdateNodeLastSeen(node.id, 20);

      await sweep.runSweep();

      expect(await readNodeStatus(node.id)).toBe('online');
      const events = await deviceEventsFor({ nodeId: node.id });
      expect(events).toHaveLength(0);
    });

    it('outlet-level: a whole outlet blipping dark for 20s never raises outlet_offline (the alert BUILD-PLAN calls out by name)', async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const deviceId = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      createdDeviceIds.push(deviceId);

      // Everything at this outlet — node AND its only device — blips dark together for 20s.
      await backdateNodeLastSeen(node.id, 20);
      await backdateDeviceLastSeen(deviceId, 20);

      await sweep.runSweep();

      const outletEvents = await deviceEventsFor({ locationId });
      expect(outletEvents.some((e) => e.type === 'outlet_offline')).toBe(false);
      expect(notifyCalls).toHaveLength(0);
    });
  });

  describe('sustained absence DOES flip status, at the exact boundary the code defines', () => {
    // Thresholds as read from staleness-sweep.service.ts (§7.3, this file's own single source of
    // truth — not invented here): device stale @180s/offline @600s, node stale @90s/offline @300s.
    it(`device: ${DEVICE_STALE_AFTER_MS / 1000}s is the stale boundary — just under stays online, just over flips to stale`, async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const under = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      const over = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      createdDeviceIds.push(under, over);

      await backdateDeviceLastSeen(under, DEVICE_STALE_AFTER_MS / 1000 - 1); // 179s
      await backdateDeviceLastSeen(over, DEVICE_STALE_AFTER_MS / 1000 + 1); // 181s

      await sweep.runSweep();

      expect(await readDeviceStatus(under)).toBe('online');
      expect(await readDeviceStatus(over)).toBe('stale');
    });

    it(`device: ${DEVICE_OFFLINE_AFTER_MS / 1000}s is the offline boundary — just under stays stale (not offline), just over flips to offline`, async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const under = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      const over = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      createdDeviceIds.push(under, over);

      await backdateDeviceLastSeen(under, DEVICE_OFFLINE_AFTER_MS / 1000 - 1); // 599s (past stale, not yet offline)
      await backdateDeviceLastSeen(over, DEVICE_OFFLINE_AFTER_MS / 1000 + 1); // 601s

      await sweep.runSweep();

      expect(await readDeviceStatus(under)).toBe('stale');
      expect(await readDeviceStatus(over)).toBe('offline');
    });

    it(`node: ${NODE_STALE_AFTER_MS / 1000}s is the stale boundary — just under stays online, just over flips to stale`, async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const nodeUnder = await insertTestNode(locationId);
      createdNodeIds.push(nodeUnder.id);
      await backdateNodeLastSeen(nodeUnder.id, NODE_STALE_AFTER_MS / 1000 - 1); // 89s

      await sweep.runSweep();
      expect(await readNodeStatus(nodeUnder.id)).toBe('online');

      await backdateNodeLastSeen(nodeUnder.id, NODE_STALE_AFTER_MS / 1000 + 1); // 91s
      await sweep.runSweep();
      expect(await readNodeStatus(nodeUnder.id)).toBe('stale');
    });

    it(`node: ${NODE_OFFLINE_AFTER_MS / 1000}s is the offline boundary — just under stays stale, just over flips to offline`, async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);

      await backdateNodeLastSeen(node.id, NODE_OFFLINE_AFTER_MS / 1000 - 1); // 299s
      await sweep.runSweep();
      expect(await readNodeStatus(node.id)).toBe('stale');

      await backdateNodeLastSeen(node.id, NODE_OFFLINE_AFTER_MS / 1000 + 1); // 301s
      await sweep.runSweep();
      expect(await readNodeStatus(node.id)).toBe('offline');
    });
  });

  describe('flapping (repeated up/down) does not oscillate alerts or duplicate state rows', () => {
    it('a device cycling online -> stale -> online -> offline -> online writes exactly one device_events row per real edge crossed, never one per sweep tick', async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const deviceId = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      createdDeviceIds.push(deviceId);

      // Cycle 1: dip into `stale`, then recover before `offline`.
      await backdateDeviceLastSeen(deviceId, 200); // > stale (180s), < offline (600s)
      await sweep.runSweep();
      await sweep.runSweep(); // re-run with nothing changed — must NOT duplicate the stale edge
      expect(await readDeviceStatus(deviceId)).toBe('stale');
      expect((await deviceEventsFor({ deviceId })).map((e) => e.type)).toEqual(['stale']);

      await heartbeatNowDevice(deviceId); // recovers — the heartbeat path, not the sweep, moves it back online
      expect(await readDeviceStatus(deviceId)).toBe('online');

      // Cycle 2: dip past `offline` this time.
      await backdateDeviceLastSeen(deviceId, 650);
      await sweep.runSweep();
      await sweep.runSweep(); // again: re-running with no change must not re-fire
      expect(await readDeviceStatus(deviceId)).toBe('offline');
      expect((await deviceEventsFor({ deviceId })).map((e) => e.type)).toEqual([
        'stale',
        'offline',
      ]);

      await heartbeatNowDevice(deviceId); // recovers again
      expect(await readDeviceStatus(deviceId)).toBe('online');
      await sweep.runSweep(); // fresh heartbeat, well within every threshold — must stay untouched
      expect(await readDeviceStatus(deviceId)).toBe('online');
      // Recovering to `online` never itself writes a device_events row (only the sweep's own
      // stale/offline transitions do, per `recordDeviceTransition`) — still exactly 2 rows total
      // across the whole flap, not one per tick and not one per recovery.
      expect((await deviceEventsFor({ deviceId })).map((e) => e.type)).toEqual([
        'stale',
        'offline',
      ]);
    });

    it('an outlet flapping in and out of "all offline" without ever staying dark past 10 minutes never raises outlet_offline, and once it does, recovery raises exactly one outlet_online (not one per tick)', async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const deviceId = await insertTestDeviceForNode(
        locationId,
        node.id,
        randomBytes(16).toString('hex'),
      );
      createdDeviceIds.push(deviceId);

      // Flap 1: whole outlet dark for a while, but well under the 10-minute outlet threshold.
      await backdateNodeLastSeen(node.id, 250);
      await backdateDeviceLastSeen(deviceId, 250);
      await sweep.runSweep();
      expect((await deviceEventsFor({ locationId })).some((e) => e.type === 'outlet_offline')).toBe(
        false,
      );

      await heartbeatNowNode(node.id);
      await heartbeatNowDevice(deviceId);
      await sweep.runSweep();

      // Flap 2: this time past the 10-minute outlet threshold for both node and device.
      await backdateNodeLastSeen(node.id, 650);
      await backdateDeviceLastSeen(deviceId, 650);
      await sweep.runSweep();
      await sweep.runSweep(); // idempotency: must not double-fire while still dark
      const afterOutage = await deviceEventsFor({ locationId });
      expect(afterOutage.filter((e) => e.type === 'outlet_offline')).toHaveLength(1);
      expect(notifyCalls).toHaveLength(1);

      // Recovery: both come back; the sweep must raise exactly one outlet_online edge, not one
      // per subsequent tick.
      await heartbeatNowNode(node.id);
      await heartbeatNowDevice(deviceId);
      await sweep.runSweep();
      await sweep.runSweep();
      await sweep.runSweep();
      const afterRecovery = await deviceEventsFor({ locationId });
      expect(afterRecovery.filter((e) => e.type === 'outlet_online')).toHaveLength(1);
      expect(afterRecovery.filter((e) => e.type === 'outlet_offline')).toHaveLength(1); // unchanged
    });
  });

  describe('scale: ~30 devices assembles into the topology tree without an N+1 query blowup', () => {
    it('a single outlet carrying 30 devices costs the SAME query count as one carrying a handful', async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);

      const deviceIds: string[] = [];
      for (let i = 0; i < 30; i++) {
        const id = await insertTestDeviceForNode(
          locationId,
          node.id,
          randomBytes(16).toString('hex'),
        );
        deviceIds.push(id);
      }
      createdDeviceIds.push(...deviceIds);

      const queryCount = await withSystemContext(pool, async (client) => {
        const { client: wrapped, counter } = countingClient(client);
        const tree = await topology.buildTree(wrapped);
        const outlet = tree.cities
          .flatMap((c) => c.outlets)
          .find((o) => o.location.id === locationId);
        expect(outlet).toBeDefined();
        expect(outlet!.devices).toHaveLength(30);
        expect(outlet!.counts.online).toBe(30);
        return counter.n;
      });

      // `TopologyService.loadRows` issues a fixed six queries (locations, branch_nodes, devices,
      // discovered_devices counts, sync_events quarantine counts, sync_conflicts counts) regardless
      // of how many locations/devices/nodes exist — everything downstream is in-memory grouping
      // (`groupBy`/`Map`), never a per-row or per-outlet round trip. 30 devices at one outlet must
      // cost exactly the same query count as 1 device would; an N+1 regression here would instead
      // scale with device/outlet count, which this asserts against directly rather than eyeballing
      // a query log.
      expect(queryCount).toBe(6);
    });
  });
});
