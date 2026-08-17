import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';

/**
 * Live-DB integration harness for M15 `payroll` — copies the two-pool
 * pattern from `kernel/approvals/test-support/live-db.ts` (per the ticket's
 * instruction) rather than inventing a fourth variant. See that file's
 * header for the full rationale; the short version: `getAppPool()` runs the
 * REAL `SET LOCAL ROLE app_user` + `set_config(...)` sequence
 * `RlsContextGuard` issues per request, so the suite exercises actual
 * RLS-enforced payroll queries, not a superuser bypass wearing a test's
 * clothing. `getOwnerPool()` is fixture setup/read only.
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

export interface RlsUser {
  userId: string;
  roleKey: RoleKey;
  locationIds?: string[];
}

/**
 * Runs `fn` against a fresh `mimi_app` connection under the SAME RLS session
 * context `RlsContextGuard` sets per real request, then ALWAYS rolls back.
 * Every fixture insert (attendance, loans, cash-variance proposals, payroll
 * rows) happens on THIS SAME client/transaction — payroll's own calculation
 * mutates rows across many tables it does not own (attendance,
 * employee_loans, cash_variance_proposals) in a single request transaction
 * anyway, so a single rolled-back transaction is sufficient here (unlike
 * `kernel/approvals`/`hr`'s harnesses, which need cross-transaction
 * durability for OWNER-pool fixtures read back by a SEPARATE app-pool
 * transaction under test).
 */
export async function withRollbackAs<T>(user: RlsUser, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await setRlsContext(client, user);
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/**
 * Switches the RLS identity MID-transaction (still `set_config(..., true)` —
 * transaction-local, same mechanism `RlsContextGuard` itself uses) — for a
 * test whose whole point is a MULTI-ACTOR flow (Finance decides step 1,
 * Owner decides step 2 of the SAME payroll run) inside one rolled-back
 * transaction. A real request never does this (each actor gets their own
 * transaction via their own `RlsContextGuard`-driven session against
 * already-committed prior state) — this is a test-harness convenience,
 * matching `modules/hr/test-support/live-db.ts`'s identical helper.
 */
export async function setRlsContext(client: PoolClient, user: RlsUser): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [user.roleKey]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [(user.locationIds ?? []).join(',')]);
}

export interface PayrollFixtures {
  employeeId: UUID_;
  employeeUserId: string;
  locationId: string;
  usersByRole: Partial<Record<RoleKey, string>>;
}
type UUID_ = string;

/** Reads real seeded rows over the OWNER pool — never inserts master data (another agent's territory). */
export async function loadPayrollFixtures(): Promise<PayrollFixtures> {
  const pool = getOwnerPool();

  const empRes = await pool.query<{ id: string; user_id: string | null; location_id: string }>(
    `SELECT e.id, e.user_id, e.location_id FROM employees e
       JOIN employments em ON em.employee_id = e.id AND em.end_date IS NULL
      WHERE e.employment_status = 'active' AND e.user_id IS NOT NULL LIMIT 1`,
  );
  if (!empRes.rows[0]) throw new Error('Seed data has no active employee with a linked user and open employment row.');

  const usersByRole: Partial<Record<RoleKey, string>> = {};
  for (const roleKey of Object.values(RoleKey)) {
    const res = await pool.query<{ id: string }>('SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key = $1 LIMIT 1', [roleKey]);
    if (res.rows[0]) usersByRole[roleKey] = res.rows[0].id;
  }

  return {
    employeeId: empRes.rows[0].id,
    employeeUserId: empRes.rows[0].user_id!,
    locationId: empRes.rows[0].location_id,
    usersByRole,
  };
}
