import { Injectable, Logger, NestInterceptor, ExecutionContext, CallHandler } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { Observable, from, throwError } from 'rxjs';
import { concatMap, catchError, map } from 'rxjs/operators';
import { RequestWithDbContext } from '../guards/rls-context.guard';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

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
 *
 * BE-TXN-ROLLBACK GUARD (added after that ticket: `stock-opname` had zero
 * `withWrite`/`COMMIT` calls anywhere, so every one of its mutations was
 * silently discarded by exactly this `ROLLBACK` — `POST /api/stock-opname`
 * returned 201 with a full body, `GET` on that id 404'd, and nothing in the
 * request/response cycle ever surfaced it). On a SUCCESSFUL response to a
 * mutating HTTP method, `warnIfUncommittedWrite` asks Postgres
 * `pg_current_xact_id_if_assigned()` — non-null ONLY if this transaction has
 * actually executed a write (Postgres assigns a real xid lazily, on first
 * write, never for a pure read) — immediately before the `ROLLBACK` below.
 * A non-null xid at that point is unambiguous: the handler wrote real data
 * on `request.dbClient` and never committed it, and this `ROLLBACK` is about
 * to erase it, same as it erased every stock-opname write. There is no
 * legitimate reason for that combination to occur (a successful mutating
 * response is never supposed to want its own writes discarded), so this is
 * a precise signal, not a heuristic that can misfire on a route that
 * legitimately delegates its commit elsewhere (`dashboard`'s matview
 * refresh, `sync`'s R1 reconciliation) — those never write on
 * `request.dbClient` at all, so their xid is always null here and they are
 * silently unaffected by this check, exactly as before.
 *
 * Always logs a `Logger.warn` (cheap, safe in every environment, and the
 * only way this would ever have been noticed for stock-opname without
 * re-reading the module). Additionally THROWS outside production
 * (`NODE_ENV !== 'production'`) — turning the silent 201-then-404 into an
 * immediate loud failure in dev/CI/tests, which is safe to do here
 * specifically because `release()` runs inside `concatMap`/`catchError`
 * BEFORE Nest serializes the response (the observable hasn't completed
 * yet), so throwing swaps the outgoing response for an error response
 * instead of corrupting an already-sent one. Never throws in production —
 * a false negative here (missing a warning) is preferable to turning a
 * one-off diagnostic-query failure into a production outage; the `warn` log
 * is what ops relies on there.
 */
@Injectable()
export class RlsCleanupInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RlsCleanupInterceptor.name);

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<RequestWithDbContext & Request>();

    return next.handle().pipe(
      concatMap((data) => from(this.release(request, 'success')).pipe(map(() => data))),
      catchError((err) => from(this.release(request, 'error')).pipe(concatMap(() => throwError(() => err)))),
    );
  }

  private async release(request: RequestWithDbContext & Request, outcome: 'success' | 'error'): Promise<void> {
    const client = request.dbClient;
    if (!client) return;
    // Clear the reference first: guarantees a single release even if this
    // interceptor is ever invoked twice for the same request (defensive).
    request.dbClient = undefined;
    try {
      // Deliberately OUTSIDE the ROLLBACK try/catch below: `warnIfUncommittedWrite`'s non-production
      // `throw` must propagate to the caller, not be swallowed by the "ROLLBACK already a no-op"
      // catch that follows — the `finally` still guarantees ROLLBACK+release run regardless.
      if (outcome === 'success' && MUTATING_METHODS.has(request.method)) {
        await this.warnIfUncommittedWrite(client, request);
      }
    } finally {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Transaction already closed by a module service's own COMMIT — expected, not an error.
      } finally {
        client.release();
      }
    }
  }

  /** See this file's class doc comment ("BE-TXN-ROLLBACK GUARD") for the full rationale. */
  private async warnIfUncommittedWrite(client: PoolClient, request: RequestWithDbContext & Request): Promise<void> {
    let xid: string | null = null;
    try {
      const res = await client.query<{ xid: string | null }>(`SELECT pg_current_xact_id_if_assigned()::text AS xid`);
      xid = res.rows[0]?.xid ?? null;
    } catch {
      // Best-effort diagnostic only — a failure here (e.g. an already-aborted transaction from a
      // module bug elsewhere) must never block the real ROLLBACK/release that follows.
      return;
    }
    if (!xid) return; // no write ever ran on this client — nothing was at risk, this is the normal case.

    const message =
      `BE-TXN-ROLLBACK: ${request.method} ${request.originalUrl ?? request.url} wrote to the database ` +
      `(xact ${xid}) and returned a SUCCESSFUL response, but the handler never committed — ` +
      `RlsCleanupInterceptor's unconditional ROLLBACK is about to silently discard that write. ` +
      `This is the exact shape of the stock-opname data-loss bug: wrap the mutating service method ` +
      `in withWrite() (see any modules/*/db-tx.ts, e.g. modules/waste-return/db-tx.ts).`;
    this.logger.warn(message);

    if (process.env.NODE_ENV !== 'production') {
      throw new Error(message);
    }
  }
}
