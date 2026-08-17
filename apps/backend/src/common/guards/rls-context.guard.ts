import { Injectable, CanActivate, ExecutionContext, Inject } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Pool, PoolClient } from 'pg';
import { DATABASE_POOL } from '../database/database-pool.provider';
import { ScopeService } from '../scope/scope.service';
import { JwtAccessPayload } from '../jwt/jwt-payload.interface';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

/** Attached by this guard; consumed by `RlsCleanupInterceptor` and by module services. */
export interface RequestWithDbContext {
  user?: JwtAccessPayload;
  dbClient?: PoolClient;
  locationScope?: string[] | null;
}

/**
 * Sets the Postgres session context the entire RLS layer rests on
 * (CONTRACTS.md §1.14 block 009): a `SET LOCAL ROLE`, then `app.user_id`,
 * `app.role`, `app.location_ids`. Runs AFTER `JwtAuthGuard` (needs
 * `request.user`) and BEFORE `PermissionsGuard`. Must be paired with
 * `RlsCleanupInterceptor`, which commits/rolls back and releases the
 * connection this guard checks out — see that file for why release alone
 * is not enough.
 *
 * INCIDENT (found by W2-A, reproduced live, fixed here): RLS was completely
 * bypassed in the running app despite correct session vars and correct
 * `FORCE ROW LEVEL SECURITY` policies (W1-C), because `DATABASE_URL`
 * connected as a Postgres SUPERUSER (`BYPASSRLS`) and nothing ever switched
 * away from that identity. Superusers bypass RLS unconditionally — `FORCE`
 * only forces enforcement onto the table's OWNER, it has no effect on a
 * superuser. The guard's own session vars were all correct and the
 * `PermissionsGuard` 403s still worked, which is exactly why it was
 * invisible: nothing about the request path *looked* broken. A Kasir's
 * session could read all 418 seeded sales rows instead of their outlet's 64.
 *
 * THE FIX — Phase 0, before anything else: `SET LOCAL ROLE app_user`. This
 * is the one line that actually closes the hole; everything below it was
 * already correct.
 *   - `app_user` is `NOLOGIN` (migration 009) — it can only be assumed via
 *     `SET ROLE` by a role granted membership in it, never connected to
 *     directly. The runtime login role (`mimi_app`, non-superuser) has that
 *     membership; the migration/seed role does not need it.
 *   - `LOCAL` (not session-wide `SET ROLE`) scopes the role switch to the
 *     current transaction, exactly like `set_config(..., true)` below —
 *     Postgres reverts to the original login role at COMMIT or ROLLBACK.
 *     `RlsCleanupInterceptor`'s guaranteed ROLLBACK is therefore this
 *     guard's OTHER half for two independent reasons now, not one: it
 *     clears the session variables AND un-does the role switch before the
 *     connection returns to the pool. A connection released mid-transaction
 *     (skipping that ROLLBACK) would hand the NEXT request a session still
 *     running as `app_user` instead of the pool's login role — see the
 *     "never leaks role or session state" test in the spec file.
 *   - Switching role away from a superuser is NOT superficial: Postgres
 *     evaluates RLS/BYPASSRLS against the CURRENT effective role, so
 *     `SET ROLE app_user` strips superuser bypass for the rest of the
 *     transaction even on a connection whose login role is itself a
 *     superuser. This is what makes phase 0 effective immediately, without
 *     waiting on `DATABASE_URL` being repointed at `mimi_app` — the repoint
 *     is defense in depth (a connection should never legitimately not need
 *     this), not what makes the fix work.
 *   - `common/database/database.module.ts` now REFUSES to boot if the
 *     connected login role has `rolsuper` or `rolbypassrls` — so config
 *     drift back to a superuser `DATABASE_URL` fails loudly at startup
 *     instead of silently re-opening this hole.
 *
 * TWO-PHASE SESSION CONTEXT (coordinator/architect decision, phases 1 and 2
 * below, now phases 1/2 following phase 0 above). An earlier version of
 * this guard called `ScopeService` BEFORE opening the RLS transaction,
 * which only worked if the app's Postgres role owned
 * `user_locations`/`drivers`/`surat_jalan` — but Postgres skips RLS for a
 * table owner unless the policy is `FORCE`d, so that shape would have
 * silently disabled RLS for every scope lookup while looking like it
 * worked. The fix is ordering, not a privileged connection:
 *   Phase 1 — set `app.user_id` and `app.role` from the verified JWT
 *   immediately. Neither needs a database read, so nothing has to be
 *   RLS-checked yet.
 *   Phase 2 — call `ScopeService.resolveLocationIds(client, user)` on THIS
 *   SAME client, now that phase 0's role switch and phase 1's session vars
 *   are live in the transaction. Its queries run UNDER RLS: narrow
 *   self-read policies on `user_locations`/`drivers`/`surat_jalan`/
 *   `sj_drops` (W1-C) are what let `app_user` read exactly its own
 *   assignment — not an RLS exemption. Only THEN is `app.location_ids` set,
 *   from that result.
 *
 * THE OTHER THING TO GET RIGHT: this guard hands out a connection from a
 * shared pool. If that connection is ever returned to the pool while the
 * transaction it opened is still live, the NEXT request to receive that
 * connection inherits the PREVIOUS request's role AND
 * `app.user_id`/`app.role`/`app.location_ids` — a cross-outlet data leak,
 * silently, in production. Two things make that impossible here:
 *   1. `SET LOCAL ROLE` and `set_config(..., is_local => true)` both scope
 *      to the CURRENT transaction only — Postgres reverts both automatically
 *      at COMMIT or ROLLBACK, never carrying either to the connection's next use.
 *   2. `RlsCleanupInterceptor` guarantees a ROLLBACK (safe even if a module
 *      service already COMMITted its own writes on this same client — see
 *      that file) runs before `client.release()`, on every request path:
 *      success, thrown exception, or guard rejection below.
 * The isolation test in `rls-context.guard.spec.ts` exercises exactly this:
 * two requests sharing one mock client must never observe each other's vars.
 * The regression test in `rls-context.guard.live-db.regression.spec.ts`
 * exercises the REAL failure this guard exists to prevent, through the
 * REAL pool, with no hand-issued `SET ROLE` anywhere in the test.
 *
 * Values are bound via `set_config($1, $2, true)`, never string-interpolated
 * into `SET LOCAL ...` — `SET` does not accept bind parameters but
 * `set_config()` does, so a crafted claim can never break out of the value.
 * `SET LOCAL ROLE app_user` has no bind parameter because the role name is
 * a fixed literal, never user input.
 */
@Injectable()
export class RlsContextGuard implements CanActivate {
  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly scope: ScopeService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithDbContext>();
    const user = request.user;
    if (!user) return false; // JwtAuthGuard should already have rejected; defensive only.

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // Phase 0 — THE fix: drop out of a superuser/BYPASSRLS login role for
      // the rest of this transaction. `LOCAL` reverts on COMMIT/ROLLBACK.
      await client.query('SET LOCAL ROLE app_user');

      // Phase 1 — from the verified JWT, no DB read required.
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
      await client.query(`SELECT set_config('app.role', $1, true)`, [user.roleKey]);

      // Phase 2 — resolve location scope UNDER RLS, now that phase 0's role
      // switch and phase 1's vars are live on THIS client/transaction. Must
      // not run before phases 0/1, and must not run on a different
      // (non-RLS-scoped) connection.
      const locationScope = await this.scope.resolveLocationIds(client, {
        sub: user.sub,
        roleKey: user.roleKey,
      });

      await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
        locationScope === null ? '' : locationScope.join(','),
      ]);

      request.dbClient = client;
      request.locationScope = locationScope;
      return true;
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      return false;
    }
  }
}
