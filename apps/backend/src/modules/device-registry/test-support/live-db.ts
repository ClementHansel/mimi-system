/**
 * Live-database test fixtures for M21/M22 (device-registry, node-gateway).
 * Reuses `kernel/sync/test-support/live-db.ts`'s two-pool pattern verbatim
 * (owner pool for fixture setup/teardown, app pool = the SAME `mimi_app`
 * RLS-enforced identity production `DATABASE_POOL` uses, D-21/D-22) rather
 * than re-implementing it — that file already documents why two separate
 * pools are non-negotiable here (the exact incident class BUILD-PLAN D-22
 * describes). This file only adds the fixtures specific to `branch_nodes`/
 * `pairing_tokens`/`discovered_devices`, which that file has no need of.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { hashDeviceToken } from '../../../kernel/sync/device-auth.guard';

export {
  getOwnerPool,
  getAppPool,
  fetchOneLocationId,
  fetchAnotherLocationId,
  fetchOneUserId,
  assignUserToLocation,
  insertTestDevice,
  cleanupOrigins,
  cleanupDevices,
  cleanupUserLocation,
  closeTestPool,
} from '../../../kernel/sync/test-support/live-db';

import { getAppPool, getOwnerPool } from '../../../kernel/sync/test-support/live-db';

/**
 * BE-TXN-ROLLBACK: a genuine per-request RLS session for exercising
 * `devices.controller.ts`/`nodes.controller.ts`/`outlet-node-setting.controller.ts`'s
 * request-scoped mutating routes — mirrors `stock-opname/test-support/live-db.ts`'s
 * `withRollbackAs`/`asRequest` exactly (own connection, `BEGIN` + `SET LOCAL ROLE app_user`
 * + session GUCs, run `fn`, ALWAYS `ROLLBACK` + release on the way out — the same
 * `RlsContextGuard` + `RlsCleanupInterceptor` lifecycle a real HTTP request gets).
 *
 * `kernel/sync/test-support/live-db.ts`'s own two-pool harness has no equivalent — every
 * existing live-DB test in `device-registry`/`node-gateway` instead used
 * `kernel/sync/system-rls-context.ts`'s `withSystemContext` (its own real BEGIN...COMMIT) to
 * stand in for "one request," which COMMITS UNCONDITIONALLY regardless of whether the
 * controller method under test ever calls `withWrite` itself — exactly the shape of harness
 * that could hide a missing-commit bug (a broken controller would still appear to persist,
 * because the harness's own commit saves it). `asRequest` below is the one that actually
 * proves the fix: only a controller method that itself calls `withWrite` survives this
 * connection's own unconditional `ROLLBACK`.
 *
 * THE RULE (identical to stock-opname's own harness): at most ONE call into a
 * `withWrite`-wrapped controller method per `asRequest` invocation, and nothing else on that
 * same `client` afterward (not even a read) — once `withWrite`'s `COMMIT` runs, `SET LOCAL
 * ROLE`/the `app.*` session GUCs revert with it, and any later query on that client fails
 * `permission denied for table ...`. A write-then-read-back assertion is therefore always TWO
 * separate `asRequest` calls.
 */
export interface RlsSessionContext {
  role: string;
  userId: string;
  locationIds: readonly string[];
}

export async function asRequest<T>(
  ctx: RlsSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds.join(','),
    ]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export interface TestNode {
  id: string;
  token: string;
  tokenHash: string;
}

/** A second, DIFFERENT real outlet location than the one a test's primary fixture already used — for cross-location authorization tests (spoofing/mismatch cases). Delegates to `fetchAnotherLocationId`'s exact query shape but is named separately here for call-site clarity in node/device pairing tests. */
export async function insertTestNode(
  locationId: string,
  version = '1.0.0-test',
): Promise<TestNode> {
  const token = randomBytes(24).toString('hex');
  const tokenHash = hashDeviceToken(token);
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO branch_nodes (location_id, name, status, version, node_token_hash, hostname, last_seen_at, paired_at)
     VALUES ($1, 'W3-10 test node', 'online', $2, $3, 'test-host', NOW(), NOW())
     RETURNING id`,
    [locationId, version, tokenHash],
  );
  return { id: res.rows[0]!.id, token, tokenHash };
}

export async function insertTestDeviceForNode(
  locationId: string,
  nodeId: string,
  tokenHash: string,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO devices (location_id, node_id, category, name, status, device_token_hash, last_seen_at)
     VALUES ($1, $2, 'tablet', 'W3-10 test device', 'online', $3, NOW())
     RETURNING id`,
    [locationId, nodeId, tokenHash],
  );
  return res.rows[0]!.id;
}

export async function backdateDeviceLastSeen(deviceId: string, secondsAgo: number): Promise<void> {
  await getOwnerPool().query(
    `UPDATE devices SET last_seen_at = NOW() - ($2 || ' seconds')::interval WHERE id = $1`,
    [deviceId, secondsAgo],
  );
}

export async function backdateNodeLastSeen(nodeId: string, secondsAgo: number): Promise<void> {
  await getOwnerPool().query(
    `UPDATE branch_nodes SET last_seen_at = NOW() - ($2 || ' seconds')::interval WHERE id = $1`,
    [nodeId, secondsAgo],
  );
}

/**
 * Puts a device and its node back online, the way a real heartbeat does.
 *
 * The sweep only ever moves rows toward WORSE states — see the "sweep never
 * moves a row back online" test — so backdating `last_seen_at` alone cannot
 * express a recovery: `status` is what the outlet rule reads. Recovery in
 * production is `DevicesController`'s heartbeat handler flipping the status
 * and refreshing the sighting, which is exactly what this does.
 */
export async function markSeenNow(params: {
  deviceIds?: string[];
  nodeIds?: string[];
}): Promise<void> {
  const pool = getOwnerPool();
  if (params.deviceIds?.length) {
    await pool.query(
      `UPDATE devices SET status = 'online', last_seen_at = NOW() WHERE id = ANY($1::uuid[])`,
      [params.deviceIds],
    );
  }
  if (params.nodeIds?.length) {
    await pool.query(
      `UPDATE branch_nodes SET status = 'online', last_seen_at = NOW() WHERE id = ANY($1::uuid[])`,
      [params.nodeIds],
    );
  }
}

export async function readDeviceStatus(deviceId: string): Promise<string> {
  const res = await getOwnerPool().query<{ status: string }>(
    `SELECT status FROM devices WHERE id = $1`,
    [deviceId],
  );
  return res.rows[0]!.status;
}

export async function readNodeStatus(nodeId: string): Promise<string> {
  const res = await getOwnerPool().query<{ status: string }>(
    `SELECT status FROM branch_nodes WHERE id = $1`,
    [nodeId],
  );
  return res.rows[0]!.status;
}

export async function deviceEventsFor(params: {
  deviceId?: string;
  nodeId?: string;
  locationId?: string;
}): Promise<{ type: string; created_at: string }[]> {
  const conds: string[] = [];
  const args: unknown[] = [];
  let i = 1;
  if (params.deviceId) {
    conds.push(`device_id = $${i++}`);
    args.push(params.deviceId);
  }
  if (params.nodeId) {
    conds.push(`node_id = $${i++}`);
    args.push(params.nodeId);
  }
  if (params.locationId && !params.deviceId && !params.nodeId) {
    conds.push(`location_id = $${i} AND device_id IS NULL AND node_id IS NULL`);
    args.push(params.locationId);
  }
  const res = await getOwnerPool().query<{ type: string; created_at: string }>(
    `SELECT type, created_at FROM device_events WHERE ${conds.join(' AND ')} ORDER BY created_at ASC`,
    args,
  );
  return res.rows;
}

/** Cleans up everything a device/node lifecycle test could plausibly have created for the given synthetic ids — child rows before parents (FK order). */
export async function cleanupNodesAndDevices(params: {
  nodeIds?: string[];
  deviceIds?: string[];
  locationIds?: string[];
}): Promise<void> {
  const pool = getOwnerPool();
  const deviceIds = params.deviceIds ?? [];
  const nodeIds = params.nodeIds ?? [];
  if (deviceIds.length > 0) {
    await pool.query(`DELETE FROM device_heartbeats WHERE device_id = ANY($1::uuid[])`, [
      deviceIds,
    ]);
    await pool.query(`DELETE FROM device_events WHERE device_id = ANY($1::uuid[])`, [deviceIds]);
    await pool.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
  }
  if (nodeIds.length > 0) {
    // `discovered_devices.confirmed_device_id` FKs to `devices(id)` with NO cascade/set-null action —
    // must be cleared BEFORE deleting the `devices` rows it may reference (BE-TXN-ROLLBACK's
    // `confirmDiscovered` write-then-read-back test is the first caller to leave a REAL confirmed
    // `discovered_devices` row behind, surfacing this ordering requirement).
    await pool.query(`DELETE FROM discovered_devices WHERE node_id = ANY($1::uuid[])`, [nodeIds]);
    await pool.query(`DELETE FROM devices WHERE node_id = ANY($1::uuid[])`, [nodeIds]); // any device this test forgot to list explicitly
    await pool.query(`DELETE FROM device_events WHERE node_id = ANY($1::uuid[])`, [nodeIds]);
    await pool.query(`DELETE FROM branch_nodes WHERE id = ANY($1::uuid[])`, [nodeIds]);
  }
  if (params.locationIds && params.locationIds.length > 0) {
    await pool.query(
      `DELETE FROM device_events WHERE location_id = ANY($1::uuid[]) AND device_id IS NULL AND node_id IS NULL`,
      [params.locationIds],
    );
    await pool.query(`DELETE FROM pairing_tokens WHERE location_id = ANY($1::uuid[])`, [
      params.locationIds,
    ]);
  }
}

export function freshHexToken(): string {
  return randomBytes(24).toString('hex');
}

export function freshId(): string {
  return randomUUID();
}

/**
 * A throwaway `outlet` location with a guaranteed-unique `code`, for tests
 * that need to reason about "ALL devices/node at this location" (the
 * outlet-offline derived rule, §7.3) — the seeded locations (`fetchOne
 * LocationId`) already carry real devices from W1-C's seed data, which
 * would make an "every device here is offline" assertion depend on OTHER
 * tests'/seed rows' state rather than only the rows this test created.
 */
export async function insertIsolatedOutletLocation(): Promise<string> {
  const code = `T${randomBytes(4).toString('hex').toUpperCase()}`;
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO locations (code, name, type, city) VALUES ($1, 'W3-10 isolated test outlet', 'outlet', 'Balikpapan') RETURNING id`,
    [code],
  );
  return res.rows[0]!.id;
}

/** Also clears `sync_events`/`sync_conflicts` rows this test's `SyncEmitService.emit()` calls created against the location (cloud-origin device_events/devices/branch_nodes facts) — `sync_events.location_id` FKs to `locations`, so an isolated test location can't be dropped while any survive. */
export async function deleteLocation(locationId: string): Promise<void> {
  const pool = getOwnerPool();
  await pool.query(
    `DELETE FROM sync_conflicts WHERE loser_event_id IN (SELECT event_id FROM sync_events WHERE location_id = $1) OR winner_event_id IN (SELECT event_id FROM sync_events WHERE location_id = $1)`,
    [locationId],
  );
  await pool.query(`DELETE FROM sync_events WHERE location_id = $1`, [locationId]);
  await pool.query(`DELETE FROM sync_batches WHERE location_id = $1`, [locationId]);
  await pool.query(`DELETE FROM locations WHERE id = $1`, [locationId]);
}
