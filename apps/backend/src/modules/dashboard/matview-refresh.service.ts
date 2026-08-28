import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool } from 'pg';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { DashboardGateway } from './dashboard.gateway';

export const REFRESH_INTERVAL_MS = 5 * 60_000; // "every 5 min" per migration 100's own header comment.

// `mv_delivery_recap_daily` was dropped by migration 261 (D-21): its grain
// mixed per-item quantities with per-day counts, so summing it double-counted,
// and both would-be consumers had already written themselves notes to avoid
// it. Refreshing a view nobody reads is write amplification on a five-minute
// timer. FR-LOG-04 is served by `RecapService.dailyRecap()` off the base
// tables.
const MATVIEWS = ['mv_sales_daily', 'mv_item_usage_daily', 'mv_employee_kpi_daily'] as const;

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
 * PRIVILEGE — RESOLVED 2026-08-23. The note that used to be here was WRONG, and
 * expensively so: it claimed "Postgres does not require table OWNERSHIP for
 * REFRESH MATERIALIZED VIEW CONCURRENTLY, only SELECT". It does require
 * ownership. The four views are owned by `mimi` and the app runs as `app_user`,
 * so every tick of this service since it was written failed with
 *
 *     must be owner of materialized view mv_sales_daily
 *
 * caught per view and logged. The logging was honest; nobody was reading it, so
 * four dashboards sat frozen at whatever the last migration built.
 *
 * The mechanism to do this correctly had existed since migration 219 —
 * `refresh_dashboard_matview()`, SECURITY DEFINER, allow-listed to these four
 * views, EXECUTE granted to `app_user` — written for exactly this failure and
 * never wired up. `refreshOne` now calls it, which is a one-line change.
 *
 * Migration 236 asserts the database half (ownership stays with the DDL role,
 * the grant is in place) and fails if a refresh through that function leaves a
 * rollup empty; `matview-refresh.integration.spec.ts` asserts a real pass
 * returns `ok` for every view. Both exist because the failure mode here is
 * invisible from the outside: the endpoint answers, the numbers look plausible,
 * and nothing is red.
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
    void this.refreshAll().catch((err) =>
      this.logger.error(`initial matview refresh failed: ${(err as Error).message}`),
    );
    this.timer = setInterval(() => {
      void this.refreshAll().catch((err) =>
        this.logger.error(`matview refresh tick failed: ${(err as Error).message}`),
      );
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
      // `refresh_dashboard_matview()` (migration 219), NOT a bare REFRESH.
      //
      // A bare `REFRESH MATERIALIZED VIEW` requires OWNERSHIP of the view, and
      // the four rollups are owned by the DDL role — so every tick of this
      // service failed with "must be owner of materialized view
      // mv_sales_daily", per-view caught and logged, for as long as it has
      // existed. The function is SECURITY DEFINER, owned by that DDL role, and
      // allow-lists these four names, so the runtime role gains exactly one
      // capability rather than ownership (which also carries DROP and ALTER).
      //
      // It also fixes visibility, which the obvious "just transfer ownership"
      // fix silently breaks: a refresh runs the defining query under the RLS of
      // the view's OWNER, so an `app_user`-owned view refreshed without an
      // `app.*` context writes an EMPTY rollup and every dashboard then reports
      // a confident zero. Definer-owned means the refresh sees everything, with
      // no session context to set and nothing to leak back to the pool.
      await client.query('SELECT refresh_dashboard_matview($1)', [view]);
    } finally {
      await client.query('RESET ROLE').catch(() => {});
      client.release();
    }
  }
}
