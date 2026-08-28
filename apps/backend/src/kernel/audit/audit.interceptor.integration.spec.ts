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
    try {
      const user = await withRequestContext(pool, (c) =>
        c.query(`SELECT id FROM users WHERE username = 'manager1' LIMIT 1`),
      );
      const location = await withRequestContext(pool, (c) =>
        c.query(`SELECT id, name FROM locations WHERE code = 'GDG' LIMIT 1`),
      );
      if (user.rows.length === 0 || location.rows.length === 0) {
        dbAvailable = false;
        return;
      }
      managerId = user.rows[0].id;
      locationId = location.rows[0].id;
      originalName = location.rows[0].name;
    } catch {
      dbAvailable = false;
    }
  });

  afterAll(async () => {
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
