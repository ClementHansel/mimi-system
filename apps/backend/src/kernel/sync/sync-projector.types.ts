/**
 * The domain-projection hook — closes the gap the coordinator/W3-08 found:
 * `SyncIngestService` durably logs, dedupes, and conflict-checks a pushed
 * event, but nothing turned it into a domain row (`sales`, `attendance`,
 * `waste_records`, ...) or a stock posting. Without this, an offline sale
 * syncs up and then never exists in any report, dashboard, journal, or
 * stock figure — D-02 and the three-tier design (RISK-P3) stop one step
 * short of working.
 *
 * SHAPE: a plain registry (`SyncProjectorRegistry`), NOT a NestJS
 * multi-provider token. Domain modules (Wave 3+) already depend on
 * `kernel/sync`'s direction (kernel never imports a domain module — that
 * would invert BUILD-PLAN's layering and require `kernel/sync` to import
 * `PosModule`/`HrModule`/etc., which it must never do). So each domain
 * module SELF-REGISTERS: implement `SyncProjector`, inject
 * `SyncProjectorRegistry` (exported by `SyncEngineModule`, which the domain
 * module already imports for other kernel services), and call
 * `registry.register(this)` from `OnModuleInit`. See
 * `sync-projector-registry.service.ts`'s header for the exact wiring.
 *
 * OWNERSHIP: `kernel/sync` owns this interface, the registry, and the
 * call site in `SyncIngestService.runApplyHooks`. Each Wave 3+ module owns
 * writing its OWN `SyncProjector` implementation against ITS OWN tables —
 * `kernel/sync` never writes to `sales`/`attendance`/`waste_records`/etc.
 * directly, matching CONSTRAINTS' "you touched only your kernel directory."
 */
import type { PoolClient } from 'pg';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';

export interface ProjectionContext {
  /**
   * `true` when apply-time conflict detection (`conflict-detector.service.ts`,
   * SYNC-PROTOCOL §5.2 C2/C3/C8) already determined this event is NOT the
   * winning fact for its comparison group. Handling differs per conflict
   * kind — treat this as "do not post financial/stock effect" by default:
   *  - C2 (`sj_drops.received` twice), C3 (decision race, any entity in
   *    `void_refunds`/`replenishment_requests`/`waste_records`): the LOSING
   *    event must NOT post its stock/business effect a second time — the fact
   *    is already recorded in `sync_events`/`sync_conflicts`; the projector
   *    should skip (or record a disputed/inert row) rather than write a
   *    second live effect.
   *  - C8 (`online_orders` duplicate platform order): SYNC-PROTOCOL §5.2
   *    says "both kept... revenue reports use first" — a projector MAY still
   *    write its own domain row for the loser (the order really happened
   *    twice) but must exclude it from revenue aggregation. Projectors that
   *    don't need this nuance can safely fall back to "skip" — the
   *    conservative default that never double-counts.
   * C1 (opname double-count) and C4 (attendance overlap) never set this —
   * both sides are legitimately recorded facts pending human review, so a
   * projector always writes its row for those.
   */
  isConflictLoser: boolean;
}

export interface SyncProjector {
  /**
   * The exact `"<entity>.<op>"` keys this projector materializes — e.g.
   * `['sales.completed']` or `['pos_shifts.opened', 'pos_shifts.closed']`.
   * Registering the SAME key twice (two projectors claiming one op) is a
   * startup error (`SyncProjectorRegistry.register` throws) — ownership of
   * an op is exclusive, mirroring BUILD-PLAN's "one agent, one directory."
   */
  readonly handles: readonly string[];

  /**
   * Materializes one applied device/node-origin event into its domain
   * table(s). Called EXACTLY ONCE per `event_id` under normal ingest
   * (SyncIngestService dedupes before ever reaching this), but MUST still
   * be idempotent — a re-projection sweep (retrying a `projection_failed`
   * conflict-queue entry, or a rare crash-retry) may call it again for the
   * SAME event. Use the domain's own client-minted idempotency key from
   * `payload.data` (e.g. `sales.completed`'s `clientId` — see
   * `packages/sync-protocol/src/schema/registry.ts`), NOT `event.eventId`
   * alone, since that's the pattern this codebase's Wave 3 modules already
   * use for their REST paths (`PosSaleService.create`'s `input.clientId`
   * dedup check) — reuse that exact check so the REST/online path and the
   * offline/sync path can never both materialize the same client action.
   *
   * MUST run on `client` — the SAME transaction `SyncIngestService` is
   * mid-way through committing the event's `sync_events` row in. Throwing
   * here does NOT roll back that row: `SyncProjectorRegistry.project` wraps
   * every call in a `SAVEPOINT` and rolls back to it (not the whole
   * transaction) on failure, recording a `sync_conflicts` exception instead
   * — SYNC-PROTOCOL §4.4's "log ingest and projection are separate stages
   * precisely so a projector bug cannot reject facts," realized as one
   * transaction with an inner rollback boundary rather than two
   * transactions with an ack race between them.
   *
   * STOCK: any projector whose op moves stock MUST call
   * `StockLedgerService.post`/`postTransfer` with `mode: 'fact'`, NEVER
   * `'strict'` (D-17a) — the chicken really was sold/received/wasted; a
   * `'strict'`-mode rejection would silently drop a real fact. `'fact'`
   * mode still applies the movement even if it drives a balance negative
   * and opens its own `stock_reconciliations` exception (C5) — that is the
   * correct outcome here, not a bug to route around.
   */
  project(client: PoolClient, event: SyncEventEnvelope, context: ProjectionContext): Promise<void>;
}
