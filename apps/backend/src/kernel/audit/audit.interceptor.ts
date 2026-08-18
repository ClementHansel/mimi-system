import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { Pool } from 'pg';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { AUDITED_KEY, AuditedOptions } from '../../common/decorators/audited.decorator';
import { REQUIRE_PERMISSION_KEY } from '../../common/decorators/require-permission.decorator';
import { RequestWithDbContext } from '../../common/guards/rls-context.guard';
import { candidateTableNames } from './table-name.util';

interface AuditableRequest extends RequestWithDbContext {
  method: string;
  params: Record<string, string>;
  body?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  originalUrl?: string;
  url: string;
}

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The `@Audited()` interceptor (D-09, FR-AUDIT-01/02) — the ONLY writer of
 * `audit_log`. Activated globally the moment `AuditModule` (kernel/audit)
 * provides this as `APP_INTERCEPTOR` from its own providers array; see that
 * module's file header and `common/decorators/audited.decorator.ts` for why
 * zero further edits to `app.module.ts` are needed (BUILD-PLAN §6 rule 2).
 *
 * WHAT IT CAPTURES, AND HOW, WITHOUT ANY PER-MODULE CODE:
 * - Actor: `request.user` (set by `JwtAuthGuard`, already populated by the
 *   time any interceptor's pre-handler logic runs — guards run before
 *   interceptors in Nest's request lifecycle).
 * - Entity id: `request.params.id` when the route follows the REST `:id`
 *   convention (true of every mutating endpoint in CONTRACTS.md §4 that
 *   isn't a bare `POST /collection`), falling back to the response body's
 *   own `id` field for creates (nothing existed before a create, so a
 *   pre-handler id is meaningless there anyway).
 * - Before value: a best-effort `SELECT * FROM <table> WHERE id = $1` on
 *   `request.dbClient` — the SAME connection/transaction `RlsContextGuard`
 *   already opened and RLS-scoped for this request, run BEFORE calling
 *   `next.handle()` (i.e. before the handler mutates anything). This is
 *   always safe to do regardless of interceptor registration order: guards
 *   populate `request.dbClient` before ANY interceptor's pre-handler phase
 *   runs, full stop. `table-name.util.ts` explains the entityType→table
 *   resolution and its graceful-degradation-to-null behaviour.
 * - After value: the handler's own response body. CONTRACTS.md §0 already
 *   requires "Mutations return the full updated resource unless noted" — so
 *   the after-diff falls out of that convention for free, no extra query.
 * - Reason: `request.body.reason` when supplied (FR-AUDIT-02's reject/amend
 *   convention across every approval-adjacent endpoint in CONTRACTS.md §5).
 *
 * WHY THE AUDIT ROW IS WRITTEN ON A FRESH CONNECTION, NOT `request.dbClient`:
 * `RlsCleanupInterceptor` (also `APP_INTERCEPTOR`, registered in
 * `app.module.ts`) rolls back and releases `request.dbClient` in ITS OWN
 * post-handler phase. Multiple `APP_INTERCEPTOR` providers contributed by
 * different modules are ordered by Nest's module-graph traversal, which this
 * interceptor has no control over and must not assume a side of. Reading
 * "before" pre-handler is always safe (see above); writing the audit row
 * post-handler is made equally safe by simply not depending on
 * `request.dbClient` still being open at that point — a short-lived
 * dedicated connection is checked out, given the SAME three session
 * variables (`app.user_id`/`app.role`/`app.location_ids`) `RlsContextGuard`
 * already resolved onto `request.user`/`request.locationScope`, and used for
 * exactly one transaction: `SET LOCAL ROLE app_user` (D-21/D-22 —
 * `DATABASE_POOL` connects as `mimi_app`, which holds no table grants of its
 * own; every fresh connection needs this before any query can touch
 * `audit_log`, mirroring `RlsContextGuard`'s own phase 0), then three
 * `set_config` calls + the `INSERT`, then `COMMIT`. `audit_log_insert`'s RLS
 * policy is `WITH CHECK (true)` (any authenticated session may append its
 * own row per migration 009), so beyond that role switch this never depends
 * on the caller's specific role.
 *
 * Failure to write an audit row NEVER fails the request — it is logged and
 * swallowed. An audit gap is bad; retroactively failing an already-decided
 * mutation because the audit write had a transient error would be worse.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger('AuditInterceptor');

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly reflector: Reflector,
  ) {}

  /**
   * Returns `Promise<Observable<...>>` (a shape `NestInterceptor` explicitly
   * supports) rather than a plain `Observable`, so the "before" read can be
   * fully AWAITED — both the `to_regclass` existence check and the actual
   * `SELECT` — before `next.handle()` is ever called. This is not just
   * tidiness: `next.handle()`'s Observable is only evaluated once something
   * subscribes to it (Nest does so immediately once this method's promise
   * resolves), and the route handler that runs on subscription is what
   * mutates the row. If the "before" read were left unawaited here (fired
   * off and joined later via a `.then()` inside `tap()`), it would still be
   * in flight — sharing the SAME `request.dbClient` connection as the
   * handler — when the handler's own query gets queued right behind it;
   * `pg` serializes queries per connection strictly in call order, so a
   * two-round-trip "before" read (existence check, then `SELECT`) can lose
   * that race and read the ALREADY-mutated row. Awaiting it here closes
   * that window entirely.
   */
  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle();

    const options = this.reflector.getAllAndOverride<AuditedOptions | undefined>(AUDITED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!options) return next.handle();

    const request = context.switchToHttp().getRequest<AuditableRequest>();
    if (!request.user || !MUTATING_METHODS.has(request.method)) return next.handle();

    const entityType = options.entityType ?? this.deriveModule(request) ?? 'unknown';
    const preEntityId = this.extractParamId(request);
    const permissionKeys = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRE_PERMISSION_KEY,
      [context.getHandler(), context.getClass()],
    );

    const before = await this.captureBefore(request, entityType, preEntityId);

    return next.handle().pipe(
      tap({
        next: (responseBody) => {
          const entityId = preEntityId ?? this.extractResponseId(responseBody);
          void this.writeAuditRow(
            request,
            options,
            entityType,
            entityId,
            before,
            responseBody,
            permissionKeys,
          ).catch((err) => {
            this.logger.error(
              `Failed to write audit row for ${entityType}/${entityId ?? '?'}: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
        },
        // No audit row on error — nothing durable happened, so nothing to record.
      }),
    );
  }

  private extractParamId(request: AuditableRequest): string | null {
    const candidate = request.params?.id ?? request.params?.documentId;
    return typeof candidate === 'string' && UUID_RE.test(candidate) ? candidate : null;
  }

  private extractResponseId(body: unknown): string | null {
    if (body && typeof body === 'object' && 'id' in body) {
      const id = (body as Record<string, unknown>).id;
      return typeof id === 'string' && UUID_RE.test(id) ? id : null;
    }
    return null;
  }

  private deriveModule(request: AuditableRequest): string | null {
    // '/api/replenishment/:id/approve' → 'replenishment'. setGlobalPrefix strips
    // nothing from request.url at this layer, so the first non-empty segment
    // (skipping a literal 'api') is the module slug.
    const segments = (request.originalUrl ?? request.url ?? '')
      .split('?')[0]!
      .split('/')
      .filter(Boolean);
    const first = segments[0] === 'api' ? segments[1] : segments[0];
    return first ?? null;
  }

  private async captureBefore(
    request: AuditableRequest,
    entityType: string,
    entityId: string | null,
  ): Promise<unknown> {
    if (!entityId || !request.dbClient) return null;
    const client = request.dbClient;
    for (const table of candidateTableNames(entityType)) {
      try {
        // `to_regclass` resolves a table name to its OID or NULL — unlike
        // `SELECT ... FROM <nonexistent>`, it NEVER throws, so a wrong
        // candidate never aborts the caller's transaction (a real risk here:
        // Postgres poisons an entire transaction on ANY statement error
        // until ROLLBACK, which would break the module handler about to run
        // on this same client). Only a name confirmed to exist is ever used
        // in an actual SELECT.
        const exists = await client.query('SELECT to_regclass($1) AS reg', [`public.${table}`]);
        if (!exists.rows[0]?.reg) continue;
        // Table name came from a closed set of heuristic candidates (never
        // client input) and is now confirmed to exist, so safe to interpolate;
        // the id itself stays bound.
        const result = await client.query(`SELECT * FROM "${table}" WHERE id = $1`, [entityId]);
        return result.rows[0] ?? null; // Row not found (or not visible under RLS) — no more candidates to try meaningfully.
      } catch {
        return null; // Any query error (RLS denial, bad column, etc.) — degrade silently rather than risk the transaction.
      }
    }
    return null;
  }

  private async writeAuditRow(
    request: AuditableRequest,
    options: AuditedOptions,
    entityType: string,
    entityId: string | null,
    beforeValue: unknown,
    afterValue: unknown,
    permissionKeys: string[] | undefined,
  ): Promise<void> {
    const user = request.user!;
    const module = options.module ?? this.deriveModule(request) ?? 'unknown';
    const action = options.action ?? this.deriveAction(request, permissionKeys);
    const reason = typeof request.body?.reason === 'string' ? request.body.reason : null;
    const locationId = this.extractLocationId(request);
    const ip = request.ip ?? null;
    const deviceIdHeader = request.headers['x-device-id'];
    const deviceId =
      typeof deviceIdHeader === 'string' && UUID_RE.test(deviceIdHeader) ? deviceIdHeader : null;
    const offlineAuthorized = request.body?.offlineAuthorized === true;

    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // D-21/D-22: `DATABASE_POOL` connects as `mimi_app`, which holds NO
      // table grants of its own — this fresh connection needs the same
      // `SET LOCAL ROLE app_user` phase-0 switch `RlsContextGuard` does for
      // a normal request before ANY query (including the `set_config` calls
      // below, which are harmless without it, but the INSERT that follows
      // would fail `permission denied` without this line).
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [user.sub]);
      await client.query(`SELECT set_config('app.role', $1, true)`, [user.roleKey]);
      await client.query(`SELECT set_config('app.location_ids', $1, true)`, [
        (request.locationScope ?? []).join(','),
      ]);
      await client.query(
        `INSERT INTO audit_log
           (user_id, role_key, location_id, module, action, entity_type, entity_id,
            before_value, after_value, reason, ip_address, device_id, offline_authorized)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          user.sub,
          user.roleKey,
          locationId,
          module,
          action,
          entityType,
          entityId,
          this.safeJson(beforeValue),
          this.safeJson(afterValue),
          reason,
          ip,
          deviceId,
          offlineAuthorized,
        ],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private deriveAction(request: AuditableRequest, permissionKeys: string[] | undefined): string {
    if (permissionKeys?.length) return permissionKeys[0]!;
    const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
    return `${request.method} ${path}`;
  }

  /**
   * Best-effort `audit_log.location_id`: an explicit `locationId` in the
   * body/params wins (most mutations carry one — `locationId` on a create,
   * or a location-scoped route param); otherwise, a caller scoped to
   * exactly one location (the common case for Kepala Gudang/Supervisor/
   * Leader Outlet/Kasir/Driver — CONTRACTS.md §1.14) is unambiguous. A
   * central role's multi-location scope has no single answer, so it stays
   * null rather than guessing.
   */
  private extractLocationId(request: AuditableRequest): string | null {
    const explicit =
      (request.body?.locationId as string | undefined) ??
      (request.params?.locationId as string | undefined);
    if (typeof explicit === 'string' && UUID_RE.test(explicit)) return explicit;
    const scope = request.locationScope;
    if (scope && scope.length === 1) return scope[0]!;
    return null;
  }

  private safeJson(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
}
