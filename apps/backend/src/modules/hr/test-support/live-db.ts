import { Pool, type PoolClient } from 'pg';
import { RoleKey } from '@mimi/shared';
import type { JwtAccessPayload } from '../../../common/jwt/jwt-payload.interface';

/**
 * Live-DB integration harness for M14 `hr` — copies the two-pool pattern
 * from `kernel/approvals/test-support/live-db.ts` (per the ticket's
 * instruction) rather than inventing a third variant:
 *
 *  - `getOwnerPool()` — `DATABASE_MIGRATION_URL` (superuser, `BYPASSRLS`).
 *    Fixture setup/read ONLY — never construct a service under test against it.
 *  - `getAppPool()` — `DATABASE_URL` (the `mimi_app` runtime identity,
 *    D-21/D-22). Every `AttendanceService`/`LeavesService`/`EmployeesService`/
 *    `ShiftsService` call in the integration suite runs against a
 *    `PoolClient` from THIS pool with the exact `SET LOCAL ROLE app_user` +
 *    `set_config(...)` sequence `RlsContextGuard` issues per real request —
 *    so RLS (the `employees_scope`/`attendance_scope`/`leave_requests_scope`/
 *    `shift_assignments_scope` policies) is actually exercised, not bypassed.
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

/**
 * Runs `fn` against a fresh `mimi_app` connection under the SAME RLS session
 * context `RlsContextGuard` sets per real request, for the given user — then
 * ALWAYS rolls back, so nothing the code under test writes (attendance,
 * leave_requests, employees, work_shifts, shift_assignments, approvals,
 * settings) ever persists across tests.
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
 * transaction-local, same as `RlsContextGuard` itself uses) — for tests that
 * need to simulate a MULTI-ACTOR flow (an employee submits, a DIFFERENT
 * supervisor decides) inside one rolled-back transaction, since a second,
 * separate `withRollbackAs` call would roll back and lose the first actor's
 * not-yet-committed writes before the second actor could see them. A real
 * request never does this (each actor gets their OWN transaction against
 * COMMITTED prior state) — this is a test-harness convenience for exercising
 * both actors' RLS perspectives without a slower commit/reconnect dance.
 */
export async function setRlsContext(client: PoolClient, user: RlsUser): Promise<void> {
  await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.userId]);
  await client.query(`SELECT set_config('app.role', $1, true)`, [user.roleKey]);
  await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
    user.locationIds ? user.locationIds.join(',') : '',
  ]);
}

export interface RlsUser {
  userId: string;
  roleKey: RoleKey;
  /** `null`/omitted = central role (unrestricted, matches `ScopeService`). */
  locationIds?: string[];
}

export function toJwtPayload(user: RlsUser, username = 'test-user'): JwtAccessPayload {
  return { sub: user.userId, username, roleKey: user.roleKey, locationIds: user.locationIds ?? [] };
}

export interface HrFixtures {
  outletId: string;
  outletLat: number;
  outletLng: number;
  outletRadiusM: number;
  /** A real employee row + its login user, role, and home location — every seeded role that has one. */
  usersByRole: Partial<Record<RoleKey, { userId: string; employeeId: string; locationId: string }>>;
  attachmentId: string;
}

/** Reads real seeded rows over the OWNER pool — never inserts master data (W1-C's territory). */
export async function loadHrFixtures(): Promise<HrFixtures> {
  const pool = getOwnerPool();

  const outlet = await pool.query<{ id: string; latitude: string; longitude: string; geofence_radius_m: number }>(
    `SELECT id, latitude, longitude, geofence_radius_m FROM locations WHERE type = 'outlet' AND latitude IS NOT NULL LIMIT 1`,
  );
  const outletRow = outlet.rows[0];
  if (!outletRow) throw new Error('Seed data has no outlet with a geofence center configured.');

  const attachment = await pool.query<{ id: string }>('SELECT id FROM attachments LIMIT 1');
  if (!attachment.rows[0]) throw new Error('Seed data has no attachments — required as a stand-in selfie reference.');

  const usersByRole: HrFixtures['usersByRole'] = {};
  for (const roleKey of Object.values(RoleKey)) {
    const res = await pool.query<{ user_id: string; employee_id: string; location_id: string }>(
      `SELECT u.id AS user_id, e.id AS employee_id, e.location_id
         FROM employees e
         JOIN users u ON u.id = e.user_id
         JOIN roles r ON r.id = u.role_id
        WHERE r.key = $1 AND e.location_id = $2
        LIMIT 1`,
      [roleKey, outletRow.id],
    );
    if (res.rows[0]) {
      usersByRole[roleKey] = {
        userId: res.rows[0].user_id,
        employeeId: res.rows[0].employee_id,
        locationId: res.rows[0].location_id,
      };
    }
  }

  return {
    outletId: outletRow.id,
    outletLat: Number(outletRow.latitude),
    outletLng: Number(outletRow.longitude),
    outletRadiusM: outletRow.geofence_radius_m,
    usersByRole,
    attachmentId: attachment.rows[0].id,
  };
}

/** A DIFFERENT employee at the SAME outlet — proves RLS is self-only, not location-wide, for a Kasir. */
export async function loadCoworkerEmployeeId(locationId: string, excludeEmployeeId: string): Promise<string | null> {
  const res = await getOwnerPool().query<{ id: string }>(
    `SELECT id FROM employees WHERE location_id = $1 AND id <> $2 LIMIT 1`,
    [locationId, excludeEmployeeId],
  );
  return res.rows[0]?.id ?? null;
}

/** A second outlet's kasir — used to prove RLS isolation (a Kasir sees only their OWN outlet's rows). */
export async function loadOtherOutletKasir(excludeOutletId: string): Promise<{ userId: string; employeeId: string; locationId: string } | null> {
  const pool = getOwnerPool();
  const res = await pool.query<{ user_id: string; employee_id: string; location_id: string }>(
    `SELECT u.id AS user_id, e.id AS employee_id, e.location_id
       FROM employees e
       JOIN users u ON u.id = e.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE r.key = 'kasir' AND e.location_id <> $1
      LIMIT 1`,
    [excludeOutletId],
  );
  return res.rows[0] ? { userId: res.rows[0].user_id, employeeId: res.rows[0].employee_id, locationId: res.rows[0].location_id } : null;
}

/**
 * Fixture rows in tables THIS agent owns, written over the OWNER pool so
 * they exist as committed rows visible to the SEPARATE app-pool transaction
 * under test (a different Postgres backend cannot see another backend's
 * uncommitted rows) — same reasoning as `kernel/approvals/test-support`'s
 * header comment, applied to a same-owner module's own shift tables instead
 * of a foreign one. Always paired with the matching `deleteX` in a `finally`.
 */
export async function createWorkShift(
  locationId: string,
  startTime: string,
  endTime: string,
  breakMinutes = 0,
): Promise<string> {
  const res = await getOwnerPool().query<{ id: string }>(
    `INSERT INTO work_shifts (location_id, name, start_time, end_time, break_minutes)
     VALUES ($1, 'Test Shift', $2, $3, $4) RETURNING id`,
    [locationId, startTime, endTime, breakMinutes],
  );
  return res.rows[0]!.id;
}

export async function deleteWorkShift(id: string): Promise<void> {
  await getOwnerPool().query('DELETE FROM shift_assignments WHERE work_shift_id = $1', [id]);
  await getOwnerPool().query('DELETE FROM work_shifts WHERE id = $1', [id]);
}

export async function assignShift(employeeId: string, workShiftId: string, locationId: string, date: string, assignedBy: string): Promise<void> {
  await getOwnerPool().query(
    `INSERT INTO shift_assignments (employee_id, work_shift_id, location_id, date, assigned_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (employee_id, date) DO UPDATE SET work_shift_id = $2`,
    [employeeId, workShiftId, locationId, date, assignedBy],
  );
}

/** Deletes any real attendance row for (employee, date) OVER THE OWNER POOL, restored automatically because the caller only ever reads it back inside a rolled-back app-pool transaction that never commits this deletion itself — used to give a test a clean slate when seed data already has today's punch. Since this runs on a genuinely separate connection/transaction that DOES commit, tests that use it must recreate what they delete via the same owner pool in a `finally`. */
export async function deleteAttendanceForDate(employeeId: string, date: string): Promise<Record<string, any> | null> {
  const existing = await getOwnerPool().query('SELECT * FROM attendance WHERE employee_id = $1 AND date = $2', [employeeId, date]);
  if (existing.rows.length === 0) return null;
  await getOwnerPool().query('DELETE FROM attendance WHERE employee_id = $1 AND date = $2', [employeeId, date]);
  return existing.rows[0];
}

export async function restoreAttendanceRow(row: Record<string, any>): Promise<void> {
  const cols = Object.keys(row);
  const values = cols.map((c) => row[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(',');
  await getOwnerPool().query(`INSERT INTO attendance (${cols.join(',')}) VALUES (${placeholders})`, values);
}

let seq = 0;
export function nextClientId(): string {
  seq += 1;
  // Deterministic-looking but unique-enough UUID-shaped string for test idempotency keys.
  return `00000000-0000-4000-8000-${String(Date.now()).slice(-6)}${String(seq).padStart(6, '0')}`;
}
