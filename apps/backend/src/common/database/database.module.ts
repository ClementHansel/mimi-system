import { Global, Module, OnModuleDestroy, OnModuleInit, Inject, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { DATABASE_POOL, DatabasePoolProvider } from './database-pool.provider';

/**
 * Global provider for the pooled `pg.Pool` (DATABASE_POOL) so any module can
 * inject it without per-module wiring — see BUILD-PLAN §6 rule 2 (shared
 * registry files are pre-populated once, in Wave 1).
 *
 * BOOT-TIME REFUSAL (coordinator-mandated, part of the RLS-bypass incident
 * fix). `RlsContextGuard`'s `SET LOCAL ROLE app_user` is what makes RLS
 * enforce for THIS connection regardless of the login role's own privileges
 * — but that guarantee is worthless if the login role itself has
 * `BYPASSRLS`, because a superuser session that never runs any guarded
 * route (a raw `pool.query()` from application code, a future migration
 * runner accidentally pointed at the wrong URL, a health-check style
 * direct query) would silently read/write past every policy. Three
 * independent mechanisms have to hold for tenant isolation to work: a
 * non-superuser login role, `SET LOCAL ROLE`, `FORCE ROW LEVEL SECURITY`.
 * Config drift on the FIRST one — a `.env` pointed at the wrong role,
 * months from now — produces an app that works perfectly, guards that
 * still return their 403s, and cross-outlet data that is quietly readable.
 * That is undetectable in production without an explicit check, so this
 * one runs unconditionally (no `NODE_ENV` gate — a developer pointed at a
 * superuser locally is exactly who should be told) and is fatal, not a
 * warning: `process.exit(1)` before the app finishes starting.
 */
@Global()
@Module({
  providers: [DatabasePoolProvider],
  exports: [DatabasePoolProvider],
})
export class DatabaseModule implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('DatabaseModule');

  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  async onModuleInit(): Promise<void> {
    const res = await this.pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
    );
    const row = res.rows[0];

    if (!row) {
      // Should be impossible (a connected session always has a current_user
      // row in pg_roles) — refuse to boot on an unrecognized state too,
      // rather than assume it's safe. `return` after `process.exit(1)`
      // deliberately, not just for lint's benefit: `process.exit` in a test
      // double (or, in principle, a future custom exit handler) may not
      // actually halt execution, and this code must never fall through to
      // dereference `row` when it's known to be absent regardless.
      this.logger.error(
        `FATAL: could not determine the connected role's privileges (no pg_roles row for current_user). Refusing to start.`,
      );
      process.exit(1);
      return;
    }

    if (row.rolsuper || row.rolbypassrls) {
      this.logger.error(
        `FATAL: DATABASE_URL's connected role has RLS-bypassing privileges ` +
          `(rolsuper=${row.rolsuper}, rolbypassrls=${row.rolbypassrls}). ` +
          `Every location-scoping RLS policy in this system would be silently ` +
          `inert for this connection — RlsContextGuard's SET LOCAL ROLE cannot ` +
          `compensate for a login role that already bypasses row security. ` +
          `Point DATABASE_URL at the non-superuser runtime role (mimi_app), ` +
          `not the migration/owner role. Refusing to start.`,
      );
      process.exit(1);
    }
  }

  /** Graceful shutdown (main.ts calls `app.enableShutdownHooks()`). */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
