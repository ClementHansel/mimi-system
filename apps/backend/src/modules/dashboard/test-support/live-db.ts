import { Pool, type PoolClient } from 'pg';

/**
 * Live-DB test harness for M18 `dashboard`, copied from the canonical
 * two-pool pattern (`kernel/approvals/test-support/live-db.ts`) and adapted:
 * this module's fixtures are pure READS over the real seed (20 outlets, 418
 * sales, 130 employees) — there is nothing for this module to insert/delete,
 * so only the "OWNER pool for fixture reads / APP pool under RLS for the
 * code under test" half of that pattern applies here.
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

function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

function getAppPool(): Pool {
  appPool ??= new Pool({ connectionString: APP_URL, max: 5 });
  return appPool;
}

export async function closePool(): Promise<void> {
  await ownerPool?.end();
  await appPool?.end();
  ownerPool = undefined;
  appPool = undefined;
}

export interface RlsSessionContext {
  role: string;
  userId: string;
  locationIds: readonly string[];
}

/** Same session-setup contract `RlsContextGuard` asserts per real request — see the approvals harness's doc comment for the full rationale. */
export async function withRollbackAs<T>(
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

export interface DashboardFixtures {
  ownerUserId: string;
  /** A real Supervisor with a real `user_locations` assignment to exactly one outlet that has seeded sales. */
  supervisorUserId: string;
  supervisorOutletId: string;
  supervisorOutletName: string;
  /** A second real outlet, different from the supervisor's own, that also has seeded sales — for the "cannot see outside scope" / "aggregate > single outlet" assertions. */
  otherOutletId: string;
}

/** Reads real seeded rows only — never inserts. */
export async function loadDashboardFixtures(): Promise<DashboardFixtures> {
  const pool = getOwnerPool();

  const owner = await pool.query<{ id: string }>(
    `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = 'owner' AND u.is_active LIMIT 1`,
  );

  // A Supervisor whose assigned outlet actually has at least one completed sale, so the
  // "sees only their own figures" assertion is checking a non-trivial (non-zero) number.
  const supervisor = await pool.query<{
    user_id: string;
    location_id: string;
    location_name: string;
  }>(
    `SELECT ul.user_id, ul.location_id, l.name AS location_name
       FROM user_locations ul
       JOIN users u ON u.id = ul.user_id
       JOIN roles r ON r.id = u.role_id
       JOIN locations l ON l.id = ul.location_id
      WHERE r.key = 'supervisor' AND u.is_active
        AND EXISTS (SELECT 1 FROM sales s WHERE s.location_id = ul.location_id AND s.status = 'completed')
      LIMIT 1`,
  );

  const other = await pool.query<{ id: string }>(
    `SELECT DISTINCT s.location_id AS id
       FROM sales s
      WHERE s.status = 'completed' AND s.location_id <> $1
      LIMIT 1`,
    [supervisor.rows[0]?.location_id ?? '00000000-0000-0000-0000-000000000000'],
  );

  if (!owner.rows[0] || !supervisor.rows[0] || !other.rows[0]) {
    throw new Error(
      'Seed data is missing a required fixture (owner user / supervisor with sales at their outlet / a second outlet with sales) — fixtures require the full seed to have run.',
    );
  }

  return {
    ownerUserId: owner.rows[0].id,
    supervisorUserId: supervisor.rows[0].user_id,
    supervisorOutletId: supervisor.rows[0].location_id,
    supervisorOutletName: supervisor.rows[0].location_name,
    otherOutletId: other.rows[0].id,
  };
}

/** Independent oracle: total completed-sale revenue for one location, read straight off `sales` (NOT the matview under test) via the owner pool. */
export async function rawRevenueForLocation(locationId: string): Promise<string> {
  const res = await getOwnerPool().query<{ total: string }>(
    `SELECT COALESCE(SUM(total), 0)::text AS total FROM sales WHERE location_id = $1 AND status = 'completed'`,
    [locationId],
  );
  return res.rows[0]!.total;
}

/** Independent oracle: total completed-sale revenue across EVERY location. */
export async function rawRevenueCompanyWide(): Promise<string> {
  const res = await getOwnerPool().query<{ total: string }>(
    `SELECT COALESCE(SUM(total), 0)::text AS total FROM sales WHERE status = 'completed'`,
  );
  return res.rows[0]!.total;
}

/**
 * Independent oracle matching `OverviewService`'s own `revenue` definition
 * EXACTLY (POS `sales.total` for completed sales PLUS online
 * `online_orders.net_received` for completed orders, over `[from,to]`
 * inclusive WITA calendar dates) — computed straight off the BASE tables,
 * never the matview under test, so a bug that only exists in
 * `mv_sales_daily`'s own SELECT body cannot hide from this assertion.
 * `locationId` narrows to one outlet; omit for the company-wide total.
 */
export async function rawRevenueForRange(
  from: string,
  to: string,
  locationId?: string,
): Promise<string> {
  const pool = getOwnerPool();
  const posArgs: unknown[] = [from, to];
  let posWhere = '';
  if (locationId) {
    posArgs.push(locationId);
    posWhere = ` AND location_id = $3`;
  }
  const pos = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(total), 0)::text AS total FROM sales
      WHERE status = 'completed' AND (occurred_at AT TIME ZONE 'Asia/Makassar')::date BETWEEN $1 AND $2 ${posWhere}`,
    posArgs,
  );

  const onlineArgs: unknown[] = [from, to];
  let onlineWhere = '';
  if (locationId) {
    onlineArgs.push(locationId);
    onlineWhere = ` AND location_id = $3`;
  }
  const online = await pool.query<{ total: string }>(
    `SELECT COALESCE(SUM(net_received), 0)::text AS total FROM online_orders
      WHERE status = 'completed' AND order_date BETWEEN $1 AND $2 ${onlineWhere}`,
    onlineArgs,
  );

  return (Number(pos.rows[0]!.total) + Number(online.rows[0]!.total)).toFixed(2);
}

/**
 * Refreshes the four dashboard matviews over the OWNER pool, so these tests
 * assert against a rollup that matches the tables.
 *
 * Refreshing as the owner is deliberate and is NOT the production path — that is
 * `MatviewRefreshService`, which goes through `refresh_dashboard_matview()`
 * (migration 219) and is covered by `matview-refresh.integration.spec.ts`. What
 * matters here is that both paths only work while the views remain owned by the
 * DDL role: a refresh applies the RLS of the view's OWNER, so transferring them
 * to `app_user` makes BOTH of these produce empty rollups — this helper included,
 * superuser or not. Migration 236 asserts that ownership.
 */
export async function refreshMatviewsAsOwner(): Promise<void> {
  const pool = getOwnerPool();
  for (const view of ['mv_sales_daily', 'mv_item_usage_daily', 'mv_employee_kpi_daily']) {
    await pool.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
  }
}
