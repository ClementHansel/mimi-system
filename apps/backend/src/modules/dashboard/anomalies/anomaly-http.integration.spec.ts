import { BadRequestException, RequestMethod, ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../../../app.module';
import { AllExceptionsFilter } from '../../../common/filters/all-exceptions.filter';

/**
 * The Anomali endpoints over REAL HTTP — real guard chain, real global
 * pipes, real exception filter — because the service specs cannot see any of
 * what lives above the service: `@RequirePermission`, the DTOs (a typo'd
 * query param, a missing date), route ordering between `anomalies` and its
 * sub-paths, and the owner-only rule on the thresholds `PUT`.
 *
 * Endpoints exercised: `GET /api/dashboard/anomalies`,
 * `GET /api/dashboard/anomalies/drilldown`, `POST /api/dashboard/anomalies/review`,
 * `GET /api/dashboard/anomalies/thresholds`, `PUT /api/dashboard/anomalies/thresholds`.
 *
 * Assembled by hand to mirror `main.ts` — see `test/audit-http.e2e.spec.ts`
 * for why `AppModule` alone is a different application than production.
 */
const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ?? 'postgres://mimi:mimi_secret@localhost:55433/mimi';
const hasDb = Boolean(process.env.DATABASE_URL);
const DEMO_PASSWORD = 'password123';
const FP = 'sales_day_outlier:ZZANOM-HTTP:2099-01-01';

let app: INestApplication | undefined;
let baseUrl = '';
let pool: Pool | undefined;
let outletInScope = '';
let outletOutOfScope = '';

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

async function login(username: string): Promise<string> {
  const r = await api('/api/auth/login', {
    method: 'POST',
    body: { username, password: DEMO_PASSWORD },
  });
  expect(r.status, `login ${username}`).toBe(200);
  return r.body.accessToken as string;
}

const Q = 'from=2099-01-01&to=2099-01-07';
const tokens: Record<string, string> = {};

beforeAll(async () => {
  if (!hasDb) return;
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  app = moduleRef.createNestApplication();
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
  baseUrl = url.replace('[::1]', '127.0.0.1').replace('0.0.0.0', '127.0.0.1');
  pool = new Pool({ connectionString: OWNER_URL, max: 2 });

  tokens.owner = await login('owner');
  tokens.manager = await login('manager1'); // scoped to 10 branches
  tokens.supervisor = await login('spv_bjm01_m');

  const mine = (
    await pool.query<{ id: string }>(
      `SELECT ul.location_id AS id FROM user_locations ul JOIN users u ON u.id = ul.user_id
        WHERE u.username = 'manager1' ORDER BY 1 LIMIT 1`,
    )
  ).rows[0]!.id;
  const other = (
    await pool.query<{ id: string }>(
      `SELECT l.id FROM locations l
        WHERE l.type = 'outlet'
          AND l.id NOT IN (SELECT ul.location_id FROM user_locations ul JOIN users u ON u.id = ul.user_id WHERE u.username = 'manager1')
        LIMIT 1`,
    )
  ).rows[0]!.id;
  outletInScope = mine;
  outletOutOfScope = other;
}, 120_000);

afterAll(async () => {
  if (!hasDb) return;
  await pool?.query(`DELETE FROM anomaly_reviews WHERE fingerprint = $1`, [FP]);
  await pool?.end();
  await app?.close();
}, 60_000);

describe.skipIf(!hasDb)('Anomali endpoints over real HTTP', () => {
  it('GET /dashboard/anomalies answers an owner with all seven detectors, in order', async () => {
    const r = await api(`/api/dashboard/anomalies?${Q}`, { token: tokens.owner });
    expect(r.status).toBe(200);
    expect(r.body.detectors.map((d: { key: string }) => d.key)).toEqual([
      'sales_day_outlier',
      'product_qty_outlier',
      'usage_variance',
      'price_deviation',
      'payroll_outlier',
      'gl_sanity',
      'settlement_gap',
    ]);
    expect(typeof r.body.openCount).toBe('number');
    for (const d of r.body.detectors) expect(d.failed, `${d.key} failed`).toBe(false);
  }, 60_000);

  it('is dashboard.view only: a supervisor and an anonymous caller are refused', async () => {
    expect((await api(`/api/dashboard/anomalies?${Q}`, { token: tokens.supervisor })).status).toBe(
      403,
    );
    expect((await api(`/api/dashboard/anomalies?${Q}`)).status).toBe(401);
    expect(
      (await api('/api/dashboard/anomalies/thresholds', { token: tokens.supervisor })).status,
    ).toBe(403);
    expect(
      (
        await api('/api/dashboard/anomalies/review', {
          method: 'POST',
          token: tokens.supervisor,
          body: { detector: 'sales_day_outlier', fingerprint: FP },
        })
      ).status,
    ).toBe(403);
  }, 60_000);

  it('validates the query: a missing date and an unknown detector are 400 ERR_VALIDATION', async () => {
    const noTo = await api('/api/dashboard/anomalies?from=2099-01-01', { token: tokens.owner });
    expect(noTo.status).toBe(400);
    expect(noTo.body.code).toBe('ERR_VALIDATION');
    const badDetector = await api(`/api/dashboard/anomalies/drilldown?detector=nope&${Q}`, {
      token: tokens.owner,
    });
    expect(badDetector.status).toBe(400);
    const needsDate = await api(
      `/api/dashboard/anomalies/drilldown?detector=sales_day_outlier&${Q}&locationId=${outletInScope}`,
      { token: tokens.owner },
    );
    expect(needsDate.status).toBe(400); // a sales-day drill-down is meaningless without the day
  }, 60_000);

  it("scope: a branch-scoped manager gets 403 ERR_LOCATION_OUT_OF_SCOPE for another branch's outlet, 200 for their own", async () => {
    const out = await api(`/api/dashboard/anomalies?${Q}&locationId=${outletOutOfScope}`, {
      token: tokens.manager,
    });
    expect(out.status).toBe(403);
    expect(out.body.code).toBe('ERR_LOCATION_OUT_OF_SCOPE');
    const own = await api(`/api/dashboard/anomalies?${Q}&locationId=${outletInScope}`, {
      token: tokens.manager,
    });
    expect(own.status).toBe(200);
    // The drill-down is gated the same way.
    const drillOut = await api(
      `/api/dashboard/anomalies/drilldown?detector=sales_day_outlier&${Q}&locationId=${outletOutOfScope}&date=2099-01-01`,
      { token: tokens.manager },
    );
    expect(drillOut.status).toBe(403);
    const drill = await api(
      `/api/dashboard/anomalies/drilldown?detector=sales_day_outlier&${Q}&locationId=${outletInScope}&date=2099-01-01`,
      { token: tokens.manager },
    );
    expect(drill.status).toBe(200);
    expect(drill.body.columns.length).toBeGreaterThan(0);
    expect(Array.isArray(drill.body.rows)).toBe(true);
  }, 60_000);

  it('POST /dashboard/anomalies/review is committed: the row is there for another connection, and un-review removes it', async () => {
    await pool!.query(`DELETE FROM anomaly_reviews WHERE fingerprint = $1`, [FP]);
    const r = await api('/api/dashboard/anomalies/review', {
      method: 'POST',
      token: tokens.owner,
      body: {
        detector: 'sales_day_outlier',
        fingerprint: FP,
        locationId: outletInScope,
        note: 'ok',
      },
    });
    expect(r.status).toBe(201);
    expect(r.body.reviewed).toBe(true);
    const saved = await pool!.query(
      `SELECT reviewed_by, note FROM anomaly_reviews WHERE fingerprint = $1`,
      [FP],
    );
    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0].note).toBe('ok');

    const undo = await api('/api/dashboard/anomalies/review', {
      method: 'POST',
      token: tokens.owner,
      body: { detector: 'sales_day_outlier', fingerprint: FP, reviewed: false },
    });
    expect(undo.status).toBe(201);
    expect(
      (await pool!.query(`SELECT 1 FROM anomaly_reviews WHERE fingerprint = $1`, [FP])).rows,
    ).toHaveLength(0);

    // A detector the panel does not know is a validation error, not a stray row.
    const bad = await api('/api/dashboard/anomalies/review', {
      method: 'POST',
      token: tokens.owner,
      body: { detector: 'made_up', fingerprint: FP },
    });
    expect(bad.status).toBe(400);
  }, 60_000);

  it('thresholds: GET for dashboard.view; PUT is the owner alone — a manager (who holds settings.manage) gets 403 ERR_FORBIDDEN', async () => {
    const before = (
      await pool!.query(`SELECT value FROM settings WHERE key = 'anomaly.thresholds'`)
    ).rows[0].value;
    try {
      const got = await api('/api/dashboard/anomalies/thresholds', { token: tokens.manager });
      expect(got.status).toBe(200);
      expect(got.body.thresholds.sales_day_outlier.hi).toBeTypeOf('number');
      expect(got.body.fields.length).toBeGreaterThan(10);

      const denied = await api('/api/dashboard/anomalies/thresholds', {
        method: 'PUT',
        token: tokens.manager,
        body: { thresholds: { sales_day_outlier: { hi: 9 } } },
      });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('ERR_FORBIDDEN');

      const bad = await api('/api/dashboard/anomalies/thresholds', {
        method: 'PUT',
        token: tokens.owner,
        body: { thresholds: { sales_day_outlier: { hi: 0.2 } } },
      });
      expect(bad.status).toBe(400);
      expect(bad.body.code).toBe('ERR_VALIDATION');

      const ok = await api('/api/dashboard/anomalies/thresholds', {
        method: 'PUT',
        token: tokens.owner,
        body: { thresholds: { sales_day_outlier: { hi: 6 } } },
      });
      expect(ok.status).toBe(200);
      const row = (await pool!.query(`SELECT value FROM settings WHERE key = 'anomaly.thresholds'`))
        .rows[0].value;
      expect(row.sales_day_outlier.hi).toBe(6);
    } finally {
      await pool!.query(`UPDATE settings SET value = $1::jsonb WHERE key = 'anomaly.thresholds'`, [
        JSON.stringify(before),
      ]);
    }
  }, 60_000);
});
