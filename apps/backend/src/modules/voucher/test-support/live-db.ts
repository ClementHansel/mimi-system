import { Pool, type PoolClient } from 'pg';

/**
 * Live-DB harness for the voucher module's integration suite — the same
 * two-pool split as `modules/delivery/test-support/live-db.ts` and
 * `modules/inventory/test-support/live-db.ts` (D-21/D-22: a single shared
 * superuser connection string is exactly how RLS got silently bypassed once,
 * and how a module can ship green tests against zero working endpoints).
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (superuser, `BYPASSRLS`).
 *    Fixture setup/teardown ONLY: minting the batch and coupon a test races
 *    on, and deleting them afterwards. Never used to run code under test.
 *  - `getAppPool()` — `DATABASE_URL` (the runtime `mimi_app` role, the SAME
 *    identity `DATABASE_POOL` uses in production). Every service call runs
 *    against a `PoolClient` from THIS pool, under the same
 *    `SET LOCAL ROLE app_user` + session-var sequence `RlsContextGuard`
 *    issues for a real request.
 *
 * WHY THIS MODULE NEEDS TWO SIMULTANEOUS APP CONNECTIONS, unlike most of the
 * harnesses it is copied from: the thing under test is a RACE. The
 * double-spend guard is a unique index, and a unique index can only be
 * demonstrated by two transactions that are both open at the same instant.
 * One connection running two statements in sequence proves nothing — the
 * second would simply see the first's committed row. Hence
 * `withTwoRacingTransactions` below, which is the only reason this file is
 * not a verbatim copy of delivery's.
 */

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

/** Fixture setup/teardown ONLY — never construct a service under test against this pool. */
export function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool the code under test runs against — same identity (`mimi_app`) as production. */
export function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

export async function closePools(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}

export interface RlsCtx {
  role: string;
  userId: string;
  locationIds: readonly string[] | null;
}

const SYSTEM_CONTEXT_USER_ID = '00000000-0000-0000-0000-0000000000ad';
export const CENTRAL_CTX: RlsCtx = {
  role: 'owner',
  userId: SYSTEM_CONTEXT_USER_ID,
  locationIds: null,
};

async function openScoped(ctx: RlsCtx): Promise<PoolClient> {
  const client = await getAppPool().connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [ctx.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [ctx.role]);
  await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
    ctx.locationIds === null ? '' : ctx.locationIds.join(','),
  ]);
  return client;
}

/** Runs `fn` against a fresh `mimi_app` connection in a transaction that is ALWAYS rolled back. */
export async function withRollback<T>(
  fn: (client: PoolClient) => Promise<T>,
  ctx: RlsCtx = CENTRAL_CTX,
): Promise<T> {
  const client = await openScoped(ctx);
  try {
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * TWO genuinely concurrent `mimi_app` transactions, both open at once — the
 * only shape in which a unique-index race is real rather than simulated.
 *
 * `a` and `b` are each given their own connection with its own `BEGIN` and its
 * own RLS session vars. Both are committed if the callback returns and rolled
 * back if it throws; the caller is responsible for cleaning up whatever
 * committed (fixtures are deleted by the suite's `afterAll` through the owner
 * pool, since a redemption row that committed is by definition not rolled
 * back).
 *
 * NOTE ON ORDERING: the second inserter BLOCKS on the unique index until the
 * first transaction commits or rolls back — that is Postgres's behaviour for a
 * conflicting unique key, not a race this helper has to arrange. So a test
 * must commit or roll back `a` before awaiting `b`'s insert, or the two will
 * deadlock on each other and hit the suite timeout. The suite does exactly
 * that and says so at the call site.
 */
export async function withTwoRacingTransactions<T>(
  fn: (a: PoolClient, b: PoolClient) => Promise<T>,
  ctx: RlsCtx = CENTRAL_CTX,
): Promise<T> {
  const a = await openScoped(ctx);
  const b = await openScoped(ctx);
  try {
    return await fn(a, b);
  } finally {
    await a.query('ROLLBACK').catch(() => {});
    await b.query('ROLLBACK').catch(() => {});
    a.release();
    b.release();
  }
}
