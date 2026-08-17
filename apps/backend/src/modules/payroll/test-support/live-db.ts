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

/**
 * BE-TXN-ROLLBACK: an explicit alias for `withRollbackAs` marking "this call is standing in for
 * one real HTTP request" at call sites — mirrors `stock-opname/test-support/live-db.ts`'s `asRequest`
 * of the same name. See that file's `asRequest` doc comment for the load-bearing gotcha: once a
 * service method wraps its writes in `withWrite` (real `BEGIN`...`COMMIT`), that `COMMIT` is REAL —
 * it ends the transaction this helper opened and reverts `SET LOCAL ROLE`/session GUCs with it. A
 * `withRollbackAs`/`asRequest` block may therefore contain AT MOST ONE call into a `withWrite`-wrapped
 * service method, and nothing on that same `client` may run after it (not even a read) — a
 * write-then-read-back assertion is always TWO separate connection calls.
 */
export const asRequest = withRollbackAs;

/**
 * For TEST-ONLY seed writes that must be visible to a LATER, separate `asRequest`/`withRollbackAs`
 * connection (e.g. inserting a fresh employee/employment/attendance/loan fixture row before exercising
 * a real service call on its OWN connection) — opens its own connection, asserts RLS context, runs
 * `fn`, and actually `COMMIT`s (never rolls back). Mirrors `stock-opname/test-support/live-db.ts`'s
 * `asCommittedRequest`. Use ONLY for fixture setup that isn't itself the behavior under test.
 *
 * Every row committed this way MUST be cleaned up (see `cleanupCommittedRows` below) — a real
 * `COMMIT` here means the row outlives this test process and would otherwise leak into later
 * test runs against the same live DB.
 */
export async function asCommittedRequest<T>(user: RlsUser, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getAppPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await setRlsContext(client, user);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    // A client released back to the pool mid-transaction (no ROLLBACK) stays in Postgres' "current
    // transaction is aborted" state — the NEXT caller to check it out would fail on its very first
    // query with an unrelated-looking error. Must ROLLBACK before release on the error path, exactly
    // like `withRollbackAs`'s `finally`.
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deletes rows this suite committed for real via `asCommittedRequest`/a `withWrite`-backed service
 * call, over the OWNER (superuser, RLS-bypassing) pool — so cleanup itself is never blocked by the
 * very RLS policies the test data might otherwise trip. Best-effort per statement (child-row FK
 * ordering matters here: lines/payments/lines before runs/periods/loans/employments/employees).
 */
export async function cleanupCommittedRows(opts: {
  employeeIds?: string[];
  periodIds?: string[];
  loanIds?: string[];
  posShiftIds?: string[];
}): Promise<void> {
  const pool = getOwnerPool();
  const { employeeIds = [], periodIds = [], loanIds = [], posShiftIds = [] } = opts;

  if (employeeIds.length > 0) {
    // `employee_loan_payments.payroll_line_id` and `cash_variance_proposals.payroll_line_id` both FK
    // into `payroll_lines` — both must be cleared BEFORE `payroll_lines` itself is deleted, not after.
    await pool.query('DELETE FROM employee_loan_payments WHERE loan_id IN (SELECT id FROM employee_loans WHERE employee_id = ANY($1::uuid[]))', [employeeIds]);
    await pool.query('DELETE FROM cash_variance_proposals WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM payroll_lines WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM employee_loans WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM employee_tax_profiles WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM employee_salary_components WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM attendance WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM shift_assignments WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM employments WHERE employee_id = ANY($1::uuid[])', [employeeIds]);
    await pool.query('DELETE FROM employees WHERE id = ANY($1::uuid[])', [employeeIds]);
  }
  if (loanIds.length > 0) {
    await pool.query('DELETE FROM employee_loan_payments WHERE loan_id = ANY($1::uuid[])', [loanIds]);
    await pool.query('DELETE FROM employee_loans WHERE id = ANY($1::uuid[])', [loanIds]);
  }
  if (periodIds.length > 0) {
    await pool.query(
      'DELETE FROM employee_loan_payments WHERE payroll_line_id IN (SELECT id FROM payroll_lines WHERE run_id IN (SELECT id FROM payroll_runs WHERE period_id = ANY($1::uuid[])))',
      [periodIds],
    );
    await pool.query(
      'UPDATE cash_variance_proposals SET payroll_line_id = NULL WHERE payroll_line_id IN (SELECT id FROM payroll_lines WHERE run_id IN (SELECT id FROM payroll_runs WHERE period_id = ANY($1::uuid[])))',
      [periodIds],
    );
    await pool.query('DELETE FROM payroll_lines WHERE run_id IN (SELECT id FROM payroll_runs WHERE period_id = ANY($1::uuid[]))', [periodIds]);
    // `payroll_runs.payment_verification_id` FKs INTO `payment_verifications` — clear it before the
    // referenced row can be deleted (`fk_prun_pv`).
    await pool.query('UPDATE payroll_runs SET payment_verification_id = NULL WHERE period_id = ANY($1::uuid[])', [periodIds]);
    await pool.query('DELETE FROM payment_verifications WHERE ref_id IN (SELECT id FROM payroll_runs WHERE period_id = ANY($1::uuid[]))', [periodIds]);
    await pool.query('DELETE FROM payroll_runs WHERE period_id = ANY($1::uuid[])', [periodIds]);
    await pool.query('DELETE FROM payroll_periods WHERE id = ANY($1::uuid[])', [periodIds]);
  }
  if (posShiftIds.length > 0) {
    await pool.query('DELETE FROM cash_variance_proposals WHERE shift_id = ANY($1::uuid[])', [posShiftIds]);
    await pool.query('DELETE FROM pos_shifts WHERE id = ANY($1::uuid[])', [posShiftIds]);
  }
}

/** Reads a `settings` row's current value over the owner pool — for save-then-restore-in-`finally` around a test that commits a settings change. */
export async function readSettingValue(key: string): Promise<unknown> {
  const res = await getOwnerPool().query<{ value: unknown }>('SELECT value FROM settings WHERE key = $1', [key]);
  return res.rows[0]?.value ?? null;
}

/** Commits a `settings.value` write for real, over its own connection — pair with `readSettingValue` to save/restore around a test. */
export async function setSettingValueCommitted(key: string, value: unknown): Promise<void> {
  await getOwnerPool().query(`UPDATE settings SET value = $2::jsonb WHERE key = $1`, [key, JSON.stringify(value)]);
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
