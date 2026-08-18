/**
 * The projector registry — see `sync-projector.types.ts` for the interface
 * and the full design rationale. Wave 3+ modules self-register:
 *
 * ```ts
 * // modules/pos/pos.module.ts
 * @Module({
 *   imports: [SyncEngineModule, StockLedgerModule, ...],
 *   providers: [...existing providers..., PosSyncProjector],
 * })
 * export class PosModule implements OnModuleInit {
 *   constructor(
 *     private readonly registry: SyncProjectorRegistry,
 *     private readonly projector: PosSyncProjector,
 *   ) {}
 *   onModuleInit() {
 *     this.registry.register(this.projector);
 *   }
 * }
 * ```
 *
 * `PosSyncProjector` (the domain module's OWN class, implementing
 * `SyncProjector`) is Wave 3's to write, against ITS OWN tables — this
 * file never imports a domain module and never knows `sales`/`attendance`/
 * `waste_records` exist as anything other than strings.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectionContext, SyncProjector } from './sync-projector.types';

export type ProjectionOutcome = { ok: true; ran: boolean } | { ok: false; error: string };

const SAVEPOINT_NAME_RE = /^[0-9a-f]{32}$/;

@Injectable()
export class SyncProjectorRegistry {
  private readonly logger = new Logger(SyncProjectorRegistry.name);
  private readonly byKey = new Map<string, SyncProjector>();

  /** Called once per projector, from the owning domain module's `OnModuleInit` (see file header). */
  register(projector: SyncProjector): void {
    for (const key of projector.handles) {
      const existing = this.byKey.get(key);
      if (existing) {
        throw new Error(
          `SyncProjectorRegistry: duplicate registration for '${key}' — already claimed by ${existing.constructor.name}, cannot also be claimed by ${projector.constructor.name}`,
        );
      }
      this.byKey.set(key, projector);
    }
  }

  isRegistered(entity: string, op: string): boolean {
    return this.byKey.has(`${entity}.${op}`);
  }

  /**
   * Runs the registered projector for `event`, if any, isolated by a
   * `SAVEPOINT` so a projector exception rolls back ONLY its own writes —
   * never the `sync_events` insert this runs alongside in the same
   * transaction (`sync-ingest.service.ts`'s `runApplyHooks`). Returns
   * `{ok:false}` rather than throwing so the caller can route the failure
   * to `sync_conflicts` and still commit the fact.
   *
   * No projector registered for `(entity, op)` is NOT an error — most
   * entities are pull-only (class M) or have no offline write path yet
   * (a Wave 3+ module simply hasn't landed); `{ok:true, ran:false}` says so
   * explicitly rather than silently looking identical to success.
   */
  async project(
    client: PoolClient,
    event: SyncEventEnvelope,
    context: ProjectionContext,
  ): Promise<ProjectionOutcome> {
    const projector = this.byKey.get(`${event.entity}.${event.op}`);
    if (!projector) return { ok: true, ran: false };

    // SAVEPOINT identifiers cannot be bind parameters (same restriction as `SET ROLE`, see
    // `system-rls-context.ts`) — safe here because `event.eventId` is a server-validated UUIDv7
    // (regex-checked, never raw user input at this point), not string-interpolated from a request body.
    const savepoint = `sp_${event.eventId.replace(/-/g, '')}`;
    if (!SAVEPOINT_NAME_RE.test(savepoint.slice(3))) {
      return {
        ok: false,
        error: `refusing to run projector: event_id '${event.eventId}' is not a well-formed UUID`,
      };
    }

    await client.query(`SAVEPOINT ${savepoint}`);
    try {
      await projector.project(client, event, context);
      await client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return { ok: true, ran: true };
    } catch (err) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `projector for '${event.entity}.${event.op}' failed on event ${event.eventId}: ${message}`,
      );
      return { ok: false, error: message };
    }
  }
}
