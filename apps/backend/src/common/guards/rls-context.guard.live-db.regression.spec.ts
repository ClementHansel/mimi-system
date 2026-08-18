import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { Reflector } from '@nestjs/core';
import { ExecutionContext } from '@nestjs/common';
import { RlsContextGuard, RequestWithDbContext } from './rls-context.guard';
import { ScopeService } from '../scope/scope.service';

/**
 * THE REGRESSION TEST FOR THE RLS-BYPASS INCIDENT. DO NOT DELETE AS
 * "REDUNDANT" WITH THE MOCKED SPECS IN THIS DIRECTORY — those mocks proved
 * the guard's OWN call sequence is correct; they cannot catch what actually
 * happened, because the bug was never in the guard's logic. It was that
 * `DATABASE_URL` connected as a Postgres superuser (`BYPASSRLS`), which
 * bypasses row security regardless of what session variables or `FORCE ROW
 * LEVEL SECURITY` policies are in place. Every mocked test in this
 * directory would have stayed green throughout that incident. This is the
 * one test that could not have: it connects through the REAL `pg.Pool`, the
 * REAL `RlsContextGuard`, the REAL `ScopeService` — no hand-issued
 * `SET ROLE` anywhere here — against the actual seeded database, and
 * asserts a Kasir sees only their own outlet's sales.
 *
 * TWO POOLS, DELIBERATELY, ON TWO DIFFERENT ROLES (D-21/D-22):
 *   - `appPool` (`DATABASE_URL`, role `mimi_app`) is the ONLY pool the code
 *     under test ever touches — it's what `RlsContextGuard` is constructed
 *     with, exactly as `DatabaseModule` provides it in the real app.
 *   - `ownerPool` (`DATABASE_MIGRATION_URL`, the superuser/migration role)
 *     is scaffolding ONLY: looking up seeded users by username, and the
 *     "oracle" counts this test compares the guarded result against. It
 *     never touches the guard or a guarded client.
 * This split matters because `mimi_app` is deliberately `NOINHERIT` of
 * `app_user` (migration 205) — a bare `mimi_app` connection with no
 * `SET ROLE app_user` cannot read application tables AT ALL (a hard
 * "permission denied", not a quiet 0 rows). Doing the username lookup or
 * the oracle counts on `appPool` directly would therefore fail outright,
 * for reasons that have nothing to do with what this file tests. Using the
 * owner connection for scaffolding — and ONLY for scaffolding — keeps the
 * thing actually under test running exactly the way production runs.
 *
 * Requires a reachable Postgres with migrations + seed already applied
 * (`pnpm db:migrate && pnpm db:seed`). Skips (does not fail) when either
 * `DATABASE_URL` or `DATABASE_MIGRATION_URL` is unset. CI's `build` job
 * (W1-A) now provisions both against a real postgres service and fails the
 * job outright if a `describe.skipIf` spec like this one would silently
 * skip — so from here on this either passes or goes red, never quietly
 * doesn't run.
 */
describe.skipIf(!process.env.DATABASE_URL || !process.env.DATABASE_MIGRATION_URL)(
  'RLS-BYPASS REGRESSION (live DB, real pool, real guard, no hand-issued SET ROLE): Kasir must see only their own outlet',
  () => {
    let appPool: Pool;
    let ownerPool: Pool;
    let guard: RlsContextGuard;
    let kasirUserId: string;
    let kasirOutletCode: string;

    beforeAll(async () => {
      appPool = new Pool({ connectionString: process.env.DATABASE_URL }); // mimi_app — the code under test
      ownerPool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL }); // scaffolding only

      // Look up the seeded Kasir by username rather than hardcoding a UUID —
      // robust to reseeding. On the OWNER pool: mimi_app has no standing
      // privilege to read `users` without SET ROLE, and this lookup is not
      // the thing under test.
      const userRes = await ownerPool.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'kasir1_bpp01'`,
      );
      if (!userRes.rows[0]) {
        throw new Error(
          "Seeded user 'kasir1_bpp01' not found — run `pnpm db:migrate && pnpm db:seed` before this test.",
        );
      }
      kasirUserId = userRes.rows[0].id;
      kasirOutletCode = 'BPP01';

      guard = new RlsContextGuard(appPool, new ScopeService(), new Reflector());
    });

    afterAll(async () => {
      await appPool.end();
      await ownerPool.end();
    });

    function makeContext(request: RequestWithDbContext): ExecutionContext {
      return {
        switchToHttp: () => ({
          getRequest: () => request,
          getResponse: () => ({}),
          getNext: () => ({}),
        }),
        getHandler: () => ({}),
        getClass: () => ({}),
      } as unknown as ExecutionContext;
    }

    /**
     * Protects the MECHANISM, not one instance of its effect (coordinator's
     * framing) — migration 205's whole point was turning "forgot
     * `SET LOCAL ROLE app_user`" from a silent 0-rows result into a hard
     * failure. If a future migration ever re-grants `app_user` to
     * `mimi_app` with implicit/explicit `INHERIT` again, THIS is the test
     * that goes red, independent of whatever RLS policies happen to be in
     * place at the time.
     */
    it('a bare mimi_app connection with no SET ROLE fails LOUDLY (permission denied), not silently (0 rows) — locks in migration 205 NOINHERIT', async () => {
      await expect(appPool.query('SELECT count(*) FROM sales')).rejects.toThrow(
        /permission denied/i,
      );
    });

    it('Kasir sees only their own outlet\'s sales through the real guard — proves the bypass is closed, not just that the guard "runs"', async () => {
      // Oracle values, read on the OWNER pool (no guard, no mimi_app
      // involved) — what an UNSCOPED connection sees. This is exactly the
      // shape of the original bug: if the login role bypassed RLS, a
      // Kasir's guarded session would show this same "everyone's sales"
      // number instead of just their outlet's.
      const totalRes = await ownerPool.query<{ n: string }>(`SELECT count(*)::int AS n FROM sales`);
      const outletRes = await ownerPool.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM sales s JOIN locations l ON l.id = s.location_id WHERE l.code = $1`,
        [kasirOutletCode],
      );
      const totalSales = Number(totalRes.rows[0]!.n);
      const outletSales = Number(outletRes.rows[0]!.n);

      // Sanity-check the fixture actually exercises the bug: if these were
      // equal, this test would prove nothing (every outlet's sales count
      // must be a strict subset of the total for a scoped-vs-unscoped
      // comparison to mean anything).
      expect(outletSales).toBeLessThan(totalSales);

      // THE REAL PATH: request object exactly as JwtAuthGuard would populate
      // it, then the REAL RlsContextGuard on the REAL mimi_app pool — no
      // mocks, no hand-issued `SET ROLE` anywhere in this file.
      const request: RequestWithDbContext = {
        user: { sub: kasirUserId, username: 'kasir1_bpp01', roleKey: 'kasir', locationIds: [] },
      };
      const activated = await guard.canActivate(makeContext(request));
      expect(activated).toBe(true);
      const client = request.dbClient!;

      try {
        const kasirSalesRes = await client.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM sales`,
        );
        const kasirSales = Number(kasirSalesRes.rows[0]!.n);

        console.log(
          `[RLS regression] sales visible — unscoped: ${totalSales}, ${kasirOutletCode} oracle: ${outletSales}, Kasir via real guard: ${kasirSales}`,
        );

        expect(kasirSales).toBe(outletSales); // == 64 against the current seed, not 418.
        expect(kasirSales).toBeLessThan(totalSales);

        // Column/role-gated table (CONTRACTS §1.14: ROLE(owner,manager,finance,kepala_gudang))
        // — a Kasir must see zero rows regardless of location.
        const priceHistoryRes = await client.query<{ n: string }>(
          `SELECT count(*)::int AS n FROM supplier_price_history`,
        );
        expect(Number(priceHistoryRes.rows[0]!.n)).toBe(0);
      } finally {
        // Mirrors RlsCleanupInterceptor's contract (ROLLBACK then release) —
        // also proves the role/session-var switch is transaction-scoped:
        // the next assertion below re-checks the SAME connection is back to
        // normal after this rolls back.
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('a fresh guard run does not inherit role or session state from the previous request on a reused connection', async () => {
      // Drive the guard twice in a row on this small pool (max default is
      // fine for two sequential connects) as two DIFFERENT users, proving
      // ROLLBACK really does revert both `SET LOCAL ROLE` and the session
      // vars before the connection can be reused — the composition the
      // coordinator asked to verify explicitly. Lookup on the OWNER pool
      // (scaffolding, not the thing under test).
      const managerRes = await ownerPool.query<{ id: string }>(
        `SELECT id FROM users WHERE username = 'manager1'`,
      );
      const managerId = managerRes.rows[0]!.id;

      const requestKasir: RequestWithDbContext = {
        user: { sub: kasirUserId, username: 'kasir1_bpp01', roleKey: 'kasir', locationIds: [] },
      };
      await guard.canActivate(makeContext(requestKasir));
      const kasirClient = requestKasir.dbClient!;
      const kasirScoped = await kasirClient.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM sales`,
      );
      await kasirClient.query('ROLLBACK');
      kasirClient.release();

      const requestManager: RequestWithDbContext = {
        user: { sub: managerId, username: 'manager1', roleKey: 'manager', locationIds: [] },
      };
      await guard.canActivate(makeContext(requestManager));
      const managerClient = requestManager.dbClient!;
      const managerScoped = await managerClient.query<{ n: string }>(
        `SELECT count(*)::int AS n FROM sales`,
      );
      await managerClient.query('ROLLBACK');
      managerClient.release();

      // Manager is a central role (unrestricted) — must see strictly more
      // than the Kasir's single-outlet count, proving the second request
      // got its OWN fresh scope rather than inheriting the Kasir's.
      expect(Number(managerScoped.rows[0]!.n)).toBeGreaterThan(Number(kasirScoped.rows[0]!.n));
    });
  },
);
