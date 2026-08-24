import { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';

export const DATABASE_POOL = 'DATABASE_POOL';

/**
 * Raw `pg.Pool` — the ONLY database access surface in this codebase (BUILD-PLAN
 * §2: "raw pg, no ORM"). Sized for NFR-01 (150 concurrent users): each HTTP
 * request holds a connection for the lifetime of its RLS transaction
 * (RlsContextGuard → RlsCleanupInterceptor), so `max` bounds how many requests
 * can be mid-flight against Postgres at once, not how many users are logged
 * in. Tune via `DB_POOL_MAX`/`DB_POOL_MIN` if 150 concurrent users saturate it
 * at load-test time (BUILD-PLAN Wave 6 W6-05).
 *
 * ## W6-05 RESULT, 2026-08-25 — they do saturate it, and this comment was right
 *
 * The NFR-01 gate (150 VUs, `perf/k6/nfr01-150-concurrent.js`) was finally run,
 * against a real quarter of trading — 219,549 sales, 473,381 sale lines:
 *
 *   `max` = 20 (this default): 72.7% of requests FAILED, all with
 *                              "timeout exceeded when trying to connect".
 *                              Not slowness — the pool simply ran out.
 *   `max` = 70:                40.4% failed, same error, now concentrated on
 *                              `POST /api/pos/sales`.
 *
 * So the pool was a real ceiling and raising it is a real gain — but it is not
 * the whole story, and the default is NOT raised here on purpose. Postgres is
 * at `max_connections = 100`, and this value is per BACKEND PROCESS: the branch
 * -node fleet (W5-07) runs additional instances against the same database, so a
 * high default would let a handful of nodes exhaust the server's connection
 * slots and lock everyone out — a worse failure than a saturated pool, because
 * it takes down the outlets that were working.
 *
 * Set `DB_POOL_MAX` per deployment, sized as
 * `max_connections` minus headroom, divided by the number of backend processes.
 *
 * WHAT THE REMAINING 40% MEANS: it is no longer a misconfiguration. The
 * measurement ran on the shared demo VPS — 4 cores, ~46 containers, eight other
 * projects — with the backend capped at 2 CPUs and the load generator at 1. At
 * 150 VUs that box is CPU-bound, so the number describes the hardware more than
 * the software. NFR-01 remains UNPROVEN rather than failed: it needs the
 * dedicated hardware in `docs/HARDWARE.md`, not this box. Single-request
 * latency, which this box CAN measure honestly, is ~0.37s against a 3s budget.
 */
export const DatabasePoolProvider: Provider = {
  provide: DATABASE_POOL,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Pool => {
    return new Pool({
      connectionString: config.get<string>(
        'DATABASE_URL',
        'postgres://mimi:mimi_secret@localhost:5432/mimi',
      ),
      max: config.get<number>('DB_POOL_MAX', 20),
      min: config.get<number>('DB_POOL_MIN', 2),
      idleTimeoutMillis: config.get<number>('DB_POOL_IDLE_TIMEOUT_MS', 30_000),
      connectionTimeoutMillis: config.get<number>('DB_POOL_CONNECT_TIMEOUT_MS', 5_000),
    });
  },
};
