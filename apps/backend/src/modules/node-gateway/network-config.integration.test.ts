/**
 * Live-database integration coverage for `PUT /api/nodes/:id/network-config`
 * (W3-10 hardening — the real remote write path a previous agent correctly
 * found missing) and the `restart`/`update` open-POS-shift gate on
 * `POST /api/nodes/:id/command`.
 *
 * Same harness discipline as `be-txn-rollback.integration.test.ts`:
 * `asRequest` (own connection, always ROLLBACKs unless the controller
 * itself commits via `withWrite`) is what actually proves a write persists,
 * not `withSystemContext`'s unconditional commit.
 *
 * Covers exactly the two safety properties the ticket names as
 * non-negotiable:
 *   - a malformed config (bad static IP, a reserved-port collision) is
 *     rejected by the API and never reaches the database or the node;
 *   - a WiFi passphrase is encrypted at rest, never echoed back through any
 *     response, and never lands in the `branch_nodes.config_updated` sync
 *     event this same write emits.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { UUID } from '@mimi/shared';
import { ERR_NODE_UNREACHABLE, ERR_NODE_SHIFT_OPEN, ERR_VALIDATION } from '@mimi/shared';
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
import { OutletNodeSettingRepository } from './outlet-node-setting.repository';
import { NodesController } from './nodes.controller';
import { decryptWifiPassphrase, networkSecretEncKeyFromConfig } from './network-config-crypto';

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
const configService = new ConfigService();

/** Only what `NodesController.setNetworkConfig`/`sendCommand` actually calls on a real `BridgeGateway`. */
class FakeBridge {
  private readonly connected = new Set<UUID>();
  public sentNetworkConfigs: { nodeId: UUID; payload: unknown }[] = [];
  public sentCommands: { nodeId: UUID; command: unknown }[] = [];

  connect(nodeId: UUID) {
    this.connected.add(nodeId);
  }
  isConnected(nodeId: UUID) {
    return this.connected.has(nodeId);
  }
  sendNetworkConfig(nodeId: UUID, payload: unknown) {
    this.sentNetworkConfigs.push({ nodeId, payload });
    return this.connected.has(nodeId);
  }
  sendCommand(nodeId: UUID, command: unknown) {
    this.sentCommands.push({ nodeId, command });
    return this.connected.has(nodeId);
  }
}

function reqAs(roleKey: string, sub: string) {
  return { user: { sub, roleKey, username: 'test', locationIds: [] } };
}

async function insertOpenShift(locationId: string, openedBy: string): Promise<string> {
  const res = await assertPool.query<{ id: string }>(
    `INSERT INTO pos_shifts (shift_number, location_id, opened_by, opened_at, opening_cash, client_id, status)
     VALUES ($1, $2, $3, NOW(), 0, $4, 'open') RETURNING id`,
    [`W3-10-TEST-${randomUUID().slice(0, 8)}`, locationId, openedBy, randomUUID()],
  );
  return res.rows[0]!.id;
}

describe('PUT /api/nodes/:id/network-config — W3-10 (live database)', () => {
  const createdNodeIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdShiftIds: string[] = [];

  afterEach(async () => {
    if (createdShiftIds.length > 0) {
      await assertPool.query(`DELETE FROM pos_shifts WHERE id = ANY($1::uuid[])`, [
        createdShiftIds,
      ]);
      createdShiftIds.length = 0;
    }
    await cleanupNodesAndDevices({ nodeIds: createdNodeIds, locationIds: createdLocationIds });
    for (const id of createdLocationIds) await deleteLocation(id);
    createdNodeIds.length = 0;
    createdLocationIds.length = 0;
  });

  // `closeTestPool()` is called once, in the LAST describe block in this file (below) — `getAppPool
  // `/`getOwnerPool()` are shared module-level singletons, and closing the pool here would break the
  // second describe block's tests, which run afterward in the same file/process.

  function buildController(bridge: FakeBridge): NodesController {
    return new NodesController(
      branchNodes,
      new PairingTokensService(),
      discovered,
      deviceRegistry,
      bridge as never,
      syncEmit,
      outletSetting,
      configService,
      pool,
    );
  }

  it('rejects a malformed config (gateway outside the static-IP subnet) with ERR_VALIDATION and writes nothing', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const bridge = new FakeBridge();
    bridge.connect(node.id as UUID);
    const controller = buildController(bridge);

    await expect(
      asRequest({ role: 'owner', userId: ownerId, locationIds: [] }, (client) =>
        controller.setNetworkConfig(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          node.id as UUID,
          {
            staticIp: '10.0.0.5',
            subnetMask: '255.255.255.0',
            gateway: '192.168.1.1', // NOT on 10.0.0.0/24 — the "malformed static IP" case
          },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });

    const row = await assertPool.query<{ network_config_status: string }>(
      `SELECT network_config_status FROM branch_nodes WHERE id = $1`,
      [node.id],
    );
    expect(row.rows[0]!.network_config_status).toBe('none'); // untouched
    expect(bridge.sentNetworkConfigs).toHaveLength(0); // never reached the node
  });

  it('rejects a reserved-port collision (healthPort 5432) with ERR_VALIDATION', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const bridge = new FakeBridge();
    bridge.connect(node.id as UUID);
    const controller = buildController(bridge);

    await expect(
      asRequest({ role: 'owner', userId: ownerId, locationIds: [] }, (client) =>
        controller.setNetworkConfig(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          node.id as UUID,
          {
            healthPort: 5432,
          },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_VALIDATION } });
  });

  it('refuses against a disconnected node (ERR_NODE_UNREACHABLE) — a config pushed into the void can never be confirmed or reverted', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const bridge = new FakeBridge(); // deliberately never `.connect()`ed
    const controller = buildController(bridge);

    await expect(
      asRequest({ role: 'owner', userId: ownerId, locationIds: [] }, (client) =>
        controller.setNetworkConfig(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          node.id as UUID,
          {
            healthPort: 4111,
          },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_NODE_UNREACHABLE } });
  });

  it(
    'the full write path: validates, encrypts the WiFi passphrase at rest, never echoes it back, ' +
      'delivers the plaintext only to the node over /bridge, and emits a secret-free sync event',
    async () => {
      const locationId = await insertIsolatedOutletLocation();
      createdLocationIds.push(locationId);
      const ownerId = await fetchOneUserId('owner');
      const node = await insertTestNode(locationId);
      createdNodeIds.push(node.id);
      const bridge = new FakeBridge();
      bridge.connect(node.id as UUID);
      const controller = buildController(bridge);

      const result = await asRequest(
        { role: 'owner', userId: ownerId, locationIds: [] },
        (client) =>
          controller.setNetworkConfig(
            { ...reqAs('owner', ownerId), dbClient: client } as never,
            node.id as UUID,
            {
              healthPort: 4222,
              wifiSsid: 'Outlet-WiFi',
              wifiPassphrase: 'super-secret-passphrase',
            },
          ),
      );

      // Never in the response, at any nesting depth.
      expect(JSON.stringify(result)).not.toContain('super-secret-passphrase');
      const configId = (result as { configId: string }).configId;

      const row = await assertPool.query<{
        network_config: { wifiSsid?: string; wifiPassphraseSet?: boolean; wifiPassphrase?: string };
        network_secret_enc: Buffer | null;
        network_config_status: string;
        network_config_id: string;
      }>(
        `SELECT network_config, network_secret_enc, network_config_status, network_config_id FROM branch_nodes WHERE id = $1`,
        [node.id],
      );
      const dbRow = row.rows[0]!;
      expect(dbRow.network_config_status).toBe('pending');
      expect(dbRow.network_config_id).toBe(configId);
      expect(dbRow.network_config.wifiSsid).toBe('Outlet-WiFi');
      expect(dbRow.network_config.wifiPassphraseSet).toBe(true);
      expect(dbRow.network_config.wifiPassphrase).toBeUndefined(); // never stored in the clear
      expect(dbRow.network_secret_enc).not.toBeNull();
      expect(
        decryptWifiPassphrase(
          dbRow.network_secret_enc!,
          networkSecretEncKeyFromConfig(configService),
        ),
      ).toBe('super-secret-passphrase'); // round-trips — it's genuinely usable, not write-only noise

      // Delivered to the NODE (the one place the plaintext is allowed to travel).
      expect(bridge.sentNetworkConfigs).toHaveLength(1);
      const pushed = bridge.sentNetworkConfigs[0]!.payload as { config: Record<string, unknown> };
      expect(pushed.config.wifiPassphrase).toBe('super-secret-passphrase');

      // The sync event this same write emits (audit history, `GET /api/sync/events`) must be secret-free.
      const eventRow = await assertPool.query<{
        payload: { data: { config: Record<string, unknown> } };
      }>(
        `SELECT payload FROM sync_events WHERE entity = 'branch_nodes' AND op = 'config_updated' AND entity_id = $1 ORDER BY server_seq DESC LIMIT 1`,
        [node.id],
      );
      expect(eventRow.rows).toHaveLength(1);
      const eventConfig = eventRow.rows[0]!.payload.data.config;
      expect(JSON.stringify(eventConfig)).not.toContain('super-secret-passphrase');
      expect(eventConfig.wifiPassphraseSet).toBe(true);
    },
  );
});

describe('POST /api/nodes/:id/command — restart/update gated on an open POS shift (W3-10)', () => {
  const createdNodeIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdShiftIds: string[] = [];

  afterEach(async () => {
    if (createdShiftIds.length > 0) {
      await assertPool.query(`DELETE FROM pos_shifts WHERE id = ANY($1::uuid[])`, [
        createdShiftIds,
      ]);
      createdShiftIds.length = 0;
    }
    await cleanupNodesAndDevices({ nodeIds: createdNodeIds, locationIds: createdLocationIds });
    for (const id of createdLocationIds) await deleteLocation(id);
    createdNodeIds.length = 0;
    createdLocationIds.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  function buildController(bridge: FakeBridge): NodesController {
    return new NodesController(
      branchNodes,
      new PairingTokensService(),
      discovered,
      deviceRegistry,
      bridge as never,
      syncEmit,
      outletSetting,
      configService,
      pool,
    );
  }

  it('refuses restart while a shift is open, then succeeds with params.override:true', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const shiftId = await insertOpenShift(locationId, ownerId);
    createdShiftIds.push(shiftId);
    const bridge = new FakeBridge();
    bridge.connect(node.id as UUID);
    const controller = buildController(bridge);

    await expect(
      withSystemContext(pool, (client) =>
        controller.sendCommand(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          node.id as UUID,
          {
            type: 'restart',
          },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_NODE_SHIFT_OPEN } });
    expect(bridge.sentCommands).toHaveLength(0);

    const sent = await withSystemContext(pool, (client) =>
      controller.sendCommand(
        { ...reqAs('owner', ownerId), dbClient: client } as never,
        node.id as UUID,
        {
          type: 'restart',
          params: { override: true },
        },
      ),
    );
    expect(sent.status).toBe('sent');
    expect(bridge.sentCommands).toHaveLength(1);
  });

  it('refuses update while a shift is open (same gate as restart)', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const shiftId = await insertOpenShift(locationId, ownerId);
    createdShiftIds.push(shiftId);
    const bridge = new FakeBridge();
    bridge.connect(node.id as UUID);
    const controller = buildController(bridge);

    await expect(
      withSystemContext(pool, (client) =>
        controller.sendCommand(
          { ...reqAs('owner', ownerId), dbClient: client } as never,
          node.id as UUID,
          {
            type: 'update',
          },
        ),
      ),
    ).rejects.toMatchObject({ response: { code: ERR_NODE_SHIFT_OPEN } });
  });

  it('discovery_scan and log_pull are NOT gated by an open shift — non-destructive commands fire regardless', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const shiftId = await insertOpenShift(locationId, ownerId);
    createdShiftIds.push(shiftId);
    const bridge = new FakeBridge();
    bridge.connect(node.id as UUID);
    const controller = buildController(bridge);

    const scan = await withSystemContext(pool, (client) =>
      controller.sendCommand(
        { ...reqAs('owner', ownerId), dbClient: client } as never,
        node.id as UUID,
        {
          type: 'discovery_scan',
        },
      ),
    );
    expect(scan.status).toBe('sent');

    const pull = await withSystemContext(pool, (client) =>
      controller.sendCommand(
        { ...reqAs('owner', ownerId), dbClient: client } as never,
        node.id as UUID,
        {
          type: 'log_pull',
        },
      ),
    );
    expect(pull.status).toBe('sent');
    expect(bridge.sentCommands).toHaveLength(2);
  });

  it('restart with no open shift needs no override', async () => {
    const locationId = await insertIsolatedOutletLocation();
    createdLocationIds.push(locationId);
    const ownerId = await fetchOneUserId('owner');
    const node = await insertTestNode(locationId);
    createdNodeIds.push(node.id);
    const bridge = new FakeBridge();
    bridge.connect(node.id as UUID);
    const controller = buildController(bridge);

    const sent = await withSystemContext(pool, (client) =>
      controller.sendCommand(
        { ...reqAs('owner', ownerId), dbClient: client } as never,
        node.id as UUID,
        {
          type: 'restart',
        },
      ),
    );
    expect(sent.status).toBe('sent');
  });
});
