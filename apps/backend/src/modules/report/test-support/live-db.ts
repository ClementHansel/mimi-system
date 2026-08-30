import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';

/**
 * Live-DB test harness for `modules/report`'s integration suite — copied
 * from `kernel/approvals/test-support/live-db.ts` per the ticket instruction
 * ("copy into `apps/backend/src/modules/report/test-support/live-db.ts`,
 * adapted to your fixtures"), then adapted: `loadReportFixtures()` below
 * replaces that file's `loadFixtures()`/`Fixtures` with the REAL rows this
 * module's own report endpoints need (real sales/shifts/employees/payroll/
 * opname ids — never invented UUIDs), and the fixture-row helpers
 * (`createStockOpname`, etc.) are dropped entirely: this module never
 * writes, so it has no mutation fixtures to seed/clean up.
 *
 * TWO POOLS, DELIBERATELY (same D-21/D-22 rationale as the file this was
 * copied from): `getOwnerPool()` (superuser, `DATABASE_MIGRATION_URL`) is
 * FIXTURE READING ONLY — real seeded ids, never written to. `getAppPool()`
 * (`mimi_app`, `DATABASE_URL`) is the identity every real request's
 * `RlsContextGuard` uses; `withRollbackAs` reproduces its exact `SET LOCAL
 * ROLE app_user` + `set_config(...)` session setup so report queries in this
 * suite run under the SAME RLS enforcement a real request gets.
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

/** Fixture READING ONLY — never construct a report service against this pool. */
function getOwnerPool(): Pool {
  ownerPool ??= new Pool({ connectionString: OWNER_URL, max: 5 });
  return ownerPool;
}

/** The pool the code under test runs against — same identity (`mimi_app`) as production `DATABASE_POOL`. */
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
  /** `[]` = unrestricted for central roles; for a scoped role this MUST be the location(s) that role is actually assigned. */
  locationIds: readonly string[];
}

/**
 * Runs `fn` against a fresh `mimi_app` connection inside a transaction that
 * is ALWAYS rolled back at the end — this module's own services never
 * write, so nothing here needs cleanup beyond ending the transaction.
 * Reproduces the identical `SET LOCAL ROLE app_user` + `set_config(...)`
 * sequence `RlsContextGuard` issues for every real request.
 */
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
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
      ctx.locationIds.join(','),
    ]);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

export interface RoleFixture {
  userId: string;
  /** This role's real `user_locations` grants (empty for a central role — `[]`, not `null`, matches `RlsSessionContext.locationIds`). */
  locationIds: string[];
}

export interface ReportFixtures {
  usersByRole: Partial<Record<RoleKey, RoleFixture>>;
  /** A real outlet a Supervisor fixture (if one exists) IS assigned to. */
  outletInScope: string | null;
  /** A real outlet DIFFERENT from every location the Supervisor fixture is assigned to — for the out-of-scope 403 proof. */
  outletOutOfScope: string | null;
  outletCity: string | null;
  /** A real `pos_shifts.id` located at `outletInScope`. */
  shiftIdInScope: string | null;
  /** A real `pos_shifts.id` located at `outletOutOfScope` — for the "scoped role, out-of-scope target" 403 proof. */
  shiftIdOutOfScope: string | null;
  /** A real `employees.id` (+ its location) whose `location_id` is `outletInScope`. */
  employeeIdInScope: string | null;
  /** A real `payroll_runs.id`, if the seed created one (payroll may not be seeded in every environment). */
  payrollRunId: string | null;
  /** A real `stock_opname.id` located at `outletInScope`, if the seed created one. */
  opnameIdInScope: string | null;
  /** A `'YYYY-MM-DD'` that has at least one row in `surat_jalan.planned_date`, if any exist. */
  deliveryPlannedDate: string | null;
  /** A `'YYYY-MM'` covering at least one real `attendance` row, for the attendance-matrix report. */
  attendancePeriodCode: string;
}

/**
 * Reads real seeded rows over the OWNER pool — never inserts (this module's
 * services are read-only, so its tests need no mutation fixtures either).
 * Every id below is a REAL row queried from the live, seeded database
 * (seed: 418 sales across 20 outlets, 130 employees, per the ticket) —
 * never an invented UUID.
 */
export async function loadReportFixtures(): Promise<ReportFixtures> {
  const pool = getOwnerPool();

  const usersByRole = {} as Partial<Record<RoleKey, RoleFixture>>;
  for (const roleKey of Object.values(RoleKey)) {
    const userRes = await pool.query<{ id: string }>(
      `SELECT u.id FROM users u
         JOIN roles r ON r.id = u.role_id
        WHERE r.key = ANY($1::text[])
        ORDER BY array_position($1::text[], r.key),
                   EXISTS (SELECT 1 FROM user_locations ul WHERE ul.user_id = u.id),
                   u.username
        LIMIT 1`,
      [roleKey === 'leader_outlet' ? ['koki', 'kasir'] : [roleKey]],
    );
    if (!userRes.rows[0]) continue;
    const userId = userRes.rows[0].id;
    const locRes = await pool.query<{ location_id: string }>(
      `SELECT location_id FROM user_locations WHERE user_id = $1`,
      [userId],
    );
    usersByRole[roleKey] = { userId, locationIds: locRes.rows.map((r) => r.location_id) };
  }

  const supervisor = usersByRole[RoleKey.SUPERVISOR];
  const outletInScope = supervisor?.locationIds[0] ?? null;

  let outletOutOfScope: string | null = null;
  let outletCity: string | null = null;
  if (outletInScope) {
    const cityRes = await pool.query<{ city: string }>(`SELECT city FROM locations WHERE id = $1`, [
      outletInScope,
    ]);
    outletCity = cityRes.rows[0]?.city ?? null;

    const otherRes = await pool.query<{ id: string }>(
      `SELECT id FROM locations WHERE type = 'outlet' AND id != $1 AND id NOT IN (SELECT location_id FROM user_locations WHERE user_id = $2) LIMIT 1`,
      [outletInScope, supervisor!.userId],
    );
    outletOutOfScope = otherRes.rows[0]?.id ?? null;
  }

  let shiftIdInScope: string | null = null;
  if (outletInScope) {
    const shiftRes = await pool.query<{ id: string }>(
      `SELECT id FROM pos_shifts WHERE location_id = $1 ORDER BY opened_at DESC LIMIT 1`,
      [outletInScope],
    );
    shiftIdInScope = shiftRes.rows[0]?.id ?? null;
  }
  let shiftIdOutOfScope: string | null = null;
  if (outletOutOfScope) {
    const shiftRes = await pool.query<{ id: string }>(
      `SELECT id FROM pos_shifts WHERE location_id = $1 ORDER BY opened_at DESC LIMIT 1`,
      [outletOutOfScope],
    );
    shiftIdOutOfScope = shiftRes.rows[0]?.id ?? null;
  }

  let employeeIdInScope: string | null = null;
  if (outletInScope) {
    const empRes = await pool.query<{ id: string }>(
      `SELECT id FROM employees WHERE location_id = $1 LIMIT 1`,
      [outletInScope],
    );
    employeeIdInScope = empRes.rows[0]?.id ?? null;
  }

  const payrollRes = await pool.query<{ id: string }>(
    `SELECT id FROM payroll_runs ORDER BY created_at DESC LIMIT 1`,
  );
  const payrollRunId = payrollRes.rows[0]?.id ?? null;

  let opnameIdInScope: string | null = null;
  if (outletInScope) {
    const opnameRes = await pool.query<{ id: string }>(
      `SELECT id FROM stock_opname WHERE location_id = $1 LIMIT 1`,
      [outletInScope],
    );
    opnameIdInScope = opnameRes.rows[0]?.id ?? null;
  }

  const deliveryRes = await pool.query<{ planned_date: string }>(
    `SELECT to_char(planned_date, 'YYYY-MM-DD') AS planned_date FROM surat_jalan ORDER BY planned_date DESC LIMIT 1`,
  );
  const deliveryPlannedDate = deliveryRes.rows[0]?.planned_date ?? null;

  const attRes = await pool.query<{ period: string }>(
    `SELECT to_char(date, 'YYYY-MM') AS period FROM attendance ORDER BY date DESC LIMIT 1`,
  );
  const attendancePeriodCode = attRes.rows[0]?.period ?? new Date().toISOString().slice(0, 7);

  return {
    usersByRole,
    outletInScope,
    outletOutOfScope,
    outletCity,
    shiftIdInScope,
    shiftIdOutOfScope,
    employeeIdInScope,
    payrollRunId,
    opnameIdInScope,
    deliveryPlannedDate,
    attendancePeriodCode,
  };
}
