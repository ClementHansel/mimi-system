/**
 * Shared live-database harness for `kernel/sync`'s integration/property
 * suites (SYNC-PROTOCOL §9 — "scenario tests run the real three
 * processes... cloud in test mode").
 *
 * TWO POOLS, DELIBERATELY (D-21/D-22 — the same incident class BUILD-PLAN
 * documents: a single shared connection string is exactly how RLS got
 * silently bypassed once already):
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (the Postgres superuser,
 *    `BYPASSRLS`). FIXTURE SETUP/TEARDOWN ONLY: reading a seeded
 *    user/location, inserting/deleting a test `devices` row, cleaning up
 *    after a test. These are test-harness concerns, not the code under
 *    test, and several of the rows they touch (`users`, `devices`,
 *    `offline_credentials`) are RLS-protected in ways a bare test script
 *    has no legitimate per-request identity to satisfy (see
 *    `system-rls-context.ts` for which of those the PRODUCTION code path
 *    can and cannot unlock).
 *  - `getAppPool()` — `DATABASE_URL` (the runtime `mimi_app` role, the SAME
 *    connection identity `DATABASE_POOL` uses in production). Every
 *    `kernel/sync` service under test (`SyncEventsRepository`,
 *    `ConflictDetectorService`, `OfflineAuthService`, `ReconciliationService`,
 *    `RegistryRepository`) is constructed against THIS pool in the test
 *    files, so the property/scenario tests exercise the REAL RLS-enforced
 *    path — not a superuser bypass wearing a test's clothing.
 *
 * Does NOT use `kernel/stock-ledger/test-support/live-db.ts`'s
 * rollback-only single-transaction pattern: `SyncIngestService.ingestBatch`
 * deliberately opens its OWN transaction per origin batch (§4.3 — each
 * batch's durable commit IS the "accepted" promise), so wrapping a whole
 * test in one never-committed transaction would not exercise the real
 * multi-commit behavior T-01/T-03 depend on (a later batch must be able to
 * SEE an earlier batch's committed high-water mark). Instead: every test
 * mints a fresh random `originDeviceId` (and any other ids it creates) and
 * an `afterEach` hook deletes exactly those rows via the OWNER pool —
 * precise, safe to run concurrently with any other agent's work against
 * this same shared dev database, and leaves no residue.
 */
import { Pool } from 'pg';

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

const APP_URL =
  process.env.DATABASE_URL ??
  `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

let ownerPool: Pool | undefined;
let appPool: Pool | undefined;

/** Fixture setup/teardown ONLY — never construct a service-under-test against this pool. */
export function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool every service-under-test is constructed against — same identity (`mimi_app`) as production `DATABASE_POOL`. */
export function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

/** @deprecated kept only so a stray import doesn't silently break — prefer `getAppPool()` (code under test) or `getOwnerPool()` (fixtures) explicitly. */
export function getTestPool(): Pool {
  return getAppPool();
}

export async function fetchOneLocationId(): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' ORDER BY id LIMIT 1`,
  );
  if (!res.rows[0]) throw new Error('Test fixture requires at least one seeded outlet location');
  return res.rows[0].id;
}

/** A second, DIFFERENT real outlet location — for location-spoofing tests (a bogus/nonexistent UUID would fail the `sync_events.location_id` FK before ever reaching the authority check it's meant to exercise). */
export async function fetchAnotherLocationId(excludeId: string): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `SELECT id FROM locations WHERE type = 'outlet' AND id <> $1 ORDER BY id LIMIT 1`,
    [excludeId],
  );
  if (!res.rows[0]) throw new Error('Test fixture requires at least two seeded outlet locations');
  return res.rows[0].id;
}

export async function fetchOneUserId(roleKey = 'supervisor'): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
      WHERE r.key = ANY($1::text[])
      ORDER BY array_position($1::text[], r.key), u.username
      LIMIT 1`,
    [roleKey === 'leader_outlet' ? ['leader_outlet', 'koki', 'kasir'] : [roleKey]],
  );
  if (!res.rows[0]) throw new Error(`Test fixture requires a seeded user with role '${roleKey}'`);
  return res.rows[0].id;
}

/** A real user's `user_locations` assignment — needed for §7.4 check 6 (approver still holds the location) fixtures. */
export async function assignUserToLocation(userId: string, locationId: string): Promise<void> {
  await getOwnerPool().query(
    `INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [userId, locationId],
  );
}

export async function insertTestDevice(locationId: string, tokenHash: string): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO devices (location_id, category, name, status, device_token_hash)
     VALUES ($1, 'tablet', 'W2-D test device', 'online', $2) RETURNING id`,
    [locationId, tokenHash],
  );
  return res.rows[0]!.id;
}

/** Deletes every row this suite could plausibly have created for the given synthetic origin ids — safe, precise, idempotent. */
export async function cleanupOrigins(originDeviceIds: string[]): Promise<void> {
  if (originDeviceIds.length === 0) return;
  const p = getOwnerPool();
  // Order matters: sync_events.batch_id -> sync_batches(id) and sync_conflicts.{winner,loser}_event_id ->
  // sync_events(event_id), so children must go before parents.
  await p.query(
    `DELETE FROM sync_conflicts WHERE loser_event_id IN (SELECT event_id FROM sync_events WHERE origin_device_id = ANY($1::uuid[])) OR winner_event_id IN (SELECT event_id FROM sync_events WHERE origin_device_id = ANY($1::uuid[]))`,
    [originDeviceIds],
  );
  await p.query(`DELETE FROM sync_events WHERE origin_device_id = ANY($1::uuid[])`, [
    originDeviceIds,
  ]);
  await p.query(`DELETE FROM sync_batches WHERE origin_device_id = ANY($1::uuid[])`, [
    originDeviceIds,
  ]);
  await p.query(`DELETE FROM sync_cursors WHERE subscriber_id = ANY($1::uuid[])`, [
    originDeviceIds,
  ]);
}

export async function cleanupDevices(deviceIds: string[]): Promise<void> {
  if (deviceIds.length === 0) return;
  const p = getOwnerPool();
  await p.query(`DELETE FROM offline_authorizations WHERE device_id = ANY($1::uuid[])`, [
    deviceIds,
  ]);
  await p.query(`DELETE FROM devices WHERE id = ANY($1::uuid[])`, [deviceIds]);
}

export async function cleanupCredentials(credentialIds: string[]): Promise<void> {
  if (credentialIds.length === 0) return;
  const p = getOwnerPool();
  await p.query(`DELETE FROM offline_authorizations WHERE credential_id = ANY($1::uuid[])`, [
    credentialIds,
  ]);
  await p.query(`DELETE FROM offline_credentials WHERE credential_id = ANY($1::uuid[])`, [
    credentialIds,
  ]);
}

/** Best-effort: also clears any `user_locations` rows this suite added (never the seed's own rows — callers pass back exactly what `assignUserToLocation` created). */
export async function cleanupUserLocation(userId: string, locationId: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM user_locations WHERE user_id = $1 AND location_id = $2`, [
    userId,
    locationId,
  ]);
}

export async function closeTestPool(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}
