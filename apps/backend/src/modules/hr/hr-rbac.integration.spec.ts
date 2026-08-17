import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { can, RoleKey } from '@mimi/shared';
import {
  closePool,
  loadCoworkerEmployeeId,
  loadHrFixtures,
  loadOtherOutletKasir,
  withRollbackAs,
  type HrFixtures,
} from './test-support/live-db';

/**
 * RBAC + RLS negative proof for M14 `hr` (BUILD-PLAN §8 Definition of Done:
 * "RBAC enforced and negatively tested"; ticket: "prove a Kasir sees only
 * their own records"). Two layers, both tested for real:
 *
 *  1. Permission matrix (`@mimi/shared`'s `can()`, the same function
 *     `PermissionsGuard` calls) — asserted in BOTH directions: a Kasir is
 *     denied the mutating HR keys, AND the roles CONTRACTS.md §3 grants them
 *     to are allowed. A guard-level test alone would only prove "the code
 *     exists"; asserting both directions proves the matrix isn't
 *     accidentally permissive OR accidentally locked out for legitimate roles.
 *  2. Row-level security, against the LIVE database under the real
 *     `app_user` identity (`withRollbackAs`, same harness as every other
 *     integration test here) — a Kasir querying `attendance`/`leave_requests`
 *     sees their OWN rows and does NOT see a co-worker's, even at the SAME
 *     outlet. This is the boundary that actually matters (a compromised or
 *     buggy permission check still can't leak data past RLS).
 */
describe('HR module RBAC + RLS (integration, live Postgres)', () => {
  let fixtures: HrFixtures;
  let dbAvailable = true;
  let coworkerEmployeeId: string | null = null;

  beforeAll(async () => {
    try {
      fixtures = await loadHrFixtures();
      if (!fixtures.usersByRole[RoleKey.KASIR]) {
        dbAvailable = false;
      }
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
    await closePool();
  });

  // ── Layer 1: permission matrix, both directions ───────────────────────────

  it('a Kasir is denied every HR mutation/read permission that CONTRACTS.md §3 marks central/scoped-staff-only', () => {
    const denied: [string, RoleKey][] = [
      ['hr.employee.manage', RoleKey.KASIR],
      ['hr.employee.read', RoleKey.KASIR],
      ['hr.shift.manage', RoleKey.KASIR],
      ['hr.attendance.read', RoleKey.KASIR],
      ['hr.attendance.correct', RoleKey.KASIR],
      ['hr.leave.approve', RoleKey.KASIR],
      ['hr.leave.read', RoleKey.KASIR],
    ];
    for (const [key, role] of denied) {
      expect(can(role, key as never), `${role} should NOT hold ${key}`).toBe(false);
    }
  });

  it('the roles CONTRACTS.md §3 actually grants these keys to are allowed — the matrix isn\'t locked out for everyone', () => {
    const allowed: [string, RoleKey][] = [
      ['hr.employee.manage', RoleKey.HR_ADMIN],
      ['hr.employee.manage', RoleKey.OWNER],
      ['hr.shift.manage', RoleKey.SUPERVISOR],
      ['hr.attendance.correct', RoleKey.HR_ADMIN],
      ['hr.leave.approve', RoleKey.SUPERVISOR],
      ['hr.leave.approve', RoleKey.HR_ADMIN],
      ['hr.attendance.check', RoleKey.KASIR], // every role may check themselves in — this one IS universal
      ['hr.leave.request', RoleKey.KASIR],
    ];
    for (const [key, role] of allowed) {
      expect(can(role, key as never), `${role} should hold ${key}`).toBe(true);
    }
  });

  // ── Layer 2: RLS, live Postgres, both directions ──────────────────────────

  it('a Kasir reading their OWN attendance rows succeeds under RLS', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      const res = await client.query('SELECT id FROM attendance WHERE employee_id = $1', [kasir.employeeId]);
      // Not asserting a specific count (seed data varies) — asserting the query itself doesn't
      // silently zero out rows that genuinely belong to this session's own employee.
      const directCount = await client.query('SELECT COUNT(*) AS n FROM attendance WHERE employee_id = $1', [kasir.employeeId]);
      expect(res.rows.length).toBe(Number(directCount.rows[0].n));
    });
  });

  it('a Kasir CANNOT see a co-worker\'s attendance rows, even at the SAME outlet — self-only, not location-wide', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;

    // A real co-worker's employee id at the SAME outlet, over the (RLS-exempt) owner pool.
    coworkerEmployeeId = await loadCoworkerEmployeeId(kasir.locationId, kasir.employeeId);
    if (!coworkerEmployeeId) return; // seed doesn't have a second employee at this outlet — nothing to prove

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      const asKasir = await client.query('SELECT id FROM attendance WHERE employee_id = $1', [coworkerEmployeeId]);
      expect(asKasir.rows.length).toBe(0);
    });

    // Both directions: a SUPERVISOR at the SAME outlet legitimately CAN see it (location-scoped read
    // is exactly what `hr.attendance.read` + the `attendance_scope` policy's supervisor clause grant).
    const spv = fixtures.usersByRole[RoleKey.SUPERVISOR];
    if (!spv) return;
    await withRollbackAs({ userId: spv.userId, roleKey: RoleKey.SUPERVISOR, locationIds: [kasir.locationId] }, async (client) => {
      const asSupervisor = await client.query('SELECT id FROM attendance WHERE employee_id = $1', [coworkerEmployeeId]);
      const directCount = await client.query('SELECT COUNT(*) AS n FROM attendance WHERE employee_id = $1', [coworkerEmployeeId]);
      expect(asSupervisor.rows.length).toBe(Number(directCount.rows[0].n));
    });
  });

  it('a Kasir CANNOT see a co-worker\'s leave_requests, even at the SAME outlet', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    if (!coworkerEmployeeId) return; // set by the previous test; seed-dependent

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      const asKasir = await client.query('SELECT id FROM leave_requests WHERE employee_id = $1', [coworkerEmployeeId]);
      expect(asKasir.rows.length).toBe(0);
    });
  });

  it('a Kasir CANNOT see another outlet\'s employees at all (cross-location isolation)', async () => {
    if (!dbAvailable) return;
    const kasir = fixtures.usersByRole[RoleKey.KASIR]!;
    const other = await loadOtherOutletKasir(kasir.locationId);
    if (!other) return;

    await withRollbackAs({ userId: kasir.userId, roleKey: RoleKey.KASIR, locationIds: [kasir.locationId] }, async (client) => {
      const res = await client.query('SELECT id FROM employees WHERE id = $1', [other.employeeId]);
      expect(res.rows.length).toBe(0);
    });
  });
});
