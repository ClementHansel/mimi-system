/**
 * Live-database integration test for the M21/M22 pairing -> register ->
 * heartbeat -> topology lifecycle (CONTRACTS.md §4.21/§4.22/§7), plus RBAC
 * negative tests against the REAL `packages/shared` RBAC matrix (CONTRACTS
 * §3) for the permission keys these two modules' endpoints declare.
 *
 * Exercises the actual `PairingTokensService`/`DeviceRegistryRepository`/
 * `BranchNodesRepository`/`TopologyService` classes against the real
 * `mimi-postgres` instance — the same DB-access path the controllers use
 * (`withSystemContext` for the no-user-session public routes), not a
 * re-implementation of the controller's own HTTP-layer wiring (a full
 * Nest HTTP bootstrap for two modules whose collaborators span kernel/sync,
 * kernel/notification, and ConfigService is out of proportion to what this
 * suite needs to prove: the pairing/registration/heartbeat DATA PATH and
 * topology ASSEMBLY are correct end to end).
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { can, PairingTargetType, type RoleKey } from '@mimi/shared';
import { hashDeviceToken } from '../../kernel/sync/device-auth.guard';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { DeviceRegistryRepository } from './device-registry.repository';
import { PairingTokensService } from './pairing-tokens.service';
import { TopologyService } from './topology.service';
import { BranchNodesRepository } from '../node-gateway/branch-nodes.repository';
import {
  cleanupNodesAndDevices,
  closeTestPool,
  deleteLocation,
  fetchOneLocationId,
  fetchOneUserId,
  getAppPool,
  getOwnerPool,
  insertIsolatedOutletLocation,
} from './test-support/live-db';

const pool = getAppPool();
const assertPool = getOwnerPool();
const devicesRepo = new DeviceRegistryRepository();
const pairingTokens = new PairingTokensService();
const topology = new TopologyService(pool);
const branchNodes = new BranchNodesRepository();

describe('Device + node pairing/register/heartbeat lifecycle — live database', () => {
  const createdDeviceIds: string[] = [];
  const createdNodeIds: string[] = [];
  let isolatedLocationId: string | undefined;

  afterEach(async () => {
    await cleanupNodesAndDevices({ nodeIds: createdNodeIds, deviceIds: createdDeviceIds, locationIds: isolatedLocationId ? [isolatedLocationId] : undefined });
    createdDeviceIds.length = 0;
    createdNodeIds.length = 0;
    if (isolatedLocationId) {
      await deleteLocation(isolatedLocationId);
      isolatedLocationId = undefined;
    }
  });

  afterAll(async () => {
    await closeTestPool();
  });

  it('device pairing token mint -> redeem -> register creates a real, correctly-scoped devices row', async () => {
    const locationId = await fetchOneLocationId();
    const ownerId = await fetchOneUserId('owner');

    const minted = await withSystemContext(pool, (client) =>
      pairingTokens.mint(client, { targetType: PairingTargetType.DEVICE, locationId, createdBy: ownerId }),
    );
    expect(minted.token).toHaveLength(48); // randomBytes(24).toString('hex')
    expect(minted.qrPayload).toContain('device');

    const redeemed = await withSystemContext(pool, (client) => pairingTokens.redeem(client, minted.token, PairingTargetType.DEVICE));
    expect(redeemed?.locationId).toBe(locationId);
    expect(redeemed?.createdBy).toBe(ownerId);

    // Single-use: a second redemption attempt of the SAME token must fail.
    const secondAttempt = await withSystemContext(pool, (client) => pairingTokens.redeem(client, minted.token, PairingTargetType.DEVICE));
    expect(secondAttempt).toBeUndefined();

    const deviceTokenHash = hashDeviceToken(randomBytes(32).toString('hex'));
    const created = await withSystemContext(pool, (client) =>
      devicesRepo.create(client, {
        locationId: redeemed!.locationId,
        nodeId: null,
        category: 'tablet',
        name: 'Kasir 1',
        fingerprint: `fp-${minted.tokenId}`,
        appVersion: '1.0.0',
        osInfo: {},
        replacesDeviceId: null,
        deviceTokenHash,
        pairedBy: redeemed!.createdBy,
      }),
    );
    createdDeviceIds.push(created.id);

    expect(created.location_id).toBe(locationId);
    expect(created.status).toBe('online');
    expect(created.last_seen_at).not.toBeNull(); // §7.3 "first sighting is silent" — stamped at registration

    const row = await assertPool.query(`SELECT * FROM devices WHERE id = $1`, [created.id]);
    expect(row.rows[0].device_token_hash).toBe(deviceTokenHash);
  });

  it('heartbeat ingest updates devices bookkeeping and appends device_heartbeats', async () => {
    const locationId = await fetchOneLocationId();
    const created = await withSystemContext(pool, (client) =>
      devicesRepo.create(client, {
        locationId,
        nodeId: null,
        category: 'tablet',
        name: 'Kasir 2',
        fingerprint: `fp-${randomBytes(4).toString('hex')}`,
        appVersion: '1.0.0',
        osInfo: {},
        replacesDeviceId: null,
        deviceTokenHash: hashDeviceToken(randomBytes(32).toString('hex')),
        pairedBy: null,
      }),
    );
    createdDeviceIds.push(created.id);

    await withSystemContext(pool, (client) =>
      devicesRepo.recordHeartbeat(client, created.id, {
        appVersion: '1.1.0',
        queueDepth: 3,
        clientTime: new Date().toISOString(),
        batteryPct: 88,
        payload: { note: 'test heartbeat' },
      }),
    );

    const row = await assertPool.query<{ app_version: string; queue_depth: number; last_seen_at: string | null }>(
      `SELECT app_version, queue_depth, last_seen_at FROM devices WHERE id = $1`,
      [created.id],
    );
    expect(row.rows[0]!.app_version).toBe('1.1.0');
    expect(row.rows[0]!.queue_depth).toBe(3);
    expect(row.rows[0]!.last_seen_at).not.toBeNull();

    const beats = await assertPool.query(`SELECT * FROM device_heartbeats WHERE device_id = $1`, [created.id]);
    expect(beats.rows).toHaveLength(1);
    expect(beats.rows[0].battery_pct).toBe(88);
  });

  it('a paired node + device appear correctly in the assembled topology tree, degrading gracefully where no node exists', async () => {
    isolatedLocationId = await insertIsolatedOutletLocation();
    const nodeToken = randomBytes(24).toString('hex');
    const node = await withSystemContext(pool, (client) =>
      branchNodes.create(client, {
        locationId: isolatedLocationId!,
        name: 'Test Node',
        version: '1.0.0',
        hostname: 'test-host',
        osInfo: {},
        nodeTokenHash: hashDeviceToken(nodeToken),
        pairedBy: null,
      }),
    );
    createdNodeIds.push(node.id);

    const device = await withSystemContext(pool, (client) =>
      devicesRepo.create(client, {
        locationId: isolatedLocationId!,
        nodeId: node.id,
        category: 'tablet',
        name: 'LAN Kasir',
        fingerprint: `fp-${randomBytes(4).toString('hex')}`,
        appVersion: '1.0.0',
        osInfo: {},
        replacesDeviceId: null,
        deviceTokenHash: hashDeviceToken(randomBytes(32).toString('hex')),
        pairedBy: null,
      }),
    );
    createdDeviceIds.push(device.id);

    const tree = await topology.buildTree();
    const allOutlets = tree.cities.flatMap((c) => c.outlets);
    const outlet = allOutlets.find((o) => o.location.id === isolatedLocationId);
    expect(outlet).toBeDefined();
    expect(outlet!.node).not.toBeNull();
    expect(outlet!.node!.id).toBe(node.id);
    expect(outlet!.devices.map((d) => d.id)).toContain(device.id);
    expect(outlet!.counts.online).toBe(1);
    expect(outlet!.outletStatus).toBe('online');

    // Graceful degradation (D-13): a location with NO branch node still renders — `node: null`, same shape.
    const noNodeOutlet = allOutlets.find((o) => o.node === null);
    expect(noNodeOutlet).toBeDefined();
  });

  it('RBAC (CONTRACTS §3): device/node/topology permission keys match the real matrix for every role these endpoints gate on', () => {
    // device.read: OWN, MGR, SPV only
    expect(can('owner' as RoleKey, 'device.read')).toBe(true);
    expect(can('manager' as RoleKey, 'device.read')).toBe(true);
    expect(can('supervisor' as RoleKey, 'device.read')).toBe(true);
    expect(can('kasir' as RoleKey, 'device.read')).toBe(false);
    expect(can('kepala_gudang' as RoleKey, 'device.read')).toBe(false);
    expect(can('leader_outlet' as RoleKey, 'device.read')).toBe(false);
    expect(can('driver' as RoleKey, 'device.read')).toBe(false);

    // device.manage / device.pair: OWN, MGR (+ SPV may PAIR but not MANAGE, per §3)
    expect(can('owner' as RoleKey, 'device.manage')).toBe(true);
    expect(can('supervisor' as RoleKey, 'device.manage')).toBe(false);
    expect(can('supervisor' as RoleKey, 'device.pair')).toBe(true);
    expect(can('kasir' as RoleKey, 'device.pair')).toBe(false);

    // node.manage / node.read / topology.read: OWN, MGR only — a Kasir or Kepala Gudang must 403
    for (const key of ['node.read', 'node.manage', 'topology.read'] as const) {
      expect(can('owner' as RoleKey, key)).toBe(true);
      expect(can('manager' as RoleKey, key)).toBe(true);
      expect(can('kasir' as RoleKey, key)).toBe(false);
      expect(can('kepala_gudang' as RoleKey, key)).toBe(false);
      expect(can('supervisor' as RoleKey, key)).toBe(false);
      expect(can('driver' as RoleKey, key)).toBe(false);
    }
  });
});
