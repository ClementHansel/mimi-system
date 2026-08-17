/**
 * BE-TXN-ROLLBACK regression coverage for `device-registry`'s request-scoped
 * mutating routes (`DevicesController.mintPairingToken`/`update`/`unpair`/
 * `retire`) — before this ticket's fix, every one of these ran its writes
 * directly on `req.dbClient` with no `BEGIN...COMMIT` of its own, so
 * `RlsCleanupInterceptor`'s unconditional post-request `ROLLBACK` silently
 * discarded them (a 200/201 response with a full body, immediately followed
 * by a stale/404 read on the same row).
 *
 * `asRequest` (`test-support/live-db.ts`) is the harness that actually proves
 * the fix: unlike `kernel/sync/system-rls-context.ts`'s `withSystemContext`
 * (which every OTHER live-DB test in this pair of modules used, and which
 * COMMITS UNCONDITIONALLY regardless of whether the code under test ever
 * calls `withWrite`), `asRequest` opens its own connection, asserts the
 * session, runs the controller method, and ALWAYS `ROLLBACK`s — exactly
 * `RlsContextGuard` + `RlsCleanupInterceptor`'s real lifecycle. Only a
 * controller method that itself commits (via `withWrite`) survives it. Per
 * that file's own rule: at most one mutating call per `asRequest`
 * connection, so every write-then-read-back assertion here is two separate
 * connections — a later read that only sees this test's mutation if it was
 * REALLY committed, not merely visible within its own now-rolled-back
 * transaction.
 *
 * `register`/`heartbeat` (already fixed via `withSystemContext`) and the
 * staleness sweep are NOT retested here — see `device-and-node-lifecycle
 * .integration.test.ts` and `staleness-sweep.integration.test.ts`, which
 * already exercise those real-commit paths.
 */
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { hashDeviceToken } from '../../kernel/sync/device-auth.guard';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { SyncEventsRepository } from '../../kernel/sync/sync-events.repository';
import { SyncConflictsRepository } from '../../kernel/sync/sync-conflicts.repository';
import { ConflictDetectorService } from '../../kernel/sync/conflict-detector.service';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { DeviceRegistryRepository } from './device-registry.repository';
import { PairingTokensService } from './pairing-tokens.service';
import { DevicesController } from './devices.controller';
import type { TopologyGateway } from './topology.gateway';
import {
  asRequest,
  cleanupNodesAndDevices,
  closeTestPool,
  fetchOneLocationId,
  fetchOneUserId,
  getAppPool,
  getOwnerPool,
} from './test-support/live-db';

const pool = getAppPool();
const assertPool = getOwnerPool();

const devicesRepo = new DeviceRegistryRepository();
const pairingTokens = new PairingTokensService();
const eventsRepo = new SyncEventsRepository(pool);
const conflictsRepo = new SyncConflictsRepository();
const conflictDetector = new ConflictDetectorService(eventsRepo, conflictsRepo);
const syncEmit = new SyncEmitService(eventsRepo, conflictDetector);
const fakeConfig = { get: (_key: string, def?: string) => def } as unknown as ConfigService;
const fakeTopologyGateway = { emitUpdate: () => undefined } as unknown as TopologyGateway;

function reqAs(sub: string) {
  return { user: { sub, roleKey: 'owner', username: 'test', locationIds: [] } } as unknown as Parameters<DevicesController['update']>[0];
}

describe('DevicesController — BE-TXN-ROLLBACK write-then-read-back (live database, separate connections)', () => {
  const createdDeviceIds: string[] = [];
  const createdPairingTokenIds: string[] = [];

  afterEach(async () => {
    await cleanupNodesAndDevices({ deviceIds: createdDeviceIds });
    if (createdPairingTokenIds.length > 0) {
      await assertPool.query(`DELETE FROM pairing_tokens WHERE id = ANY($1::uuid[])`, [createdPairingTokenIds]);
    }
    createdDeviceIds.length = 0;
    createdPairingTokenIds.length = 0;
  });

  afterAll(async () => {
    await closeTestPool();
  });

  function buildController(): DevicesController {
    return new DevicesController(devicesRepo, pairingTokens, syncEmit, fakeConfig, fakeTopologyGateway, pool);
  }

  it('mintPairingToken persists past its own request — a later, separate connection finds the pairing_tokens row', async () => {
    const locationId = await fetchOneLocationId();
    const ownerId = await fetchOneUserId('owner');
    const controller = buildController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };

    const minted = await asRequest(ctx, (client) =>
      controller.mintPairingToken({ ...reqAs(ownerId), dbClient: client } as never, { locationId }),
    );
    expect(minted.token).toHaveLength(48);
    createdPairingTokenIds.push(minted.tokenId);

    // Separate connection/transaction — never sees the minting connection's uncommitted state.
    const row = await assertPool.query(`SELECT id, location_id FROM pairing_tokens WHERE id = $1`, [minted.tokenId]);
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].location_id).toBe(locationId);
  });

  it('update persists — a later, separate connection sees the new name/category, not the pre-update one', async () => {
    const locationId = await fetchOneLocationId();
    const ownerId = await fetchOneUserId('owner');
    const created = await withSystemContext(pool, (client) =>
      devicesRepo.create(client, {
        locationId,
        nodeId: null,
        category: 'tablet',
        name: 'BE-TXN-ROLLBACK original name',
        fingerprint: `fp-${randomBytes(4).toString('hex')}`,
        appVersion: '1.0.0',
        osInfo: {},
        replacesDeviceId: null,
        deviceTokenHash: hashDeviceToken(randomBytes(32).toString('hex')),
        pairedBy: null,
      }),
    );
    createdDeviceIds.push(created.id);

    const controller = buildController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const updated = await asRequest(ctx, (client) =>
      controller.update({ ...reqAs(ownerId), dbClient: client } as never, created.id, { name: 'BE-TXN-ROLLBACK renamed' }),
    );
    expect(updated.name).toBe('BE-TXN-ROLLBACK renamed');

    const row = await assertPool.query<{ name: string }>(`SELECT name FROM devices WHERE id = $1`, [created.id]);
    expect(row.rows[0]!.name).toBe('BE-TXN-ROLLBACK renamed');
  });

  it('unpair persists — a later, separate connection sees status=unpaired and a cleared device_token_hash', async () => {
    const locationId = await fetchOneLocationId();
    const ownerId = await fetchOneUserId('owner');
    const created = await withSystemContext(pool, (client) =>
      devicesRepo.create(client, {
        locationId,
        nodeId: null,
        category: 'tablet',
        name: 'BE-TXN-ROLLBACK unpair target',
        fingerprint: `fp-${randomBytes(4).toString('hex')}`,
        appVersion: '1.0.0',
        osInfo: {},
        replacesDeviceId: null,
        deviceTokenHash: hashDeviceToken(randomBytes(32).toString('hex')),
        pairedBy: null,
      }),
    );
    createdDeviceIds.push(created.id);

    const controller = buildController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const unpaired = await asRequest(ctx, (client) =>
      controller.unpair({ ...reqAs(ownerId), dbClient: client } as never, created.id, { reason: 'test' }),
    );
    expect(unpaired.status).toBe('unpaired');

    const row = await assertPool.query<{ status: string; device_token_hash: string | null }>(
      `SELECT status, device_token_hash FROM devices WHERE id = $1`,
      [created.id],
    );
    expect(row.rows[0]!.status).toBe('unpaired');
    expect(row.rows[0]!.device_token_hash).toBeNull();

    const events = await assertPool.query(`SELECT type FROM device_events WHERE device_id = $1`, [created.id]);
    expect(events.rows.map((r) => r.type)).toContain('unpaired');
  });

  it('retire persists — a later, separate connection sees status=retired', async () => {
    const locationId = await fetchOneLocationId();
    const ownerId = await fetchOneUserId('owner');
    const created = await withSystemContext(pool, (client) =>
      devicesRepo.create(client, {
        locationId,
        nodeId: null,
        category: 'tablet',
        name: 'BE-TXN-ROLLBACK retire target',
        fingerprint: `fp-${randomBytes(4).toString('hex')}`,
        appVersion: '1.0.0',
        osInfo: {},
        replacesDeviceId: null,
        deviceTokenHash: hashDeviceToken(randomBytes(32).toString('hex')),
        pairedBy: null,
      }),
    );
    createdDeviceIds.push(created.id);

    const controller = buildController();
    const ctx = { role: 'owner', userId: ownerId, locationIds: [] };
    const retired = await asRequest(ctx, (client) =>
      controller.retire({ ...reqAs(ownerId), dbClient: client } as never, created.id, {}),
    );
    expect(retired.status).toBe('retired');

    const row = await assertPool.query<{ status: string }>(`SELECT status FROM devices WHERE id = $1`, [created.id]);
    expect(row.rows[0]!.status).toBe('retired');
  });
});
