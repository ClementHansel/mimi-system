import { randomUUID } from 'node:crypto';
import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter';

/**
 * B-08 — the first test in this codebase that can produce a REAL audit row.
 *
 * ## Why this file has to exist
 *
 * `AuditInterceptor` bails on `context.getType() !== 'http'` and is the sole
 * writer of `audit_log`. Every integration suite in this repo constructs
 * services directly, so none of them passes through an HTTP `ExecutionContext`
 * — which means "an audit row on every mutation", a gate criterion, could not
 * be verified anywhere below the interceptor's own unit-ish spec. That spec
 * hand-builds a fake `ExecutionContext`; it proves the interceptor's logic and
 * proves nothing about whether the interceptor is actually WIRED into the
 * running application.
 *
 * This drives a real route over a real socket, through the real guard chain,
 * the real global pipes and the real `APP_INTERCEPTOR` stack, and then reads
 * `audit_log` on a separate connection.
 *
 * ## Why no supertest
 *
 * `app.listen(0)` plus Node's global `fetch` does the same job with no new
 * dependency and no lockfile churn — which matters here because a second
 * session is committing to this repo concurrently.
 *
 * ## Why the app is assembled by hand
 *
 * `Test.createTestingModule({ imports: [AppModule] })` gives the DI graph but
 * NOT `main.ts`'s global prefix, validation pipe or exception filter. Booting
 * without them would test a different application than production runs — the
 * `/api` prefix alone would make every request 404 and the suite would "pass"
 * by asserting on nothing. The three lines below mirror `main.ts`; if that file
 * grows a fourth global, this needs it too.
 */

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ?? 'postgres://mimi:mimi_secret@localhost:55433/mimi';
const hasDb = Boolean(process.env.DATABASE_URL);

/** Seeded demo password (`database/seed.ts`'s `DEMO_PASSWORD`). */
const DEMO_PASSWORD = 'password123';

let app: INestApplication | undefined;
let baseUrl = '';
let ownerPool: Pool | undefined;
let accessToken = '';
const createdLocationIds: string[] = [];

/**
 * Waits for the audit row to appear.
 *
 * THIS POLL IS THE POINT, NOT A WORKAROUND. `AuditInterceptor` writes with
 * `void this.writeAuditRow(...)` inside a `tap()` — fire-and-forget, after the
 * response has already gone out, with a `.catch()` that only logs. So:
 *
 *   - a client holding a 201 has NO guarantee the audit row exists yet, and
 *   - if that write throws, the mutation still succeeds and the audit row is
 *     silently absent, visible only as a line in the server log.
 *
 * Both were undocumented until this harness went red on them. The first test
 * written here passed by winning the race; the next one lost it. A test that
 * "fixed" that by sleeping would have hidden the finding, so the wait is
 * explicit and named.
 */
async function waitForAuditRow(
  entityId: string,
  timeoutMs = 5000,
): Promise<{ user_id: string; action: string; entity_type: string; after_value: unknown } | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await ownerPool!.query<{
      user_id: string;
      action: string;
      entity_type: string;
      after_value: unknown;
    }>(
      `SELECT user_id, action, entity_type, after_value
         FROM audit_log
        WHERE entity_type = 'location' AND entity_id = $1
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [entityId],
    );
    if (res.rows[0]) return res.rows[0];
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function api(
  path: string,
  init: { method?: string; body?: unknown; token?: string } = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
    },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

beforeAll(async () => {
  if (!hasDb) return;

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();

  // Mirrors `main.ts` — see this file's header for why that is load-bearing.
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      exceptionFactory: (
        errors: Array<{ property: string; constraints?: Record<string, string> }>,
      ) =>
        new BadRequestException({
          code: 'ERR_VALIDATION',
          message: 'Validation failed',
          details: errors.map((e) => ({
            field: e.property,
            constraints: e.constraints ? Object.values(e.constraints) : [],
          })),
        }),
    }),
  );
  app.setGlobalPrefix('api', {
    exclude: [
      'health',
      { path: 'sync/v1/health', method: RequestMethod.ALL },
      { path: 'sync/v1/hello', method: RequestMethod.ALL },
      { path: 'sync/v1/push', method: RequestMethod.ALL },
      { path: 'sync/v1/pull', method: RequestMethod.ALL },
    ],
  });

  await app.listen(0);
  const url = await app.getUrl();
  // `getUrl()` reports `::1` on a dual-stack host, which `fetch` will not resolve.
  baseUrl = url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');

  ownerPool = new Pool({ connectionString: OWNER_URL, max: 2 });

  const login = await api('/api/auth/login', {
    method: 'POST',
    body: { username: 'owner', password: DEMO_PASSWORD },
  });
  expect(login.status).toBe(200);
  accessToken = login.body.accessToken;
}, 120_000);

afterAll(async () => {
  if (!hasDb) return;
  for (const id of createdLocationIds) {
    await ownerPool?.query('DELETE FROM locations WHERE id = $1', [id]);
  }
  await ownerPool?.end();
  await app?.close();
}, 60_000);

describe.skipIf(!hasDb)('B-08 — @Audited writes a real row over real HTTP', () => {
  it('the application actually boots and serves an authenticated request', async () => {
    // Worth its own assertion: 744 tests once passed while the app could not
    // start at all, because no test ever built the real DI graph and served a
    // request through it. This is the cheapest possible guard against that.
    expect(accessToken).toBeTruthy();
    const me = await api('/api/auth/me', { token: accessToken });
    expect(me.status).toBe(200);
    expect(me.body.username).toBe('owner');
  }, 60_000);

  it('a real audited mutation leaves an audit_log row naming the actor, action and entity', async () => {
    const code = `AUD${Date.now().toString().slice(-8)}`;
    const created = await api('/api/locations', {
      method: 'POST',
      token: accessToken,
      body: {
        code,
        name: 'B-08 audit harness location',
        type: 'outlet',
        city: 'Balikpapan',
      },
    });
    expect(created.status).toBe(201);
    const locationId = created.body.id as string;
    createdLocationIds.push(locationId);

    // Read back on a SEPARATE connection. A 201 is not evidence of persistence
    // — that is the rule this project earned the hard way when ten modules
    // returned 201 and silently rolled back.
    const row = await waitForAuditRow(locationId);
    expect(row).not.toBeNull();
    expect(row!.action).toBe('location.manage');
    expect(row!.after_value).toBeTruthy();
  }, 60_000);

  it('the audit row records WHO did it, resolved from the session and not from the body', async () => {
    const created = await api('/api/locations', {
      method: 'POST',
      token: accessToken,
      body: {
        code: `AUD${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'B-08 actor check',
        type: 'outlet',
        city: 'Balikpapan',
      },
    });
    expect(created.status).toBe(201);
    createdLocationIds.push(created.body.id);

    const owner = await ownerPool!.query<{ id: string }>(
      `SELECT id FROM users WHERE username = 'owner'`,
    );
    const row = await waitForAuditRow(created.body.id);
    expect(row).not.toBeNull();
    // The actor comes from the verified JWT, never from anything the caller
    // could put in the body — which is the whole value of the row.
    expect(row!.user_id).toBe(owner.rows[0]!.id);
  }, 60_000);

  it('a REJECTED mutation writes no audit row — the log records what happened, not what was attempted', async () => {
    // Let any in-flight write from an earlier test land before counting, or
    // this measures the previous test's race rather than this one's rejection.
    await new Promise((r) => setTimeout(r, 500));
    const before = await ownerPool!.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log WHERE entity_type = 'location'`,
    );

    // Validation failure: `type` is not a LocationType.
    const rejected = await api('/api/locations', {
      method: 'POST',
      token: accessToken,
      body: { code: `BAD${randomUUID().slice(0, 5)}`, name: 'nope', type: 'spaceship', city: 'X' },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.code).toBe('ERR_VALIDATION');

    await new Promise((r) => setTimeout(r, 500));
    const after = await ownerPool!.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM audit_log WHERE entity_type = 'location'`,
    );
    expect(after.rows[0]!.n).toBe(before.rows[0]!.n);
  }, 60_000);

  it('the audit write is FIRE-AND-FORGET — a 201 does not mean the row is there yet', async () => {
    const created = await api('/api/locations', {
      method: 'POST',
      token: accessToken,
      body: {
        code: `AUD${randomUUID().slice(0, 8).toUpperCase()}`,
        name: 'B-08 async proof',
        type: 'outlet',
        city: 'Balikpapan',
      },
    });
    expect(created.status).toBe(201);
    createdLocationIds.push(created.body.id);

    // Not asserting the row is ABSENT — that would be a flaky race in the other
    // direction. Asserting instead that it arrives WITHIN a bound, which is the
    // honest contract: eventual, not synchronous. `AuditInterceptor` writes with
    // `void ...` in a `tap()` and swallows failures into a log line, so a
    // production audit row can be silently missing and nothing will 500.
    // Recorded against B-08 in docs/PROGRESS.md rather than left as folklore.
    const row = await waitForAuditRow(created.body.id, 5000);
    expect(row).not.toBeNull();
  }, 60_000);

  it('an UNAUTHENTICATED mutation is refused before it can reach the interceptor at all', async () => {
    const res = await api('/api/locations', {
      method: 'POST',
      body: { code: 'NOAUTH01', name: 'no token', type: 'outlet', city: 'Balikpapan' },
    });
    expect(res.status).toBe(401);
  }, 60_000);
});

/**
 * A 403 must not cost a database connection.
 *
 * FOUND IN PRODUCTION on 2026-08-29, not by reasoning: the deployed box had all
 * 20 pool connections sitting `idle in transaction`, every one with the same
 * last statement — `set_config('app.location_ids', $1, true)`, the final line
 * of `RlsContextGuard`. Login returned 500 "timeout exceeded when trying to
 * connect" and the whole API was down, while the login PAGE still served 200,
 * so the deploy's health check saw a healthy stack.
 *
 * Cause: Nest does not run interceptors when a GUARD rejects. `RlsContextGuard`
 * had already checked a connection out and opened a transaction on it, and
 * `RlsCleanupInterceptor` — the only thing that releases it — never ran. The
 * connection was gone for the lifetime of the process.
 *
 * It needed no unusual traffic. A user opening a page their role cannot see is
 * enough, twenty times.
 *
 * The fix is guard ORDER in `app.module.ts` (`PermissionsGuard` before
 * `RlsContextGuard`), so a denial happens before any connection is taken. This
 * test is the regression, and it asserts against the DATABASE rather than a
 * mock, because the failure was invisible at every level above it: the request
 * returned a perfectly correct 403 either way.
 */
describe.skipIf(!hasDb)('a permission denial must not leak a pooled connection', () => {
  async function idleInTransactionCount(): Promise<number> {
    const res = await ownerPool!.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM pg_stat_activity
        WHERE datname = current_database() AND state = 'idle in transaction'`,
    );
    return Number(res.rows[0]!.n);
  }

  it('ten 403s leave the pool exactly as they found it', async () => {
    // `payment.read` is owner/manager/finance only, so a kasir is denied it —
    // and `PermissionsGuard` is what denies, which is the path under test.
    const login = await api('/api/auth/login', {
      method: 'POST',
      body: { username: 'kasir_bjm01_p', password: DEMO_PASSWORD },
    });
    expect(login.status, 'seeded kasir must be able to log in').toBe(200);

    // Settle first: the login itself uses a connection, and an assertion taken
    // mid-release would report a leak that is really just timing.
    await new Promise((r) => setTimeout(r, 500));
    const before = await idleInTransactionCount();

    for (let i = 0; i < 10; i += 1) {
      const denied = await api('/api/accounting/payments', { token: login.body.accessToken });
      expect(denied.status, 'kasir must be refused payment.read').toBe(403);
    }

    await new Promise((r) => setTimeout(r, 500));
    const after = await idleInTransactionCount();

    // Equality, not a threshold. Before the fix this was before + 10 — one
    // abandoned transaction per denial, never reclaimed.
    expect(
      after,
      'each 403 abandoned a pooled connection mid-transaction; 20 of them took the whole API down',
    ).toBe(before);
  }, 120_000);
});

/**
 * MUTATING ENDPOINTS MUST COMMIT.
 *
 * `RlsCleanupInterceptor` issues an unconditional ROLLBACK, so a handler that
 * writes on the request client and returns without committing loses the write.
 * The BE-TXN-ROLLBACK guard turns that into a 500 rather than losing it
 * quietly — which is the only reason this was visible at all.
 *
 * `POST /notifications/read-all` had it, and answered 500 for every caller.
 * Nothing had ever called the endpoint: it was one of 35 write endpoints that
 * no spec so much as named (see `write-endpoint-inventory.spec.ts`). Found
 * 2026-09-04 by walking that list against a running server.
 *
 * This is the fourth time this project has shipped the trap, so the test is
 * over HTTP deliberately: the interceptor only runs in the request pipeline,
 * and a service-level test cannot see it.
 */
describe.skipIf(!hasDb)('notifications — writes are committed', () => {
  it('marks every unread notification read, and stays marked', async () => {
    // SEED AN UNREAD ROW FIRST. Without one the UPDATE touches nothing, the
    // BE-TXN-ROLLBACK guard never fires (it only trips when a write actually
    // happened), and the whole test passes with the fix reverted — which is
    // exactly what it did on its first run. A guard that cannot fail is worse
    // than no guard.
    // `ownerPool` is created in `beforeAll` and typed as possibly undefined for
    // the no-database case, which `describe.skipIf(!hasDb)` already excludes.
    const pool = ownerPool!;
    const owner = await pool.query<{ id: string }>(`SELECT id FROM users WHERE username = 'owner'`);
    await pool.query(
      `INSERT INTO notifications (user_id, type, title, body, payload)
       VALUES ($1, 'system', 'commit-trap regression', 'unread on purpose', '{}'::jsonb)`,
      [owner.rows[0]!.id],
    );

    const first = await api('/api/notifications/read-all', {
      method: 'POST',
      token: accessToken,
      body: {},
    });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(first.body.updated, 'nothing was unread, so this proves nothing').toBeGreaterThan(0);

    // The SECOND call is what proves the first COMMITTED. An uncommitted
    // update reports the same rowCount every time, because the rollback puts
    // the rows back.
    const second = await api('/api/notifications/read-all', {
      method: 'POST',
      token: accessToken,
      body: {},
    });
    expect(second.status).toBe(201);
    expect(
      second.body.updated,
      'the first call did not persist — its transaction was rolled back',
    ).toBe(0);
  }, 60_000);
});
