/**
 * Live-database integration test for BUILD-PLAN D-26 — the per-outlet
 * node-enabled setting and its drain-before-off guarantee. Exercises the
 * real `OutletNodeSettingController`/`OutletNodeSettingRepository`/
 * `BranchNodesRepository`/`DeviceRegistryRepository`/`SyncEmitService`
 * classes against the real `mimi-postgres` instance, same pattern as
 * `device-registry/device-and-node-lifecycle.integration.test.ts` (a full
 * Nest HTTP bootstrap is out of proportion — this proves the DATA PATH: the
 * setting toggling, the refusal while queued, and the successful drain).
 *
 * `BridgeGateway` is faked (`isConnected`/`sendRevoked` only) — this suite
 * is not about socket.io wiring, only about what the drain check DOES with
 * a connected/disconnected answer.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import {
  ERR_FORBIDDEN,
  ERR_NODE_QUEUE_PENDING,
  ERR_NODE_UNREACHABLE,
  ERR_VALIDATION,
} from '@mimi/shared';
import type { UUID } from '@mimi/shared';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { DeviceRegistryRepository } from '../device-registry/device-registry.repository';
import { PairingTokensService } from '../device-registry/pairing-tokens.service';
import {
  cleanupNodesAndDevices,
  closeTestPool,
  deleteLocation,
  deviceEventsFor,
  fetchOneUserId,
  getAppPool,
  getOwnerPool,
  insertIsolatedOutletLocation,
  insertTestNode,
} from '../device-registry/test-support/live-db';
import { BranchNodesRepository } from './branch-nodes.repository';
import { DiscoveredDevicesRepository } from './discovered-devices.repository';
import { NodesController } from './nodes.controller';
import { OutletNodeSettingController } from './outlet-node-setting.controller';
import { OutletNodeSettingRepository } from './outlet-node-setting.repository';

const pool = getAppPool();
const assertPool = getOwnerPool();

const branchNodes = new BranchNodesRepository();
const outletSetting = new OutletNodeSettingRepository();
const deviceRegistry = new DeviceRegistryRepository();
const eventsRepo = new SyncEventsRepository(pool);
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);

/** Only the two methods the controller actually calls on a real `BridgeGateway`. */
class FakeBridge {
  private readonly connected = new Set<UUID>();
  connect(nodeId: UUID) {
    this.connected.add(nodeId);
  }
  disconnect(nodeId: UUID) {
    this.connected.delete(nodeId);
  }
  isConnected(nodeId: UUID) {
    return this.connected.has(nodeId);
  }
  sendRevoked(nodeId: UUID) {
    this.connected.delete(nodeId);
    return true;
  }
}

function reqAs(roleKey: string, sub: string) {
  return { user: { sub, roleKey, username: 'test', locationIds: [] } } as unknown as Parameters<
    OutletNodeSettingController['setEnabled']
  >[0];
}

describe('Outlet node-enabled setting — drain-before-off (BUILD-PLAN D-26), live database', () => {
  const createdNodeIds: string[] = [];
  const createdLocationIds: string[] = [];

  afterEach(async () => {
    await cleanupNodesAndDevices({ nodeIds: createdNodeIds, locationIds: createdLocationIds });
    for (const id of createdLocationIds) await deleteLocation(id);
    createdNodeIds.length = 0;
    createdLocationIds.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('defaults OFF, is Owner-only to change, and turns ON as a plain flag with no node required yet', async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const managerId = await fetchOneUserId('manager');
    const bridge = new FakeBridge();
    const controller = new OutletNodeSettingController(
      outletSetting,
      branchNodes,
      deviceRegistry,
      bridge as never,
      syncEmit,
      pool,
    );

    const initial = await withSystemContext(pool, (client) =>
      controller.get({ dbClient: client } as never, locationId),
    );
    expect(initial.nodeEnabled).toBe(false);
    expect(initial.node).toBeNull();

    // Manager holds `node.manage` in the RBAC matrix (CONTRACTS §3) but D-26 requires Owner specifically.
    await expect(
      withSystemContext(pool, (client) =>
        controller.setEnabled(
          { ...reqAs('manager', managerId), dbClient: client } as never,
          locationId,
          { nodeEnabled: true },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_FORBIDDEN } });

    const afterManagerAttempt = await withSystemContext(pool, (client) =>
      controller.get({ dbClient: client } as never, locationId),
    );
    expect(afterManagerAttempt.nodeEnabled).toBe(false); // rejected attempt changed nothing

    const turnedOn = await withSystemContext(pool, (client) =>
      controller.setEnabled({ ...reqAs('owner', ownerId), dbClient: client } as never, locationId, {
        nodeEnabled: true,
      }),
    );
    expect(turnedOn.nodeEnabled).toBe(true);
    expect(turnedOn.node).toBeNull(); // ON is the flag alone — no PC has paired yet

    const row = await assertPool.query<{ settings: { nodeEnabled?: boolean } }>(
      `SELECT settings FROM locations WHERE id = $1`,
      [locationId],
    );
    expect(row.rows[0]!.settings.nodeEnabled).toBe(true);
  });

  it('turning OFF with a non-empty node queue is refused (ERR_NODE_QUEUE_PENDING), naming the count, and changes nothing', async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const bridge = new FakeBridge();
    const controller = new OutletNodeSettingController(
      outletSetting,
      branchNodes,
      deviceRegistry,
      bridge as never,
      syncEmit,
      pool,
    );

    await withSystemContext(pool, (client) => outletSetting.setEnabled(client, locationId, true));
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    bridge.connect(node.id);
    // A fresh heartbeat reporting 7 events still on this node's relay outbox.
    await withSystemContext(pool, (client) =>
      branchNodes.recordHeartbeat(client, node.id, { version: '1.0.0', relayQueueDepth: 7 }),
    );

    const req = { ...reqAs('owner', ownerId) } as never;
    await expect(
      withSystemContext(pool, (client) =>
        controller.setEnabled({ ...req, dbClient: client } as never, locationId, {
          nodeEnabled: false,
        }),
      ),
    ).rejects.toMatchObject({
      response: { code: ERR_NODE_QUEUE_PENDING, details: { pendingCount: 7 } },
    });

    // Refused — the node is untouched (still paired) and the setting is still ON.
    const nodeStatus = await assertPool.query<{ status: string }>(
      `SELECT status FROM branch_nodes WHERE id = $1`,
      [node.id],
    );
    expect(nodeStatus.rows[0]!.status).toBe('online');
    const setting = await withSystemContext(pool, (client) =>
      outletSetting.find(client, locationId),
    );
    expect(setting!.node_enabled).toBe(true);
  });

  it('an unreachable node with a possible backlog is refused (ERR_NODE_UNREACHABLE), never silently switched off', async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const bridge = new FakeBridge(); // deliberately never `.connect()`ed for this node
    const controller = new OutletNodeSettingController(
      outletSetting,
      branchNodes,
      deviceRegistry,
      bridge as never,
      syncEmit,
      pool,
    );

    await withSystemContext(pool, (client) => outletSetting.setEnabled(client, locationId, true));
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    // Even though its LAST reported reading was zero, the node is not connected right now — that
    // stale "was empty" fact cannot be trusted as "is empty now" (it may have accepted more LAN-device
    // events since disconnecting), so this must still refuse.
    await withSystemContext(pool, (client) =>
      branchNodes.recordHeartbeat(client, node.id, { version: '1.0.0', relayQueueDepth: 0 }),
    );

    await expect(
      withSystemContext(pool, (client) =>
        controller.setEnabled(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          locationId,
          { nodeEnabled: false },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_NODE_UNREACHABLE } });

    const nodeStatus = await assertPool.query<{ status: string }>(
      `SELECT status FROM branch_nodes WHERE id = $1`,
      [node.id],
    );
    expect(nodeStatus.rows[0]!.status).toBe('online'); // untouched
  });

  it('a node that has never reported a queue depth at all is also refused (unknown != drained)', async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const bridge = new FakeBridge();
    const controller = new OutletNodeSettingController(
      outletSetting,
      branchNodes,
      deviceRegistry,
      bridge as never,
      syncEmit,
      pool,
    );

    await withSystemContext(pool, (client) => outletSetting.setEnabled(client, locationId, true));
    const node = await insertTestNode(locationId); // fixture never calls recordHeartbeat — no relayQueueDepth ever set
    createdNodeIds.push(node.id);
    bridge.connect(node.id);

    await expect(
      withSystemContext(pool, (client) =>
        controller.setEnabled(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          locationId,
          { nodeEnabled: false },
        ),
      ),
    ).rejects.toMatchObject({
      response: { code: ERR_NODE_UNREACHABLE, details: { pendingCount: null } },
    });
  });

  it('a drained, reachable node lets OFF succeed: unpairs the node, falls devices back to cloud-direct, and flips the setting', async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const bridge = new FakeBridge();
    const controller = new OutletNodeSettingController(
      outletSetting,
      branchNodes,
      deviceRegistry,
      bridge as never,
      syncEmit,
      pool,
    );

    await withSystemContext(pool, (client) => outletSetting.setEnabled(client, locationId, true));
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    bridge.connect(node.id);
    await withSystemContext(pool, (client) =>
      branchNodes.recordHeartbeat(client, node.id, { version: '1.0.0', relayQueueDepth: 0 }),
    );

    const result = await withSystemContext(pool, (client) =>
      controller.setEnabled({ ...reqAs('owner', ownerId), dbClient: client } as never, locationId, {
        nodeEnabled: false,
      }),
    );
    expect(result.nodeEnabled).toBe(false);
    expect(result.node).toBeNull();

    const nodeRow = await assertPool.query<{ status: string; node_token_hash: string | null }>(
      `SELECT status, node_token_hash FROM branch_nodes WHERE id = $1`,
      [node.id],
    );
    expect(nodeRow.rows[0]!.status).toBe('unpaired');
    expect(nodeRow.rows[0]!.node_token_hash).toBeNull(); // kill switch — credential revoked
    expect(bridge.isConnected(node.id)).toBe(false); // sendRevoked disconnected it

    const events = await deviceEventsFor({ nodeId: node.id });
    expect(events.some((e) => e.type === 'unpaired')).toBe(true);

    const syncRow = await assertPool.query<{ payload: { data: { reason: string } } }>(
      `SELECT payload FROM sync_events WHERE entity = 'branch_nodes' AND op = 'revoked' AND entity_id = $1`,
      [node.id],
    );
    expect(syncRow.rows).toHaveLength(1);
    expect(syncRow.rows[0]!.payload.data.reason).toBe('node_disabled_by_owner');
  });

  it('turning OFF when no node was ever paired is a trivial no-op (nothing to drain)', async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const bridge = new FakeBridge();
    const controller = new OutletNodeSettingController(
      outletSetting,
      branchNodes,
      deviceRegistry,
      bridge as never,
      syncEmit,
      pool,
    );

    await withSystemContext(pool, (client) => outletSetting.setEnabled(client, locationId, true));

    const result = await withSystemContext(pool, (client) =>
      controller.setEnabled({ ...reqAs('owner', ownerId), dbClient: client } as never, locationId, {
        nodeEnabled: false,
      }),
    );
    expect(result.nodeEnabled).toBe(false);
  });

  it('rejects a non-boolean body', async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const bridge = new FakeBridge();
    const controller = new OutletNodeSettingController(
      outletSetting,
      branchNodes,
      deviceRegistry,
      bridge as never,
      syncEmit,
      pool,
    );

    await expect(
      withSystemContext(pool, (client) =>
        controller.setEnabled(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          locationId,
          { nodeEnabled: 'yes' as never },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });
  });

  it("wizard support: POST /api/nodes/pairing-tokens is refused while the outlet's nodeEnabled setting is OFF, and allowed once ON", async () => {
    const locationId = (await insertIsolatedOutletLocation()) as UUID;
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const bridge = new FakeBridge();
    const nodesController = new NodesController(
      branchNodes,
      new PairingTokensService(),
      new DiscoveredDevicesRepository(),
      deviceRegistry,
      bridge as never,
      syncEmit,
      outletSetting,
      new ConfigService(),
      pool,
    );

    await expect(
      withSystemContext(pool, (client) =>
        nodesController.mintPairingToken(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          { locationId },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });

    await withSystemContext(pool, (client) => outletSetting.setEnabled(client, locationId, true));

    const minted = await withSystemContext(pool, (client) =>
      nodesController.mintPairingToken({ ...reqAs('owner', ownerId), dbClient: client } as never, {
        locationId,
      }),
    );
    expect(minted.token).toBeDefined();
    expect(minted.qrPayload).toContain('node');
  });
});
