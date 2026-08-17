/**
 * BE-TXN-ROLLBACK regression coverage for `node-gateway`'s request-scoped
 * mutating routes (`NodesController.mintPairingToken`/`update`/`unpair`/
 * `discovered/:id/confirm`/`discovered/:id/ignore`, and
 * `OutletNodeSettingController.setEnabled`) — before this ticket's fix, every
 * one of these ran its writes directly on `req.dbClient` with no
 * `BEGIN...COMMIT` of its own, so `RlsCleanupInterceptor`'s unconditional
 * post-request `ROLLBACK` silently discarded them.
 *
 * `asRequest` (`device-registry/test-support/live-db.ts`, reused here — one
 * harness, not a second copy) is what actually proves the fix: unlike
 * `kernel/sync/system-rls-context.ts`'s `withSystemContext` (which every
 * PRE-EXISTING live-DB test for these two controllers used, and which
 * COMMITS UNCONDITIONALLY regardless of whether the controller method under
 * test ever calls `withWrite`), `asRequest` opens its own connection, asserts
 * the session, runs the controller method, and ALWAYS `ROLLBACK`s — the real
 * `RlsContextGuard` + `RlsCleanupInterceptor` lifecycle. Only a controller
 * method that itself commits (via `withWrite`) survives it. Per that
 * harness's own rule: at most one mutating call per `asRequest` connection,
 * so every write-then-read-back assertion here is two separate connections.
 *
 * `register` (already fixed via `withSystemContext`) and `sendCommand`
 * (touches no database row) are NOT retested here.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { DeviceRegistryRepository } from '../device-registry/device-registry.repository';
import { PairingTokensService } from '../device-registry/pairing-tokens.service';
import {
  asRequest,
  cleanupNodesAndDevices,
  closeTestPool,
  deleteLocation,
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
const discovered = new DiscoveredDevicesRepository();
const eventsRepo = new SyncEventsRepository(pool);
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);

/** Only the two methods either controller actually calls on a real `BridgeGateway`. */
class FakeBridge {
  isConnected(_nodeId: string) { return false; }
  sendRevoked(_nodeId: string) { return true; }
  sendCommand() { return true; }
}

function reqAs(sub: string) {
  return { user: { sub, roleKey: 'owner', username: 'test', locationIds: [] } };
}

async function insertDiscoveredDevice(nodeId: string, ipAddress: string): Promise<string> {
  const res = await assertPool.query<{ id: string }>(
    `INSERT INTO discovered_devices (node_id, source, ip_address, mac_address, vendor, model, suggested_category, suggested_name, status, last_seen_at)
     VALUES ($1, 'mdns', $2, NULL, 'Test Vendor', 'Test Model', 'printer', 'Test Printer', 'new', NOW())
     RETURNING id`,
    [nodeId, ipAddress],
  );
  return res.rows[0]!.id;
}

describe('node-gateway — BE-TXN-ROLLBACK write-then-read-back (live database, separate connections)', () => {
  const createdNodeIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdPairingTokenIds: string[] = [];

  afterEach(async () => {
    await cleanupNodesAndDevices({ nodeIds: createdNodeIds, locationIds: createdLocationIds });
    if (createdPairingTokenIds.length > 0) {
      await assertPool.query(`DELETE FROM pairing_tokens WHERE id = ANY($1::uuid[])`, [createdPairingTokenIds]);
    }
    for (const id of createdLocationIds) await deleteLocation(id);
    createdNodeIds.length = 0;
    createdLocationIds.length = 0;
    createdPairingTokenIds.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  function buildNodesController(): NodesController {
    return new NodesController(
      branchNodes,
      new PairingTokensService(),
      discovered,
      deviceRegistry,
      new FakeBridge() as never,
      syncEmit,
      outletSetting,
      pool,
    );
  }

  function buildOutletSettingController(): OutletNodeSettingController {
    return new OutletNodeSettingController(outletSetting, branchNodes, deviceRegistry, new FakeBridge() as never, syncEmit, pool);
  }

  it('mintPairingToken persists — a later, separate connection finds the pairing_tokens row', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    await withSystemContext(pool, (client) => outletSetting.setEnabled(client, locationId, true));

    const controller = buildNodesController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const minted = await asRequest(ctx, (client) =>
      controller.mintPairingToken({ ...reqAs(ownerId), dbClient: client } as never, { locationId }),
    );
    expect(minted.token).toBeDefined();
    createdPairingTokenIds.push((minted as { tokenId: string }).tokenId);

    const row = await assertPool.query(`SELECT id FROM pairing_tokens WHERE id = $1`, [(minted as { tokenId: string }).tokenId]);
    expect(row.rows).toHaveLength(1);
  });

  it('update persists — a later, separate connection sees the new node name', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);

    const controller = buildNodesController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const updated = await asRequest(ctx, (client) =>
      controller.update({ ...reqAs(ownerId), dbClient: client } as never, node.id, { name: 'BE-TXN-ROLLBACK renamed node' }),
    );
    expect(updated?.name).toBe('BE-TXN-ROLLBACK renamed node');

    const row = await assertPool.query<{ name: string }>(`SELECT name FROM branch_nodes WHERE id = $1`, [node.id]);
    expect(row.rows[0]!.name).toBe('BE-TXN-ROLLBACK renamed node');
  });

  it('unpair persists — a later, separate connection sees status=unpaired and a cleared node_token_hash', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);

    const controller = buildNodesController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const unpaired = await asRequest(ctx, (client) =>
      controller.unpair({ ...reqAs(ownerId), dbClient: client } as never, node.id, { reason: 'test' }),
    );
    expect(unpaired?.status).toBe('unpaired');

    const row = await assertPool.query<{ status: string; node_token_hash: string | null }>(
      `SELECT status, node_token_hash FROM branch_nodes WHERE id = $1`,
      [node.id],
    );
    expect(row.rows[0]!.status).toBe('unpaired');
    expect(row.rows[0]!.node_token_hash).toBeNull();
  });

  it('discovered/:id/confirm persists — a later, separate connection sees the new devices row and the confirmed discovered_devices row', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const discoveredId = await insertDiscoveredDevice(node.id, `10.0.0.${randomBytes(1)[0]}`);

    const controller = buildNodesController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const created = await asRequest(ctx, (client) =>
      controller.confirmDiscovered({ ...reqAs(ownerId), dbClient: client } as never, discoveredId, { category: 'printer', name: 'Kitchen Printer' }),
    );
    expect(created).toBeDefined();
    const createdDeviceId = (created as { id: string }).id;

    const deviceRow = await assertPool.query(`SELECT id, name, node_id FROM devices WHERE id = $1`, [createdDeviceId]);
    expect(deviceRow.rows).toHaveLength(1);
    expect(deviceRow.rows[0].node_id).toBe(node.id);
    // Cleaned up by the shared `afterEach`'s `cleanupNodesAndDevices({ nodeIds: [node.id] })` — it
    // deletes `discovered_devices` (clearing the `confirmed_device_id` FK) BEFORE `devices` by
    // `node_id`, so this row (and the discovered row referencing it) is covered without a manual delete.

    const discoveredRow = await assertPool.query<{ status: string; confirmed_device_id: string }>(
      `SELECT status, confirmed_device_id FROM discovered_devices WHERE id = $1`,
      [discoveredId],
    );
    expect(discoveredRow.rows[0]!.status).toBe('confirmed');
    expect(discoveredRow.rows[0]!.confirmed_device_id).toBe(createdDeviceId);
  });

  it('discovered/:id/ignore persists — a later, separate connection sees status=ignored', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const discoveredId = await insertDiscoveredDevice(node.id, `10.0.1.${randomBytes(1)[0]}`);

    const controller = buildNodesController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const result = await asRequest(ctx, (client) =>
      controller.ignoreDiscovered({ ...reqAs(ownerId), dbClient: client } as never, discoveredId),
    );
    expect(result.ok).toBe(true);

    const row = await assertPool.query<{ status: string }>(`SELECT status FROM discovered_devices WHERE id = $1`, [discoveredId]);
    expect(row.rows[0]!.status).toBe('ignored');
  });

  it('OutletNodeSettingController.setEnabled(ON) persists — a later, separate connection sees nodeEnabled=true', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');

    const controller = buildOutletSettingController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const result = await asRequest(ctx, (client) =>
      controller.setEnabled({ ...reqAs(ownerId), dbClient: client } as never, locationId as never, { nodeEnabled: true }),
    );
    expect(result.nodeEnabled).toBe(true);

    const row = await assertPool.query<{ settings: { nodeEnabled?: boolean } }>(`SELECT settings FROM locations WHERE id = $1`, [locationId]);
    expect(row.rows[0]!.settings.nodeEnabled).toBe(true);
  });
});
