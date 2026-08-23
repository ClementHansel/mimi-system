import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { RlsContextGuard, RequestWithDbContext } from './rls-context.guard';
import { ScopeService } from '../scope/scope.service';

/**
 * "A manager runs several branches" — the owner's org, enforced (migration 235).
 *
 * Two managers over two regions were written into `user_locations` and the rows
 * did nothing: a day simulation had manager2 reading 50 rows of Balikpapan's
 * sales while their region is Banjarmasin + Pontianak. `app_is_central()`
 * returned true for `manager`, so assigning branches LOOKED like scoping and was
 * decoration. This file is the test that could not have stayed green through
 * that, and the one that stops it coming back.
 *
 * It builds its own two managers rather than using the seeded ones, because the
 * behaviour is conditional and both halves matter:
 *
 *   - a manager with NO branches assigned is company-wide (which is what
 *     `seed.ts` produces, and why this migration changed nothing for existing
 *     environments or for the rest of the suite);
 *   - a manager WITH branches is confined to them.
 *
 * Real pool, real `RlsContextGuard`, real `ScopeService`, no hand-issued
 * `SET ROLE` — same two-pool discipline as the RLS-bypass regression next door:
 * `appPool` (`mimi_app`) is the only thing the code under test touches, and
 * `ownerPool` is scaffolding and oracle only.
 *
 * The fixture users are COMMITTED rather than rolled back, because the guard
 * opens its own connection: a user created inside this file's transaction would
 * not exist as far as the guard is concerned. `afterAll` removes them.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.DATABASE_MIGRATION_URL)(
  'a manager is scoped to the branches they are given (live DB, real guard)',
  () => {
    let appPool: Pool;
    let ownerPool: Pool;
    let guard: RlsContextGuard;

    let scopedManagerId: string;
    let unscopedManagerId: string;
    const suffix = randomUUID().slice(0, 8);
    const scopedUsername = `test_mgr_scoped_${suffix}`;
    const unscopedUsername = `test_mgr_unscoped_${suffix}`;

    let outletId: string;
    let outletCode: string;
    let salesAtOutlet: number;
    let salesEverywhere: number;

    beforeAll(async () => {
      appPool = new Pool({ connectionString: process.env.DATABASE_URL });
      ownerPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
      guard = new RlsContextGuard(appPool, new ScopeService(), new Reflector());

      // An outlet that actually HAS sales, or "scoped sees fewer rows" would be
      // vacuously true and this file would prove nothing.
      const outlet = await ownerPool.query<{ id: string; code: string; n: number }>(
        `SELECT l.id, l.code, count(s.id)::int AS n
           FROM locations l
           JOIN sales s ON s.location_id = l.id
          WHERE l.type = 'outlet'
          GROUP BY l.id, l.code
          ORDER BY count(s.id) DESC, l.code
          LIMIT 1`,
      );
      if (!outlet.rows[0]) {
        throw new Error('No outlet with sales — run `pnpm db:migrate && pnpm db:seed` first.');
      }
      outletId = outlet.rows[0].id;
      outletCode = outlet.rows[0].code;
      salesAtOutlet = outlet.rows[0].n;

      salesEverywhere = (
        await ownerPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM sales`)
      ).rows[0]!.n;
      // If one outlet were the whole company there would be nothing to confine.
      expect(salesAtOutlet).toBeLessThan(salesEverywhere);

      const roleId = (
        await ownerPool.query<{ id: string }>(`SELECT id FROM roles WHERE key = 'manager'`)
      ).rows[0]!.id;

      const makeManager = async (username: string): Promise<string> => {
        const res = await ownerPool.query<{ id: string }>(
          `INSERT INTO users (username, email, password_hash, name, role_id, is_active)
           VALUES ($1, $2, 'x-not-a-real-hash', $3, $4, true)
           RETURNING id`,
          [username, `${username}@example.invalid`, 'Manager Under Test', roleId],
        );
        return res.rows[0]!.id;
      };
      scopedManagerId = await makeManager(scopedUsername);
      unscopedManagerId = await makeManager(unscopedUsername);

      // The whole difference between the two: one row.
      await ownerPool.query(`INSERT INTO user_locations (user_id, location_id) VALUES ($1, $2)`, [
        scopedManagerId,
        outletId,
      ]);
    }, 30_000);

    afterAll(async () => {
      await ownerPool.query(`DELETE FROM user_locations WHERE user_id = ANY($1::uuid[])`, [
        [scopedManagerId, unscopedManagerId],
      ]);
      await ownerPool.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
        [scopedManagerId, unscopedManagerId],
      ]);
      await appPool.end();
      await ownerPool.end();
    });

    const contextFor = (request: RequestWithDbContext): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({}),
          getNext: () => ({}),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      }) as unknown as ExecutionContext;

    /** Counts what this user can actually see, through the real guard. */
    const salesVisibleTo = async (userId: string, username: string): Promise<number> => {
      const request: RequestWithDbContext = {
        // `locationIds: []` on purpose — the guard resolves the real scope from
        // `user_locations` via ScopeService. Passing a scope in would test this
        // file's arithmetic instead of the system's.
        user: { sub: userId, username, roleKey: 'manager', locationIds: [] },
      } as RequestWithDbContext;
      expect(await guard.canActivate(contextFor(request))).toBe(true);
      const client = request.dbClient!;
      try {
        const res = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM sales`);
        return res.rows[0]!.n;
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    };

    it('sees only their own region once branches are assigned', async () => {
      const visible = await salesVisibleTo(scopedManagerId, scopedUsername);
      // The exact number, not merely "fewer": a scope that leaked one extra
      // branch would still be less than the total.
      expect(visible).toBe(salesAtOutlet);
      expect(visible).toBeLessThan(salesEverywhere);
    }, 30_000);

    it('is still company-wide when no branches are assigned', async () => {
      // This is the backward-compatibility half. `seed.ts` gives its managers
      // `locations: []`, so every existing environment and every other spec in
      // this suite depends on this staying true.
      const visible = await salesVisibleTo(unscopedManagerId, unscopedUsername);
      expect(visible).toBe(salesEverywhere);
    }, 30_000);

    /**
     * The sensitive half (migration 238). 235 confined a manager on tables that
     * carry a `location_id`; the salaries, loans and leave requests live one join
     * away through `employees`, so a regional manager could not read another
     * region's SALES and could still read its people's PAY.
     *
     * Counted per table rather than in one query, so a failure names the table
     * that leaked instead of "some number was wrong".
     */
    const rowsVisibleTo = async (
      userId: string,
      username: string,
      sql: string,
    ): Promise<number> => {
      const request: RequestWithDbContext = {
        user: { sub: userId, username, roleKey: 'manager', locationIds: [] },
      } as RequestWithDbContext;
      expect(await guard.canActivate(contextFor(request))).toBe(true);
      const client = request.dbClient!;
      try {
        const res = await client.query<{ n: number }>(sql);
        return res.rows[0]!.n;
      } finally {
        await client.query('ROLLBACK').catch(() => {});
        client.release();
      }
    };

    const HR_TABLES = [
      ['employee_loans', `SELECT count(*)::int AS n FROM employee_loans`],
      ['leave_requests', `SELECT count(*)::int AS n FROM leave_requests`],
      ['payroll_lines', `SELECT count(*)::int AS n FROM payroll_lines`],
      ['employee_salary_components', `SELECT count(*)::int AS n FROM employee_salary_components`],
    ] as const;

    it("sees only their own region's HR and payroll rows", async () => {
      let scopedTotal = 0;
      let unscopedTotal = 0;

      for (const [table, sql] of HR_TABLES) {
        const scoped = await rowsVisibleTo(scopedManagerId, scopedUsername, sql);
        const unscoped = await rowsVisibleTo(unscopedManagerId, unscopedUsername, sql);
        scopedTotal += scoped;
        unscopedTotal += unscoped;

        // Per table: never MORE than the company-wide manager. Not "strictly
        // fewer" — the seed has exactly one loan, and if it happens to belong to
        // the chosen outlet then equal is the correct answer, not a leak.
        expect(
          scoped,
          `${table}: a one-outlet manager must not see more than a company-wide one`,
        ).toBeLessThanOrEqual(unscoped);
      }

      // Across all four, the confinement has to bite somewhere, or this file is
      // asserting nothing at all.
      expect(unscopedTotal, 'the seed has no HR/payroll rows to scope').toBeGreaterThan(0);
      expect(scopedTotal, 'one outlet should account for only part of the company').toBeLessThan(
        unscopedTotal,
      );
    }, 60_000);

    it('still sees the people at the branch they DO run', async () => {
      // The over-correction check. Confining a manager to nothing would satisfy
      // every assertion above.
      const n = await rowsVisibleTo(
        scopedManagerId,
        scopedUsername,
        `SELECT count(*)::int AS n FROM employees WHERE location_id = '${outletId}'`,
      );
      expect(n).toBeGreaterThan(0);
    }, 60_000);

    it('scoping is what changed, not the role: the two differ only by that one row', async () => {
      const scoped = await salesVisibleTo(scopedManagerId, scopedUsername);
      const unscoped = await salesVisibleTo(unscopedManagerId, unscopedUsername);
      expect(scoped).toBeLessThan(unscoped);
      expect(outletCode).toBeTruthy();
    }, 30_000);
  },
);
