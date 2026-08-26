/**
 * Shared live-database harness for `stock-ledger.integration.spec.ts` and
 * `stock-ledger.property.spec.ts` (BUILD-PLAN §5 W2-A: "Integration tests
 * against the live database").
 *
 * `POSTGRES_PORT=55433 docker compose up -d postgres` per the brief; falls
 * back to that exact port/user/db so the suite runs with zero extra setup
 * once the container is up (matches the brief's docker-compose defaults —
 * see `docker-compose.yml`'s `POSTGRES_PORT:-5432` mapped to the host).
 *
 * EVERY test opens its own transaction via `openTestTx()` and MUST release
 * it via `closeTestTx()` in an `afterEach` — which always ROLLBACKs, never
 * commits. That is what makes "the live-DB invariant still holds after your
 * tests run" true by construction rather than by cleanup discipline: no
 * test in this suite ever durably writes a row, regardless of what it
 * asserts mid-transaction. Session vars are set to an unrestricted central
 * role ('owner') so RLS (`FORCE`d — D-21) does not narrow visibility for
 * fixtures spanning multiple locations (needed for cross-location transfer
 * tests); RLS *enforcement itself* is exercised separately by
 * `stock-ledger.integration.spec.ts`'s dedicated RLS-scoping tests, which
 * override these vars mid-transaction.
 */
import { Pool, type PoolClient } from 'pg';

const DATABASE_URL =
  process.env.DATABASE_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

let pool: Pool | undefined;

function getPool(): Pool {
  pool ??= new Pool({ connectionString: DATABASE_URL, max: 5 });
  return pool;
}

export async function openTestTx(): Promise<PoolClient> {
  const client = await getPool().connect();
  await client.query('BEGIN');
  // `POSTGRES_USER` (the migration-running login role — `mimi` by default,
  // see docker-compose.yml) is a Postgres SUPERUSER with BYPASSRLS in this
  // stack (verified against the live container: `rolsuper=t, rolbypassrls=t`
  // for `mimi`). Per Postgres semantics, `FORCE ROW LEVEL SECURITY` (D-21,
  // migrations 009/026) does NOT apply to superusers regardless of the
  // FORCE flag — only table OWNERS who are not superusers are affected by
  // FORCE. Testing RLS while connected AS that superuser would silently
  // bypass RLS entirely and give a false-green "enforced" result.
  // `SET LOCAL ROLE app_user` (transaction-scoped, mirrors `set_config(...,
  // true)`'s is_local semantics) drops to the actual non-superuser runtime
  // role migration 009 provisions for exactly this reason — the same role
  // CONTRACTS.md/BUILD-PLAN D-21 says the app should run as. See this
  // package's report for a flagged finding: `RlsContextGuard`
  // (`common/guards/rls-context.guard.ts`) does NOT currently issue this
  // `SET ROLE`, despite migration 009's comment describing that as the
  // design ("the backend connects as its pool login role, then issues SET
  // ROLE app_user per request") — if the app's `DATABASE_URL` connects as
  // the same superuser login this harness would otherwise use, RLS is
  // decoration in production today, not just in a naive test. Not this
  // module's file to fix (owned by W1-D), but load-bearing enough to flag
  // loudly.
  await client.query('SET LOCAL ROLE app_user');
  await setRlsContext(client, {
    role: 'owner',
    userId: '00000000-0000-0000-0000-0000000000aa',
    locationIds: null,
  });
  return client;
}

export async function closeTestTx(client: PoolClient): Promise<void> {
  await client.query('ROLLBACK');
  client.release();
}

export async function closeTestPool(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export async function setRlsContext(
  client: PoolClient,
  ctx: { role: string; userId: string; locationIds: readonly string[] | null },
): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
    ctx.locationIds === null ? '' : ctx.locationIds.join(','),
  ]);
}

export interface StockFixtureKey {
  locationId: string;
  storageAreaId: string;
  itemId: string;
}

/**
 * Finds a `(location, area, item)` triplet with NO existing `stock_balances`
 * row, so a test can post movements against it starting from a known-zero
 * balance without needing to touch (or care about) the seed's 630 existing
 * keys — the whole call runs inside a transaction that gets rolled back
 * regardless.
 */
export async function pickUnusedStockKey(
  client: PoolClient,
  opts: { excludeLocationId?: string } = {},
): Promise<StockFixtureKey> {
  const res = await client.query<{ location_id: string; storage_area_id: string; item_id: string }>(
    // "Unused" has to mean unused by EVERY table a caller then counts, not
    // just `stock_balances`.
    //
    // `stock-ledger.property.spec.ts`'s C5 property counts the
    // `stock_reconciliations` rows for the key it was handed and asserts the
    // number equals the crossings it just caused. Filtering on balances alone
    // let it be handed a key that already carried reconciliations left behind
    // by an earlier suite — of which this database has several, on keys with
    // no balance row at all — and the assertion then failed by exactly the
    // number of pre-existing rows (seen in CI as "expected 5 to be 4").
    // Because the key is chosen with `ORDER BY random()`, that surfaced as an
    // intermittent CI failure rather than a reproducible one.
    //
    // `stock_movements` is excluded on the same principle: a key with history
    // but no surviving balance row is not a clean slate either.
    `SELECT sa.location_id, sa.id AS storage_area_id, i.id AS item_id
       FROM storage_areas sa
       CROSS JOIN items i
      WHERE NOT EXISTS (
              SELECT 1 FROM stock_balances b
               WHERE b.location_id = sa.location_id AND b.storage_area_id = sa.id AND b.item_id = i.id
            )
        AND NOT EXISTS (
              SELECT 1 FROM stock_reconciliations r
               WHERE r.location_id = sa.location_id AND r.storage_area_id = sa.id AND r.item_id = i.id
            )
        AND NOT EXISTS (
              SELECT 1 FROM stock_movements m
               WHERE m.location_id = sa.location_id AND m.storage_area_id = sa.id AND m.item_id = i.id
            )
        ${opts.excludeLocationId ? 'AND sa.location_id <> $1' : ''}
      ORDER BY random()
      LIMIT 1`,
    opts.excludeLocationId ? [opts.excludeLocationId] : [],
  );
  const row = res.rows[0];
  if (!row)
    throw new Error(
      'pickUnusedStockKey: no unused (location, area, item) triplet found — seed data exhausted?',
    );
  return { locationId: row.location_id, storageAreaId: row.storage_area_id, itemId: row.item_id };
}

export interface TransferFixture {
  itemId: string;
  from: { locationId: string; storageAreaId: string };
  to: { locationId: string; storageAreaId: string };
}

/** Same idea as `pickUnusedStockKey`, but for a pair of keys spanning two DIFFERENT locations sharing one item — a clean fixture for cross-location transfer tests. */
export async function pickUnusedTransferFixture(client: PoolClient): Promise<TransferFixture> {
  const res = await client.query<{
    from_location: string;
    from_area: string;
    to_location: string;
    to_area: string;
    item_id: string;
  }>(
    `WITH cand_areas AS (
       SELECT location_id, id FROM storage_areas ORDER BY random() LIMIT 30
     ),
     cand_items AS (
       SELECT id FROM items ORDER BY random() LIMIT 50
     )
     SELECT a1.location_id AS from_location, a1.id AS from_area,
            a2.location_id AS to_location, a2.id AS to_area,
            ci.id AS item_id
       FROM cand_areas a1
       JOIN cand_areas a2 ON a2.location_id <> a1.location_id
       CROSS JOIN cand_items ci
      WHERE NOT EXISTS (SELECT 1 FROM stock_balances b WHERE b.location_id = a1.location_id AND b.storage_area_id = a1.id AND b.item_id = ci.id)
        AND NOT EXISTS (SELECT 1 FROM stock_balances b WHERE b.location_id = a2.location_id AND b.storage_area_id = a2.id AND b.item_id = ci.id)
      LIMIT 1`,
  );
  const row = res.rows[0];
  if (!row) throw new Error('pickUnusedTransferFixture: no clean two-location fixture found');
  return {
    itemId: row.item_id,
    from: { locationId: row.from_location, storageAreaId: row.from_area },
    to: { locationId: row.to_location, storageAreaId: row.to_area },
  };
}

export async function readBalance(
  client: PoolClient,
  key: StockFixtureKey,
): Promise<string | null> {
  const res = await client.query<{ qty_on_hand: string }>(
    `SELECT qty_on_hand FROM stock_balances WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [key.locationId, key.storageAreaId, key.itemId],
  );
  return res.rows[0]?.qty_on_hand ?? null;
}

export async function countMovements(client: PoolClient, key: StockFixtureKey): Promise<number> {
  const res = await client.query<{ count: string }>(
    `SELECT count(*)::int AS count FROM stock_movements WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
    [key.locationId, key.storageAreaId, key.itemId],
  );
  return Number(res.rows[0]?.count ?? 0);
}

/** The G1 invariant, scoped to the whole table: `stock_balances.qty_on_hand` ≡ Σ signed `stock_movements` for every key. Returns the count of mismatching keys (0 = invariant holds). */
export async function countInvariantMismatches(client: PoolClient): Promise<number> {
  const res = await client.query<{ mismatches: string }>(
    `SELECT count(*)::int AS mismatches FROM (
       SELECT b.location_id, b.storage_area_id, b.item_id, b.qty_on_hand,
              COALESCE(
                (SELECT SUM(CASE WHEN m.movement_type LIKE '%_out' THEN -m.qty ELSE m.qty END)
                   FROM stock_movements m
                  WHERE m.location_id = b.location_id AND m.storage_area_id = b.storage_area_id AND m.item_id = b.item_id),
                0
              ) AS expected
         FROM stock_balances b
     ) x
     WHERE qty_on_hand <> expected`,
  );
  return Number(res.rows[0]?.mismatches ?? 0);
}

/**
 * Same G1 invariant, but scoped to ONLY the `(location, area, item)` keys named — a
 * "delta this suite owns" check rather than a whole-table one (B-05, PROGRESS.md).
 *
 * `countInvariantMismatches` reads the ENTIRE `stock_balances` table, which makes it
 * provable that THIS suite left no mark only when nothing ELSE writes to the table
 * during the run. That is false in the shared dev/CI database: other integration
 * suites self-commit real rows (`withCommit`/`withWrite` callers across other
 * modules), and — per the house rule this suite runs under — three other agents may
 * be running their own backend suites against the SAME Postgres concurrently. A
 * whole-table check then fails on somebody else's transient or genuinely-unbalanced
 * state, not on anything this file did. Real per-agent schema isolation (D-01) is the
 * complete fix; scoping the query to just the keys THIS file's own tests picked
 * (via `pickUnusedStockKey`/`pickUnusedTransferFixture`, which every call site here
 * already tracks) is the cheap one — it verifies exactly the claim the test makes
 * ("nothing I touched is left mismatched") without asserting anything about keys
 * this suite never went near.
 */
export async function countInvariantMismatchesForKeys(
  client: PoolClient,
  keys: readonly StockFixtureKey[],
): Promise<number> {
  if (keys.length === 0) return 0;
  const res = await client.query<{ mismatches: string }>(
    `SELECT count(*)::int AS mismatches FROM (
       SELECT b.location_id, b.storage_area_id, b.item_id, b.qty_on_hand,
              COALESCE(
                (SELECT SUM(CASE WHEN m.movement_type LIKE '%_out' THEN -m.qty ELSE m.qty END)
                   FROM stock_movements m
                  WHERE m.location_id = b.location_id AND m.storage_area_id = b.storage_area_id AND m.item_id = b.item_id),
                0
              ) AS expected
         FROM stock_balances b
        WHERE (b.location_id, b.storage_area_id, b.item_id) IN (
                SELECT * FROM unnest($1::uuid[], $2::uuid[], $3::uuid[])
              )
     ) x
     WHERE qty_on_hand <> expected`,
    [keys.map((k) => k.locationId), keys.map((k) => k.storageAreaId), keys.map((k) => k.itemId)],
  );
  return Number(res.rows[0]?.mismatches ?? 0);
}
