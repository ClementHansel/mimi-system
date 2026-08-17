import { Injectable, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import { Observable, from, throwError } from 'rxjs';
import { concatMap, catchError, map } from 'rxjs/operators';
import { RequestWithDbContext } from '../guards/rls-context.guard';

/**
 * Companion to `RlsContextGuard`. A `CanActivate` guard cannot run code AFTER
 * the handler — only an interceptor wraps both sides — so the connection
 * `RlsContextGuard` checks out is released HERE, deterministically, on every
 * outcome: success, handler exception, or a downstream guard (e.g.
 * `PermissionsGuard`) rejecting first.
 *
 * Must be registered wherever `RlsContextGuard` is (globally, in
 * `app.module.ts`, via `APP_INTERCEPTOR` — see BUILD-PLAN §6 rule 2: no
 * later module ever needs to remember to add this).
 *
 * Cleanup always issues `ROLLBACK`, never `COMMIT`, deliberately: by the
 * time this runs, a module service may already have run its own
 * `BEGIN…COMMIT` on this same client (the AIRE/inventory convention this
 * repo's Wave 3/4 modules copy — see `apps/backend/src/modules/inventory`
 * in the reference codebase). In that case the transaction `RlsContextGuard`
 * opened is already closed, and `ROLLBACK` here is a harmless no-op (Postgres
 * emits a NOTICE, not an error) that only guarantees no session state
 * survives to the connection's next checkout. If the transaction is instead
 * still open (a pure read, or a rejection before any service ran), `ROLLBACK`
 * safely ends it — reads are unaffected, and nothing this guard's own `BEGIN`
 * started was ever asserted as data that must be kept.
 */
@Injectable()
export class RlsCleanupInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithDbContext>();

    return next.handle().pipe(
      concatMap((data) => from(this.release(request)).pipe(map(() => data))),
      catchError((err) => from(this.release(request)).pipe(concatMap(() => throwError(() => err)))),
    );
  }

  private async release(request: RequestWithDbContext): Promise<void> {
    const client = request.dbClient;
    if (!client) return;
    // Clear the reference first: guarantees a single release even if this
    // interceptor is ever invoked twice for the same request (defensive).
    request.dbClient = undefined;
    try {
      await client.query('ROLLBACK');
    } catch {
      // Transaction already closed by a module service's own COMMIT — expected, not an error.
    } finally {
      client.release();
    }
  }
}
