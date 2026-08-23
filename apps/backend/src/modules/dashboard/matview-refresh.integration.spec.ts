import { describe, it, expect, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { MatviewRefreshService } from './matview-refresh.service';
import type { DashboardGateway } from './dashboard.gateway';

/**
 * The reporting rollups must actually refresh.
 *
 * They never did. `REFRESH MATERIALIZED VIEW` requires ownership of the view,
 * the four rollups were created by migration 100 as `mimi`, and the app runs as
 * `app_user` — so every five-minute tick since this service was written failed
 * with "must be owner of materialized view mv_sales_daily". The failure was
 * caught and logged per view, which meant the only symptom was one line in a
 * container log and dashboards that drifted from the tables. Migration 236
 * moves ownership to `app_user`.
 *
 * This spec exists because the bug was invisible from the outside: the endpoint
 * answered, the numbers looked plausible, and nothing was red. It runs a REAL
 * pass through the REAL service against the live database and asserts every view
 * came back `ok` — the one thing that distinguishes "refreshing" from
 * "answering with whatever it last managed to compute".
 */
describe.skipIf(!process.env.DATABASE_URL)('MatviewRefreshService — live database', () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // The gateway's realtime nudge is a UX nicety on top of the refresh, and a
  // bare `new DashboardGateway` has no socket server outside a running Nest app.
  const gateway = { pushUpdate: vi.fn() } as unknown as DashboardGateway;

  afterAll(async () => {
    await pool.end();
  });

  it('refreshes every rollup — no view reports a privilege error', async () => {
    const service = new MatviewRefreshService(pool, gateway);
    const results = await service.refreshAll();

    expect(results.length).toBeGreaterThan(0);
    // Named individually in the failure message: "one of four failed" is not
    // actionable, and a partial failure is the shape a future grant change takes.
    const failed = results.filter((r) => !r.ok);
    expect(
      failed.map((r) => `${r.view}: ${r.error}`),
      'every matview should refresh',
    ).toEqual([]);
  }, 60_000);

  it('is idempotent — a second pass immediately after is also clean', async () => {
    // CONCURRENTLY takes locks and swaps in a new heap; running two passes
    // back to back is the cheapest check that the first left the views in a
    // refreshable state rather than a half-swapped one.
    const service = new MatviewRefreshService(pool, gateway);
    const results = await service.refreshAll();
    expect(results.every((r) => r.ok)).toBe(true);
  }, 60_000);
});
