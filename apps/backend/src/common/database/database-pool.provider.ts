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
