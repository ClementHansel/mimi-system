import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool, PoolClient } from 'pg';
import { defer, from } from 'rxjs';
import type { ExecutionContext, CallHandler } from '@nestjs/common';
import { AuditInterceptor } from './audit.interceptor';
import { AUDITED_KEY } from '../../common/decorators/audited.decorator';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import type { RequestWithDbContext } from '../../common/guards/rls-context.guard';

/**
 * Integration proof (BUILD-PLAN §5 W2-C "TESTING" requirement): the
 * `@Audited()` interceptor records a REAL before/after diff for a REAL
 * mutation, against the live compose Postgres — not a mock.
 *
 * D-21/D-22: `DATABASE_URL`/`TEST_DATABASE_URL` now authenticates as
 * `mimi_app` — zero direct table grants, exactly the real runtime role. The
 * hand-built "request" `client` below now includes the same `SET LOCAL ROLE
 * app_user` phase 0 `RlsContextGuard` performs for a real request (without
 * it, this suite would have passed only by accident, the same gap the
 * coordinator's cross-agent review caught in `NotificationService`/
 * `StorageService`).
 *
 * Requires `mimi-postgres` (docker-compose.yml) reachable; skips gracefully
 * if it is not, so this file does not fail an environment that hasn't
 * started the stack (CI/dev-box parity handled by whoever wires the test
 * script to `docker compose up -d postgres` first).
 */
const DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://mimi_app:mimi_app_secret@localhost:55433/mimi';

/** Central-role request context for this test's OWN setup/assertion queries (not the interceptor's own connections). */
async function withRequestContext<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query(`SELECT set_config('app.role', 'owner', true)`);
    await c.query(`SELECT set_config('app.user_id', '00000000-0000-0000-0000-000000000000', true)`);
    // `app.tenant_id` is NOT optional, and leaving it out is why this entire
    // file went quiet. Migration 263 put a tenant predicate on these tables, so
    // without it every SELECT here returns ZERO ROWS — which `beforeAll` read as
    // "no fixtures", set `dbAvailable = false`, and every test in the file then
    // returned early and reported PASS in about a millisecond. FR-AUDIT-01's
    // only integration coverage had not actually executed since 2026-08-30.
    await c.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await c.query(`SELECT set_config('app.location_ids', '', true)`);
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    c.release();
  }
}

// `AUDITED_KEY`/`REQUIRE_PERMISSION_KEY` metadata is stubbed directly on the
// fake `reflector` object below (this test builds its own ExecutionContext
// rather than routing through real Nest metadata, matching the pattern in
// `rls-context.guard.spec.ts`), so `makeContext()` only needs to carry the
// request through.
function makeContext(request: unknown): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => ({}),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('AuditInterceptor (integration, live Postgres)', () => {
  let pool: Pool;
  let dbAvailable = true;
  let client: PoolClient;
  let managerId: string;
  let locationId: string;
  let originalName: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    let user: { rows: { id: string }[] };
    let location: { rows: { id: string; name: string }[] };
    try {
      user = await withRequestContext(pool, (c) =>
        c.query(`SELECT id FROM users WHERE username = 'manager1' LIMIT 1`),
      );
      location = await withRequestContext(pool, (c) =>
        c.query(`SELECT id, name FROM locations WHERE code = 'GDG' LIMIT 1`),
      );
    } catch {
      // ONLY an unreachable server skips. The try block is deliberately narrow:
      // it previously wrapped the fixture check too, so any failure at all —
      // including "the query succeeded and returned nothing" — became a silent
      // skip.
      dbAvailable = false;
      return;
    }

    // A REACHABLE database that cannot produce the fixtures is NOT "no
    // database", and conflating the two is what let this file report green
    // while executing nothing for two weeks. A server that answers but has no
    // `manager1` / no `GDG` means the seed or the RLS session context changed
    // underneath this suite, and that has to be loud.
    if (user.rows.length === 0 || location.rows.length === 0) {
      throw new Error(
        `audit.interceptor.integration: Postgres is reachable but the fixtures are missing ` +
          `(manager1=${user.rows.length}, GDG=${location.rows.length}). This suite must not ` +
          `silently skip — check the seed and the RLS session context (app.tenant_id).`,
      );
    }
    managerId = user.rows[0]!.id;
    locationId = location.rows[0]!.id;
    originalName = location.rows[0]!.name;
  });

  afterAll(async () => {
    /**
     * Drain before handing the database to the next serialized suite.
     *
     * `AuditInterceptor` writes its row FIRE-AND-FORGET on its own connection
     * (BEGIN / set_config / INSERT / COMMIT) after the response has already been
     * returned, so a write can still be in flight when the last test here ends.
     * `test/audit-http.e2e.spec.ts` runs next in the serialized live-DB project
     * and asserts an EXACT database-wide `idle in transaction` count, so an
     * in-flight audit write of ours is counted against it and fails a test about
     * connection leaks with a leak that is really ours and really transient.
     *
     * This only became reachable when the tenant-context bug above was fixed:
     * while the whole file was silently skipping it issued no writes at all, so
     * there was nothing to drain. Verified against a `107b2a1` worktree — the
     * suite is 1544/1544 there and the failure appears only with these tests
     * actually running.
     */
    if (pool && dbAvailable) {
      for (let i = 0; i < 40; i += 1) {
        const res = await pool
          .query<{ n: string }>(
            `SELECT COUNT(*)::text AS n FROM pg_stat_activity
              WHERE datname = current_database() AND state = 'idle in transaction'`,
          )
          .catch(() => null);
        if (!res || Number(res.rows[0]!.n) === 0) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    await pool?.end();
  });

  it('FR-AUDIT-01 — captures a real before/after JSON diff and writes it to audit_log', async () => {
    if (!dbAvailable) {
      console.warn('Skipping: live Postgres not reachable at ' + DATABASE_URL);
      return;
    }

    // Mimic what RlsContextGuard already did for this request: BEGIN + set
    // the three session vars on request.dbClient, before the interceptor's
    // pre-handler phase runs (the same ordering guarantee production relies on).
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [managerId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, ['manager']);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, ['']);

    const newName = `${originalName} (audit-test ${Date.now()})`;
    const request: RequestWithDbContext & Record<string, unknown> = {
      user: { sub: managerId, username: 'manager1', roleKey: 'manager', locationIds: [] },
      dbClient: client,
      locationScope: null,
      method: 'PATCH',
      params: { id: locationId },
      body: { name: newName, reason: 'integration test rename' },
      headers: {},
      ip: '127.0.0.1',
      originalUrl: `/api/location/${locationId}`,
      url: `/api/location/${locationId}`,
    };

    const reflector = {
      getAllAndOverride: (key: string) => {
        if (key === AUDITED_KEY) return { entityType: 'location', module: 'location' };
        if (key === REQUIRE_PERMISSION_KEY) return ['location.update'];
        return undefined;
      },
    };

    const interceptor = new AuditInterceptor(pool, reflector as never);

    // The "handler": performs the mutation on the SAME client only when
    // SUBSCRIBED (rxjs `defer`, not eagerly) — this matters. Nest's real
    // request lifecycle runs every interceptor's pre-handler phase BEFORE
    // subscribing to the composed Observable that eventually invokes the
    // route handler; `AuditInterceptor.intercept()` reads the "before" value
    // in that pre-handler phase. If this test executed the UPDATE before
    // calling `interceptor.intercept()`, the "before" read would see the
    // ALREADY-mutated row — `defer` reproduces the real ordering instead.
    const callHandler: CallHandler = {
      handle: () =>
        defer(() =>
          from(
            (async () => {
              await client.query('UPDATE locations SET name = $1 WHERE id = $2', [
                newName,
                locationId,
              ]);
              const updated = await client.query(
                'SELECT id, code, name, type FROM locations WHERE id = $1',
                [locationId],
              );
              return updated.rows[0];
            })(),
          ),
        ),
    };

    const ctx = makeContext(request);
    const observable = await interceptor.intercept(ctx, callHandler);
    await new Promise<void>((resolve, reject) => {
      observable.subscribe({
        next: () => undefined,
        error: reject,
        complete: resolve,
      });
    });

    // The interceptor's post-handler write runs on ITS OWN connection
    // (deliberately, see audit.interceptor.ts) and is fire-and-forget from
    // `intercept()`'s point of view once the response stream completes —
    // give it a moment to land before asserting.
    await new Promise((r) => setTimeout(r, 300));

    // `audit_log_select` RLS (migration 009) restricts SELECT to
    // owner/manager/finance — this assertion query needs that central-role
    // context just like any other read of this table.
    const auditRows = await withRequestContext(pool, (c) =>
      c.query(
        `SELECT * FROM audit_log WHERE entity_type = 'location' AND entity_id = $1 ORDER BY created_at DESC LIMIT 1`,
        [locationId],
      ),
    );
    expect(auditRows.rows.length).toBe(1);
    const row = auditRows.rows[0];

    expect(row.user_id).toBe(managerId);
    expect(row.role_key).toBe('manager');
    expect(row.module).toBe('location');
    expect(row.entity_type).toBe('location');
    expect(row.entity_id).toBe(locationId);
    expect(row.reason).toBe('integration test rename');
    expect(row.before_value.name).toBe(originalName);
    expect(row.after_value.name).toBe(newName);
    expect(row.before_value.name).not.toBe(row.after_value.name);

    // Cleanup: restore the location's original name (real UPDATE, not part
    // of the rolled-back interceptor plumbing) and leave the audit trail
    // in place (audit_log is append-only by design — D-09 — so the test's
    // own audit row is expected residue, matching how the interceptor
    // behaves in production).
    await client.query('UPDATE locations SET name = $1 WHERE id = $2', [originalName, locationId]);
    await client.query('COMMIT');
    client.release();
  });

  /**
   * MA-208 — a PR's "Riwayat Perubahan" showed only "PR dibuat" while the
   * database held three rows. `audit_log_select` (migration 235) is
   *
   *   role IN ('owner','finance') OR (role = 'manager' AND app_has_location(location_id))
   *
   * and `app_has_location(NULL)` is never true, so a null `location_id` does not
   * lose a detail — it makes the row permanently invisible to every manager.
   *
   * `POST /purchasing/requests/:id/approve` carries a `{note?}` body and no
   * `:locationId`, and a manager is multi-location, so the old
   * "body/params, else single-location scope, else null" rule produced null on
   * every approve. The location has to come from the DOCUMENT.
   */
  it('MA-208 — an approve with no locationId in body or params takes it from the document, not from the actor', async () => {
    if (!dbAvailable) return;
    const MARKER = `ma208-${Date.now()}`;

    // Through `withRequestContext`, never a bare `pool.query`: `mimi_app` holds
    // no table grants of its own (D-21/D-22 — the very thing the last test in
    // this file asserts), so a raw SELECT here is `permission denied`.
    const pr = await withRequestContext(pool, (c) =>
      c.query<{ id: string; location_id: string }>(
        `SELECT id, location_id FROM purchase_requests WHERE location_id IS NOT NULL LIMIT 1`,
      ),
    );
    const prRow = pr.rows[0];
    if (!prRow) {
      console.warn('Skipping: seed has no purchase_requests with a location');
      return;
    }

    client = await pool.connect();
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query(`SELECT set_config('app.user_id', $1, true)`, [managerId]);
    await client.query(`SELECT set_config('app.role', $1, true)`, ['manager']);
    await client.query(`SELECT set_config('app.tenant_id', app_the_only_tenant()::text, true)`);
    await client.query(`SELECT set_config('app.location_ids', $1, true)`, ['']);

    const request: RequestWithDbContext & Record<string, unknown> = {
      user: { sub: managerId, username: 'manager1', roleKey: 'manager', locationIds: [] },
      dbClient: client,
      // Multi-location (central) manager: the old rule had no single answer here
      // and fell through to null. This is the reported reporter's situation.
      locationScope: null,
      method: 'POST',
      params: { id: prRow.id },
      // `reason` is what the interceptor persists, so it doubles as this row's
      // unique marker for read-back and cleanup.
      body: { note: 'approved in the integration test', reason: MARKER },
      headers: {},
      ip: '127.0.0.1',
      originalUrl: `/api/purchasing/requests/${prRow.id}/approve`,
      url: `/api/purchasing/requests/${prRow.id}/approve`,
    };

    const reflector = {
      getAllAndOverride: (key: string) => {
        if (key === AUDITED_KEY)
          return { entityType: 'purchase_request', action: 'purchasing.pr.approve' };
        if (key === REQUIRE_PERMISSION_KEY) return ['purchasing.pr.approve'];
        return undefined;
      },
    };

    const interceptor = new AuditInterceptor(pool, reflector as never);
    const callHandler: CallHandler = {
      handle: () => defer(() => from(Promise.resolve({ id: prRow.id, status: 'approved' }))),
    };

    const observable = await interceptor.intercept(makeContext(request), callHandler);
    await new Promise<void>((resolve, reject) => {
      observable.subscribe({ next: () => {}, error: reject, complete: () => resolve() });
    });
    // The audit row is written on its own connection after the response, so give
    // that fire-and-forget write a moment to land before reading it back.
    await new Promise((r) => setTimeout(r, 300));

    const written = await withRequestContext(pool, (c) =>
      c.query<{ location_id: string | null }>(
        `SELECT location_id FROM audit_log
          WHERE entity_type = 'purchase_request' AND entity_id = $1
            AND action = 'purchasing.pr.approve' AND reason = $2
          ORDER BY occurred_at DESC LIMIT 1`,
        [prRow.id, MARKER],
      ),
    );
    expect(written.rows[0]).toBeDefined();
    // The PR's own location — NOT null, which is what made it invisible.
    expect(written.rows[0]!.location_id).toBe(prRow.location_id);

    // NO cleanup, deliberately. `audit_log` is append-only by design — D-09
    // revokes UPDATE and DELETE from `app_user` and defines no policy for
    // either, so a tidy-up here would fail with `permission denied` and, worse,
    // asking for one at all is the wrong instinct about an audit log. The row
    // stays; `MARKER` is unique per run, so it can neither collide with nor be
    // mistaken for real history.
    await client.query('ROLLBACK');
    client.release();
  });

  it('REGRESSION (D-21/D-22): a bare mimi_app connection with no SET LOCAL ROLE cannot write audit_log at all', async () => {
    if (!dbAvailable) return;

    // The exact bug class the coordinator flagged (found in the sibling
    // notification/storage kernels; audit.interceptor.ts's own fresh
    // connection had the identical gap before this fix): a raw INSERT with
    // zero role switch must be rejected, not silently succeed or under-scope.
    await expect(
      pool.query(
        `INSERT INTO audit_log (user_id, module, action, entity_type) VALUES ($1,'x','x','x')`,
        [managerId],
      ),
    ).rejects.toMatchObject({ code: '42501' }); // permission denied
  });
});
