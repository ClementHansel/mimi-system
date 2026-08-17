import { Inject, Injectable, Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { DashboardGateway } from './dashboard.gateway';

export const REFRESH_INTERVAL_MS = 5 * 60_000; // "every 5 min" per migration 100's own header comment.

const MATVIEWS = ['mv_sales_daily', 'mv_item_usage_daily', 'mv_employee_kpi_daily', 'mv_delivery_recap_daily'] as const;

/**
 * The scheduler `database/migrations/100_reporting_matviews.sql`'s header
 * promises ("Refreshed CONCURRENTLY every 5 min by a backend scheduler")
 * but that did not exist anywhere in the codebase before this ticket
 * (grep-confirmed: no `REFRESH MATERIALIZED VIEW` call existed). Modeled on
 * `device-registry/staleness-sweep.service.ts`'s `OnApplicationBootstrap` +
 * plain `setInterval` shape (no `@nestjs/schedule` dependency in this
 * workspace) — fire once immediately, then on the interval, catch-and-log
 * per tick so one bad tick never kills the loop, and expose `refreshAll()`
 * publicly so tests can run a pass synchronously without waiting 5 minutes.
 *
 * `DATABASE_POOL` INJECTED DIRECTLY — the ONE place in this module allowed
 * to (per the ticket's hard constraint: every other dashboard service takes
 * `request.dbClient`, never `DATABASE_POOL`). Refreshing four company-wide
 * rollups is not "acting as" any one request's user — it is a genuinely
 * background, cross-location path, exactly the shape
 * `common/database/system-context.ts`'s header describes ("a cron sweep...
 * none of these run as one request's acting user").
 *
 * WHY EACH `REFRESH ... CONCURRENTLY` IS ITS OWN BARE STATEMENT, NOT WRAPPED
 * IN `withSystemContext`: `REFRESH MATERIALIZED VIEW CONCURRENTLY` cannot run
 * inside an explicit transaction block (`CONCURRENTLY`'s own Postgres
 * restriction) — `withSystemContext` opens `BEGIN`/asserts context/commits,
 * which would make every refresh here fail with "REFRESH MATERIALIZED VIEW
 * CONCURRENTLY cannot run inside a transaction block". Each refresh is
 * therefore issued as its own implicit-transaction statement on a client
 * checked out directly from `DATABASE_POOL`, with `SET ROLE app_user` set
 * once per checkout (not `SET LOCAL`, since there is no enclosing
 * transaction here to scope it to — this connection is released back to the
 * pool immediately after, same as `pool.connect()`'s normal contract, so no
 * cross-request leakage risk applies the way it would for a
 * request-scoped connection).
 *
 * PRIVILEGE FINDING (flag for senior-db, see this ticket's final report): a
 * concurrent refresh needs the SAME privilege as a normal `SELECT` plus the
 * ability to take the relevant locks — Postgres does not require table
 * OWNERSHIP for `REFRESH MATERIALIZED VIEW CONCURRENTLY`, only `SELECT` on
 * the underlying matview (which every unique-indexed matview here already
 * grants to any role that can read it) PLUS the matview's own row locks. If
 * `mimi_app`/`app_user` turns out NOT to have been granted plain `SELECT` on
 * these four matviews (they are new objects from migration 100, and this
 * agent does not own `database/` to check/fix grants), `runOneRefresh` below
 * will throw a Postgres permission error, caught and logged per-view by
 * `refreshAll()` — surfaced honestly in the ticket report rather than
 * silently degrading to a stale rollup forever.
 */
@Injectable()
export class MatviewRefreshService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(MatviewRefreshService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly gateway: DashboardGateway,
  ) {}

  onApplicationBootstrap(): void {
    void this.refreshAll().catch((err) => this.logger.error(`initial matview refresh failed: ${(err as Error).message}`));
    this.timer = setInterval(() => {
      void this.refreshAll().catch((err) => this.logger.error(`matview refresh tick failed: ${(err as Error).message}`));
    }, REFRESH_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests (and the manual `POST /api/dashboard/refresh` route) — runs one refresh pass synchronously. */
  async refreshAll(): Promise<{ view: string; ok: boolean; error?: string }[]> {
    const results: { view: string; ok: boolean; error?: string }[] = [];
    for (const view of MATVIEWS) {
      try {
        await this.refreshOne(view);
        results.push({ view, ok: true });
      } catch (err) {
        const message = (err as Error).message;
        this.logger.error(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view} failed: ${message}`);
        results.push({ view, ok: false, error: message });
      }
    }
    // Best-effort realtime nudge — every scoped room gets told to re-fetch; never throws (see gateway).
    this.gateway.pushUpdate('all', { type: 'matview_refreshed', at: new Date().toISOString() });
    return results;
  }

  private async refreshOne(view: (typeof MATVIEWS)[number]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('SET ROLE app_user');
      // Bare identifier — `view` only ever comes from the fixed `MATVIEWS` literal above, never user input.
      await client.query(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`);
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      client.release();
    }
  }
}
