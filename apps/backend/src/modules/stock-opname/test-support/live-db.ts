/**
 * Live-DB test harness for `stock-opname.integration.spec.ts` — same
 * two-pool shape as `kernel/approvals/test-support/live-db.ts` and
 * `kernel/stock-ledger/test-support/live-db.ts` (D-21/D-22): a shared
 * superuser connection is exactly how RLS got silently bypassed once.
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (superuser, `BYPASSRLS`).
 *    FIXTURE READS ONLY: seeded locations/users/items/storage_areas. This
 *    module owns creating its OWN `stock_opname` rows (unlike the approvals
 *    kernel's harness, which has to fixture-insert opname rows directly
 *    because it doesn't own that table) — so every `stock_opname`/
 *    `stock_opname_lines`/`stock_adjustments`/`approvals`/`stock_movements`/
 *    `sync_events` write in this suite goes through the REAL service call,
 *    on the SAME `mimi_app` transaction, never through the owner pool.
 *  - `getAppPool()` — `DATABASE_URL` (`mimi_app`, same identity `DATABASE_POOL`
 *    uses in production). `withRollbackAs` issues the identical `SET LOCAL
 *    ROLE app_user` + `set_config(...)` sequence `RlsContextGuard` issues per
 *    request, then ALWAYS rolls back — nothing this suite does persists.
 *
 * COORDINATOR-FLAGGED INCIDENT (fixed here): the first cut of this file
 * hardcoded `set_config('app.role', 'owner', true)` — a CENTRAL role that
 * satisfies `app_is_central()` unconditionally, so every RLS predicate this
 * session ever hit (`app_has_location()` on `stock_opname`/
 * `stock_opname_lines`/`stock_adjustments`, `users_select`'s
 * `app_is_central() OR app_is_self(id)`) took its bypass arm, never its
 * scoped-role arm. That is exactly the shape of bug W2-B's own harness hid
 * (`findPendingCandidates` dropping every row, invisible under 71 owner-role
 * tests) — a defect only a NON-central session can expose. `withRollbackAs`
 * below takes a CALLER-CHOSEN `app.role`/`app.user_id`/`app.location_ids`
 * (mirroring `kernel/approvals/test-support/live-db.ts`'s function of the
 * same name) so a test can run as the ACTUAL Supervisor/Kepala Gudang/Leader
 * Outlet fixture user, with THEIR real `user_locations` assignment as
 * `app.location_ids` — not an arbitrary override. `setSessionContext` lets
 * one test switch actor mid-transaction (e.g. Leader Outlet counts, then
 * Supervisor approves) since `set_config(..., true)` is re-settable any
 * number of times within the same transaction, reverting only at
 * COMMIT/ROLLBACK — matching how two different real HTTP requests would each
 * open their own `RlsContextGuard`-scoped transaction in production.
 *
 * `withRollback` (central/'owner') still exists for tests whose whole point
 * is engine logic (chain progression, threshold escalation, reason gating)
 * rather than what a scoped role's own Postgres session can see — same
 * distinction the approvals kernel's harness documents.
 */
import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';

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

function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

/** For manually wiring `SyncEventsRepository`'s `@Inject(DATABASE_POOL)` constructor arg in tests — every call in this suite passes an explicit `client`, so the pool itself is never actually used, only required to exist. */
export function appPoolForDi(): Pool {
  return getAppPool();
}

export async function closePool(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}

const SYSTEM_CONTEXT_USER_ID = '00000000-0000-0000-0000-0000000000aa';

export interface RlsSessionContext {
  /** A `RoleKey` string value, or `'owner'`/etc. — whatever `app.role` a real request would carry. */
  role: string;
  userId: string;
  /** `[]` = unrestricted for central roles; for a scoped role this MUST be the location(s) that role is ACTUALLY assigned (`user_locations`), or `app_has_location()` legitimately denies everything. Never `''` for `userId` — `app_is_self()` throws (not `false`) on an empty string (W1-C, in flight). */
  locationIds: readonly string[];
}

/** Re-asserts `app.user_id`/`app.role`/`app.location_ids` on an ALREADY-open transaction — for switching actor mid-test (one Postgres transaction standing in for several real HTTP requests in sequence). */
export async function setSessionContext(client: PoolClient, ctx: RlsSessionContext): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
    ctx.locationIds.join(','),
  ]);
}

/**
 * Same rolled-back-transaction contract as `withRollback`, but with a
 * CALLER-CHOSEN `app.role`/`app.user_id`/`app.location_ids` — the only way
 * to actually exercise a scoped role's real RLS-restricted session. Use this
 * for any test whose assertion depends on what a NON-central role's own
 * Postgres session can and cannot see.
 */
export async function withRollbackAs<T>(
  ctx: RlsSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await setSessionContext(client, ctx);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Session role fixed to central ('owner') — validates ENGINE logic (chain
 * progression, threshold routing, reason/dispute gating), NOT what a scoped
 * role's own session can see. See this file's header for why that
 * distinction is load-bearing, not pedantic.
 */
export async function withRollback<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  return withRollbackAs({ role: 'owner', userId: SYSTEM_CONTEXT_USER_ID, locationIds: [] }, fn);
}

export interface Fixtures {
  /** Kepala Gudang's OWN `user_locations` assignment — the warehouse they are actually scoped to, not merely "the first warehouse in the seed." */
  warehouseId: string;
  kepalaGudangUserId: string;
  storageAreaWarehouse: string;

  /** A (Supervisor, Leader Outlet) pair genuinely assigned to the SAME outlet — the seed pairs exactly one of each per outlet. */
  outletId: string;
  supervisorUserId: string;
  leaderOutletUserId: string;
  storageAreaOutlet: string;

  itemId: string;
  usersByRole: Record<RoleKey, string>;
}

export async function loadFixtures(): Promise<Fixtures> {
  const pool = getOwnerPool();

  // Kepala Gudang's real assignment (there is exactly one warehouse in the seed; every KGD is assigned to it).
  const kgd = await pool.query<{ user_id: string; location_id: string }>(
    `SELECT ul.user_id, ul.location_id
       FROM user_locations ul
       JOIN users u ON u.id = ul.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE r.key = 'kepala_gudang'
      LIMIT 1`,
  );
  if (!kgd.rows[0])
    throw new Error('loadFixtures: no kepala_gudang with a user_locations assignment in the seed');

  // A Supervisor and the Leader Outlet assigned to the SAME outlet (the seed pairs them 1:1, one pair per outlet).
  const pair = await pool.query<{ supervisor_id: string; leader_id: string; location_id: string }>(
    `SELECT spv.user_id AS supervisor_id, ldr.user_id AS leader_id, spv.location_id
       FROM user_locations spv
       JOIN users spv_u ON spv_u.id = spv.user_id
       JOIN roles spv_r ON spv_r.id = spv_u.role_id AND spv_r.key = 'supervisor'
       JOIN user_locations ldr ON ldr.location_id = spv.location_id
       JOIN users ldr_u ON ldr_u.id = ldr.user_id
       JOIN roles ldr_r ON ldr_r.id = ldr_u.role_id
      -- "an outlet floor worker who is not the supervisor", by preference rather
      -- than by role NAME. The specs that use this id supply the acting role
      -- themselves (\"callerFor(..., RoleKey.LEADER_OUTLET, ...)\"), so what the
      -- fixture owes them is a real user at the same outlet — not a particular
      -- role in the database.
      --
      -- It used to demand \"leader_outlet\", and broke the moment the org was
      -- reshaped into per-shift crews: the owner's model is supervisor + cashier
      -- + 2 cooks, so nobody holds \"leader_outlet\" any more and four fixtures
      -- failed against a perfectly valid database. Preference order keeps the
      -- old choice when it is still available, so nothing changes on a database
      -- seeded the old way.
      WHERE ldr_r.key IN ('leader_outlet', 'koki', 'kasir')
        AND ldr.user_id <> spv.user_id
      ORDER BY CASE ldr_r.key
                 WHEN 'leader_outlet' THEN 0
                 WHEN 'koki' THEN 1
                 ELSE 2
               END, ldr_u.username
      LIMIT 1`,
  );
  if (!pair.rows[0])
    throw new Error(
      'loadFixtures: no (supervisor, outlet-floor staffer) pair sharing one outlet in the seed',
    );

  const storageOutlet = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [pair.rows[0].location_id],
  );
  const storageWarehouse = await pool.query<{ id: string }>(
    `SELECT id FROM storage_areas WHERE location_id = $1 LIMIT 1`,
    [kgd.rows[0].location_id],
  );
  const item = await pool.query<{ id: string }>(`SELECT id FROM items LIMIT 1`);

  const usersByRole = {} as Record<RoleKey, string>;
  for (const roleKey of Object.values(RoleKey)) {
    const res = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key = ANY($1::text[])
        ORDER BY array_position($1::text[], r.key), u.username
        LIMIT 1`,
      [roleKey === 'leader_outlet' ? ['leader_outlet', 'koki', 'kasir'] : [roleKey]],
    );
    // A role with NOBODY IN IT is skipped rather than fatal. This used to throw,
    // which made every fixture here depend on the seed staffing all eleven
    // roles — and that broke the moment the org became the crews the business
    // actually runs (supervisor + cashier + 2 cooks), because no employee holds
    // `leader_outlet` any more. Eighteen spec files failed in `beforeAll`
    // against a database that was entirely valid. A spec that genuinely needs a
    // role now fails at the point of USE, naming the role it wanted.
    if (!res.rows[0]) continue;
    usersByRole[roleKey] = res.rows[0].id;
  }

  return {
    warehouseId: kgd.rows[0].location_id,
    kepalaGudangUserId: kgd.rows[0].user_id,
    storageAreaWarehouse: storageWarehouse.rows[0]!.id,

    outletId: pair.rows[0].location_id,
    supervisorUserId: pair.rows[0].supervisor_id,
    leaderOutletUserId: pair.rows[0].leader_id,
    storageAreaOutlet: storageOutlet.rows[0]!.id,

    itemId: item.rows[0]!.id,
    usersByRole,
  };
}

/** A clean `(location, area, item)` triplet with no pre-existing `stock_balances` row — so a test's counted qty IS the whole variance, deterministically. Read over the OWNER pool BEFORE any transaction under test starts (a pre-check, not a write). */
export async function pickUnusedStockKey(
  locationId: string,
  storageAreaId: string,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `SELECT i.id FROM items i
      WHERE NOT EXISTS (
        SELECT 1 FROM stock_balances b WHERE b.location_id = $1 AND b.storage_area_id = $2 AND b.item_id = i.id
      )
      ORDER BY random() LIMIT 1`,
    [locationId, storageAreaId],
  );
  const id = res.rows[0]?.id;
  if (!id)
    throw new Error(
      'pickUnusedStockKey: no unused item found for this (location, area) — seed exhausted?',
    );
  return id;
}

/** Reads on the SAME `client` the test is writing through — a separate (owner-pool) connection would not see this transaction's uncommitted rows. */
export async function readBalance(
  client: PoolClient,
  locationId: string,
  storageAreaId: string,
  itemId: string,
): Promise<string | null> {
  const res = await client.query<{ qty_on_hand: string }>(
    `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [locationId, storageAreaId, itemId],
  );
  return res.rows[0]?.qty_on_hand ?? null;
}

export async function setSettingValue(
  client: PoolClient,
  key: string,
  value: unknown,
): Promise<void> {
  await client.query(`UPDATE settings SET value = $2 WHERE key = $1`, [key, JSON.stringify(value)]);
}

/**
 * BE-TXN-ROLLBACK: an explicit alias for `withRollbackAs` used ONLY to mark
 * "this call is standing in for one real HTTP request" at call sites below —
 * mechanically identical (own connection, `BEGIN` + `SET LOCAL ROLE` +
 * session GUCs, run `fn`, always `ROLLBACK` + release on the way out, exactly
 * `RlsContextGuard` + `RlsCleanupInterceptor`'s own lifecycle).
 *
 * THE GOTCHA THAT MATTERS (read this before writing a multi-step live-DB
 * test): once a service method correctly wraps its writes in `withWrite`
 * (`BEGIN` — a no-op on an already-open transaction — ... `COMMIT`), that
 * `COMMIT` is REAL: it ends the transaction `withRollbackAs` opened, and
 * `SET LOCAL ROLE`/the `app.*` session GUCs revert with it (Postgres reverts
 * ALL transaction-local state at COMMIT, not only at ROLLBACK). The exact
 * same thing happens if the wrapped call instead throws and `withWrite`'s own
 * `catch` issues `ROLLBACK` — that also ends the transaction and reverts the
 * role. Either way, ANYTHING run later on that SAME `client` — even a plain
 * read — executes with no role and no session context, and fails with
 * `permission denied for table ...` (`mimi_app` itself has zero direct
 * grants; every grant lives behind `app_user`). This is exactly the shape of
 * bug this ticket's fix could no longer hide once `stock-opname.service.ts`
 * started calling `withWrite` for real: this suite's pre-existing tests
 * chained several mutating calls onto ONE `withRollbackAs`/`withRollback`
 * connection, which only ever worked because nothing actually committed
 * before the fix.
 *
 * THE RULE: a `withRollbackAs`/`asRequest` block may contain AT MOST ONE
 * call into a `withWrite`-wrapped service method, and nothing on that same
 * `client` may run after it (not even a read) — matching `waste-return`'s
 * established convention ("each step of a flow opens its OWN
 * `withRollbackAs`", see that module's integration spec header). A
 * write-then-read-back assertion is therefore always TWO calls: one
 * `asRequest`/`withRollbackAs` for the mutation, a SEPARATE one for the
 * verifying read — which is also the only shape that can catch a service
 * that silently never commits: if the write never really persisted, the
 * second, genuinely-separate connection sees nothing.
 *
 * Data written this way is a REAL commit — like production, it survives this
 * process's own `ROLLBACK` (there is nothing left to roll back by the time
 * it runs). Tests using this rely on the standing `pnpm --filter
 * @mimi/database reset` between runs, same as every other live-DB write path
 * in this repo.
 */
export const asRequest = withRollbackAs;

/**
 * For TEST-ONLY seed writes that must be visible to a LATER, separate
 * `asRequest`/`withRollbackAs` connection (e.g. hand-inserting `sync_events`/
 * `sync_conflicts` rows to simulate "two devices already reported a
 * conflicting count" before exercising `submit`'s open-dispute gate) — opens
 * its own connection, asserts context, runs `fn`, and actually `COMMIT`s
 * (never rolls back). Use ONLY for fixture setup that isn't itself the
 * behavior under test; anything that IS the behavior under test should go
 * through the real service (and `withWrite`), not this.
 */
export async function asCommittedRequest<T>(
  ctx: RlsSessionContext,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await setSessionContext(client, ctx);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}
