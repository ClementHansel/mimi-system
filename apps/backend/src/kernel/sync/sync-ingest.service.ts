/**
 * Writes the durable `relay_received_at` back onto the in-memory envelope
 * (D-10).
 *
 * Mutation is deliberate and safe: the envelope is this batch's own decoded
 * object, not shared state, and every consumer downstream of the insert wants
 * the stored value rather than whatever the device happened to send. Without
 * it, `OfflineAuthService` falls back to `new Date().toISOString()`, so §7.4's
 * expiry check compares a credential against the moment the cloud got round to
 * the event instead of the moment it was received — the two diverge by however
 * long a node was offline before relaying, which is exactly the window offline
 * authorization exists for.
 *
 * A `null` stamp is left alone: that is a legitimately un-stamped relay
 * (`relayed_via_node_id` set, node stamp pending), and overwriting it with a
 * cloud time would assert something untrue.
 */
function stampRelayReceivedAt(event: SyncEventEnvelope, stored: string | null): void {
  if (stored !== null) event.relayReceivedAt = stored;
}

/**
 * The push-ingest pipeline (SYNC-PROTOCOL §4.3/§4.4, §3.4). The single
 * entry point every batch — device-direct today, node-relayed once M22
 * lands — flows through. Implements, in order (§3.4):
 *
 *   1. entity/op known, payload well-formed -> else `malformed`
 *   2. direction legal for the pusher's tier -> else `authority_violation`
 *      (`canOriginate` from `@mimi/sync-protocol`, executable authority data)
 *   3. `location_id` matches the origin device's REGISTERED location (never
 *      the client's claim) -> else `authority_violation`
 *   4. actor RBAC-at-`occurred_at` — see the note on `checkAuthority` below;
 *      this step is NOT enforced here (see the note for why + what it means
 *      for future domain modules).
 *
 * Ordering/gap logic is `@mimi/sync-protocol/cursor`'s `processOriginBatch`,
 * used as-is (never reimplemented) — this file only wires its output to
 * durable storage per origin, transactionally (§4.3: "all-or-none within
 * one origin's contiguous run; distinct origins are independent").
 *
 * Two-level ack (§4.3 NFR-06): the cloud IS the terminal tier, so
 * `accepted_through` and `confirmed_through` always coincide here — the
 * distinction only has teeth at a branch node (W2-F), which relays and
 * learns `confirmed_through` from ITS OWN push to cloud.
 */
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { UUID } from '@mimi/shared';
import { SyncOriginType } from '@mimi/shared';
import {
  canOriginate,
  groupByOrigin,
  isRegisteredPayloadKey,
  processOriginBatch,
  sortByClientSeq,
  validatePayloadData,
  type SyncEventEnvelope,
  type SyncPushAck,
  type SyncPushBatch,
} from '@mimi/sync-protocol';
import { AUTHORITY } from '@mimi/sync-protocol';
import type { PoolClient } from 'pg';
import { SyncEventsRepository } from './sync-events.repository';
import { ConflictDetectorService } from './conflict-detector.service';
import { OfflineAuthService } from './offline-auth.service';
import { ReconciliationService } from './reconciliation.service';
import { SyncProjectorRegistry } from './sync-projector-registry.service';
import type { SyncEventRow } from './db-rows';

const MAX_PAYLOAD_BYTES = 256 * 1024;

export type IngestRejectCode =
  'authority_violation' | 'malformed' | 'seq_conflict' | 'payload_version_unsupported';

export interface AuthorityVerdict {
  ok: boolean;
  code?: IngestRejectCode;
  detail?: string;
}

/**
 * Rebuilds the wire envelope for a row being promoted out of
 * `pending_dependency`.
 *
 * D-10 — `relayReceivedAt`/`relayedViaNodeId` are carried across. They used to
 * be dropped here, and this is the promotion path: a parked event is stamped
 * when it FIRST arrives and applied only once its gap fills, which may be much
 * later. Without them the reconstructed envelope looked like an event that had
 * never been relayed. The row already held the right value; nothing read it
 * back.
 */
function envelopeFromRow(row: SyncEventRow): SyncEventEnvelope {
  return {
    eventId: row.event_id,
    originTier: row.origin_tier as SyncOriginType,
    originDeviceId: row.origin_device_id,
    locationId: row.location_id,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    payload: row.payload as SyncEventEnvelope['payload'],
    clientSeq: BigInt(row.client_seq),
    occurredAt: row.occurred_at,
    relayReceivedAt: row.relay_received_at ?? undefined,
    relayedViaNodeId: row.relayed_via_node_id ?? undefined,
    actorUserId: row.actor_user_id,
    schemaV: row.schema_v,
  };
}

@Injectable()
export class SyncIngestService {
  constructor(
    private readonly events: SyncEventsRepository,
    private readonly conflictDetector: ConflictDetectorService,
    private readonly offlineAuth: OfflineAuthService,
    private readonly reconciliation: ReconciliationService,
    private readonly projectors: SyncProjectorRegistry,
  ) {}

  /**
   * Everything that must run exactly once, the first time an event is
   * decided `applied` — whether that happens on fresh arrival or on
   * gap-fill promotion (`applyOrRejectEvent`'s two branches both call this).
   * Order matters: conflict detection first (C1-C4/C8 need the row already
   * visible to sibling lookups, AND its `isLoser` verdict feeds the
   * projector below); then domain projection (`sync-projector.types.ts` —
   * the fix for the "an offline sale never becomes a sale" gap); then the
   * two hooks that are conceptually "reconciliation" rather than "conflict"
   * (§7.4's immediate re-verification, R7's shift-close recompute).
   */
  private async runApplyHooks(client: PoolClient, event: SyncEventEnvelope): Promise<void> {
    const { isLoser } = await this.conflictDetector.detectAtApply(client, event);

    const projection = await this.projectors.project(client, event, { isConflictLoser: isLoser });
    if (!projection.ok) {
      // The FACT stays applied and acked regardless (§4.4: "log ingest and projection are separate
      // stages precisely so a projector bug cannot reject facts") — this is visibility, not a reject.
      await this.conflictDetector.recordProjectionFailure(client, event, projection.error);
    }

    if (this.offlineAuth.isOfflineDecision(event.entity, event.op)) {
      await this.offlineAuth.verifyAndRecord(client, event);
    }

    if (event.entity === 'pos_shifts' && event.op === 'closed') {
      await this.reconciliation.runR7ForClosedShift(
        event.originDeviceId,
        event.entityId,
        event.clientSeq,
        event.payload.data,
        event.actorUserId,
      );
    }
  }

  /**
   * §3.4 steps 1-3, pure (no I/O) so it is trivially property-testable
   * (T-05) against the SAME `AUTHORITY` data the wire enforcement runs on.
   *
   * Step 4 (actor RBAC at `occurred_at`) is deliberately NOT checked here.
   * SYNC-PROTOCOL is explicit that its failure "is not a sync reject: the
   * event is applied to the log but the business apply is refused" — i.e.
   * it is a DOMAIN-module concern (does this actor's role, AS OF
   * `occurred_at`, hold the permission the op implies?), and no domain
   * module exists yet to own "permission held at a historical instant" (no
   * role-assignment-history table exists in CONTRACTS.md today). Recording
   * the fact regardless of authorization is itself the OBJ-03 stance
   * (fraud-visibility). Flagged as a follow-up for whichever module first
   * needs it (most likely M02 users / the approvals engine).
   */
  checkAuthority(event: SyncEventEnvelope, registeredLocationId: UUID): AuthorityVerdict {
    if (event.originTier !== SyncOriginType.DEVICE && event.originTier !== SyncOriginType.NODE) {
      return {
        ok: false,
        code: 'malformed',
        detail: `a push cannot claim origin_tier '${event.originTier}'`,
      };
    }

    const meta = AUTHORITY[event.entity];
    if (!meta) return { ok: false, code: 'malformed', detail: `unknown entity '${event.entity}'` };

    // §3.4 step 2, checked BEFORE the op vocabulary lookup: classes X/D/T (`stock_balances`,
    // `stock_movements`, `journal_entries`, `audit_log`, `device_heartbeats`, ...) carry an EMPTY `ops`
    // list — they are never legitimately on the wire in EITHER direction (D-16/D-16a's "never synced" is
    // exactly this). Without this check first, every push against one of them would fail the "known op"
    // test below and report `malformed` instead of the `authority_violation` §3.4 step 2 and BUILD-PLAN's
    // D-16 rule both require ("reject a stock balance/movement push as an authority violation", not a typo).
    // Class M needs no special case here: its `ops` ARE non-empty (real pull ops), so it correctly falls
    // through to the `canOriginate` check below, which already returns `false` for it.
    if (meta.class === 'X' || meta.class === 'D' || meta.class === 'T') {
      return {
        ok: false,
        code: 'authority_violation',
        detail: `entity '${event.entity}' is class ${meta.class} — never legitimately on the wire in either direction`,
      };
    }

    const knownOp =
      meta.ops.includes(event.op) || (meta.pushExceptionOps?.includes(event.op) ?? false);
    if (!knownOp)
      return {
        ok: false,
        code: 'malformed',
        detail: `unknown op '${event.op}' for entity '${event.entity}'`,
      };

    if (typeof event.payload?.v !== 'number' || event.payload.v < 1) {
      return { ok: false, code: 'malformed', detail: 'payload.v must be a positive integer' };
    }
    if (!event.payload.meta?.actorUserId) {
      return { ok: false, code: 'malformed', detail: 'payload.meta.actorUserId is required' };
    }
    const payloadBytes = Buffer.byteLength(JSON.stringify(event.payload), 'utf8');
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      return {
        ok: false,
        code: 'malformed',
        detail: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes (${payloadBytes})`,
      };
    }

    // §2.3 structural validation against W1-B's payload schema registry (`@mimi/sync-protocol/schema`).
    // Only rejects when a schema IS registered and `payload.data` fails it — an unregistered (entity, op)
    // pair is a registry gap, not a caller's fault, so it passes through here rather than blocking
    // legitimate traffic on a documentation lag (the registry's own `getPayloadSchema` doc: "or a class
    // D/X/T entity that legitimately has no wire schema" — those never reach this line anyway, filtered
    // above).
    if (isRegisteredPayloadKey(event.entity, event.op)) {
      const validation = validatePayloadData(event.entity, event.op, event.payload.data);
      if (!validation.ok) {
        const issues = validation.issues.map((i) => `${i.path}: ${i.message}`).join('; ');
        return {
          ok: false,
          code: 'malformed',
          detail: `payload.data failed schema validation: ${issues}`,
        };
      }
    }

    if (!canOriginate(event.originTier, event.entity, event.op)) {
      return {
        ok: false,
        code: 'authority_violation',
        detail: `tier '${event.originTier}' is not authorized to originate ${event.entity}.${event.op}`,
      };
    }

    // Class M/X/D/T entities never reach here (canOriginate already false for them),
    // but a null-vs-set location mismatch is its own violation regardless of class.
    if (event.locationId !== registeredLocationId) {
      return {
        ok: false,
        code: 'authority_violation',
        detail: `location_id '${event.locationId}' does not match the origin's registered location`,
      };
    }

    return { ok: true };
  }

  /**
   * Applies one event that has already been determined "next in sequence"
   * (either fresh off the wire, or a previously-parked `pending_dependency`
   * row now unblocked). Handles both INSERT (fresh) and PROMOTE (already
   * stored parked) uniformly so gap-fill and first-arrival share one path —
   * necessary for T-01 (replay must not fabricate duplicate conflict rows)
   * and T-03 (gap-fill applies exactly once).
   */
  private async applyOrRejectEvent(
    client: PoolClient,
    event: SyncEventEnvelope,
    registeredLocationId: UUID,
    batchId: string | null,
  ): Promise<{ eventId: UUID; rejected?: { code: string; detail: string } }> {
    const existing = await this.events.findByEventId(client, event.eventId);

    if (existing && existing.apply_status !== 'pending_dependency') {
      // Already durably decided (applied/quarantined/superseded) — idempotent no-op,
      // and deliberately skip re-running conflict detection (would fabricate duplicates on replay).
      return existing.reject_code
        ? {
            eventId: event.eventId,
            rejected: { code: existing.reject_code, detail: existing.reject_detail ?? '' },
          }
        : { eventId: event.eventId };
    }

    const verdict = this.checkAuthority(event, registeredLocationId);

    if (existing) {
      // Promoting a previously-parked row: UPDATE, never re-INSERT.
      if (!verdict.ok) {
        await this.events.markQuarantined(client, event.eventId, verdict.code!, verdict.detail!);
        await this.conflictDetector.recordPoison(client, event, verdict.code!, verdict.detail!);
        return {
          eventId: event.eventId,
          rejected: { code: verdict.code!, detail: verdict.detail! },
        };
      }
      await this.events.markApplied(client, event.eventId);
      // D-10 — the durable stamp, for the case where a client RE-SENDS a
      // parked event in a later batch: that envelope comes off the wire, not
      // from `envelopeFromRow`, so it carries no arrival time of its own.
      stampRelayReceivedAt(event, existing.relay_received_at);
      await this.runApplyHooks(client, event);
      return { eventId: event.eventId };
    }

    // Fresh insert.
    if (!verdict.ok) {
      await this.events.insertEvent(client, {
        event,
        applyStatus: 'quarantined',
        batchId,
        rejectCode: verdict.code,
        rejectDetail: verdict.detail,
      });
      await this.conflictDetector.recordPoison(client, event, verdict.code!, verdict.detail!);
      return { eventId: event.eventId, rejected: { code: verdict.code!, detail: verdict.detail! } };
    }

    const inserted = await this.events.insertEvent(client, {
      event,
      applyStatus: 'applied',
      batchId,
      appliedAt: new Date().toISOString(),
    });
    // D-10 — `insertEvent` computes the effective `relay_received_at` (§2.1)
    // and returns the stored row. Read it back rather than letting the hooks
    // re-derive it: the row is the record, and a node-relayed event's stamp is
    // the NODE's arrival time, which can be hours before the cloud sees it.
    stampRelayReceivedAt(event, inserted.relay_received_at);
    await this.runApplyHooks(client, event);
    return { eventId: event.eventId };
  }

  /**
   * Re-scans currently-parked rows for one origin and promotes as many as
   * are now contiguous, using ONLY what is already durably stored (does not
   * require the closing batch to re-include every previously-parked
   * event_id — robust to partial resends, §4.4/T-03).
   */
  private async sweepPendingDependency(
    client: PoolClient,
    originDeviceId: UUID,
    registeredLocationId: UUID,
  ): Promise<bigint> {
    let highWater = await this.events.getHighWater(client, originDeviceId);
    for (;;) {
      const parked = await this.events.loadPendingDependency(client, originDeviceId);
      const next = parked.find((r) => BigInt(r.client_seq) === highWater + 1n);
      if (!next) break;
      await this.applyOrRejectEvent(
        client,
        envelopeFromRow(next),
        registeredLocationId,
        next.batch_id,
      );
      highWater += 1n;
    }
    return highWater;
  }

  /**
   * Ingests one push batch. `batch.events` may span multiple origins (node
   * relay, §4.3) — each origin's contiguous run commits independently.
   *
   * `resolveLocation(originDeviceId)` looks up the ORIGIN's registered
   * location (never trusts the pusher's claim, §3.4 step 3) — a plain
   * function so callers (HTTP controller today; the node-gateway once M22
   * exists) can supply device-vs-node resolution without this service
   * needing to know which.
   */
  async ingestBatch(
    batch: SyncPushBatch,
    resolveLocation: (originDeviceId: UUID) => Promise<UUID | undefined>,
  ): Promise<SyncPushAck> {
    const groups = groupByOrigin(batch.events);
    const rejected: SyncPushAck['rejected'] = [];
    const acceptedThrough: Record<UUID, number> = {};
    const resendFrom: Record<UUID, number> = {};

    for (const [originDeviceId, originEvents] of groups) {
      const registeredLocationId = await resolveLocation(originDeviceId);
      if (!registeredLocationId) {
        for (const e of originEvents) {
          rejected.push({
            eventId: e.eventId,
            code: 'authority_violation',
            detail: 'unknown or unregistered origin device',
          });
        }
        continue;
      }

      const sorted = sortByClientSeq(originEvents);

      // `sync_batches.id` is this row's own PK and `sync_events.batch_id` FKs to it (CONTRACTS.md block
      // 120-129) — one row per ORIGIN, not per wire batch_id (a node-relayed batch can span several
      // origins, §4.3). The common single-origin case reuses the wire `batch.batchId` directly (still
      // traceable end-to-end); a multi-origin batch mints a fresh id per origin group instead, since
      // reusing one PK for several rows would violate uniqueness.
      const batchRowId = groups.size === 1 ? batch.batchId : randomUUID();

      const { highWater, gapAt } = await this.events.withTransaction(async (client) => {
        await this.events.insertBatch(client, {
          id: batchRowId,
          originTier: sorted[0]!.originTier,
          originDeviceId,
          locationId: registeredLocationId,
          eventCount: sorted.length,
          firstSeq: sorted[0]!.clientSeq,
          lastSeq: sorted[sorted.length - 1]!.clientSeq,
        });

        if (await this.events.isOriginFrozen(client, originDeviceId)) {
          for (const e of sorted) {
            rejected.push({
              eventId: e.eventId,
              code: 'seq_conflict',
              detail: 'origin frozen pending support review (§4.4)',
            });
          }
          const hw = await this.events.getHighWater(client, originDeviceId);
          await this.events.completeBatch(client, batchRowId, 'failed', {
            reason: 'origin frozen',
          });
          return { highWater: hw, gapAt: undefined as bigint | undefined };
        }

        const seqIndex = await this.events.loadSeqIndex(client, originDeviceId);
        const currentHighWater = await this.events.getHighWater(client, originDeviceId);
        const result = processOriginBatch(sorted, currentHighWater, (seq) => seqIndex.get(seq));

        for (const { incoming, conflictsWithSeq } of result.seqConflicts) {
          // NOTE: unlike every other permanent reject, a seq_conflict event is NEVER inserted into
          // sync_events — `UNIQUE (origin_device_id, client_seq)` (CONTRACTS.md block 120-129) physically
          // forbids two rows sharing that key, which is exactly what makes this "outbox-corruption
          // detector" a DB-enforced invariant rather than an application convention (§2.2 rule 4). The
          // colliding event's content survives only inside `sync_conflicts.detail` — there is no row for
          // it to occupy, and none should exist.
          const existingEventId = seqIndex.get(conflictsWithSeq);
          await this.conflictDetector.recordSeqConflict(
            client,
            incoming,
            existingEventId,
            registeredLocationId,
          );
          rejected.push({
            eventId: incoming.eventId,
            code: 'seq_conflict',
            detail: 'client_seq collision with a different event_id — event not stored',
          });
        }

        for (const event of result.applied) {
          const outcome = await this.applyOrRejectEvent(
            client,
            event,
            registeredLocationId,
            batchRowId,
          );
          if (outcome.rejected)
            rejected.push({
              eventId: outcome.eventId,
              code: outcome.rejected.code,
              detail: outcome.rejected.detail,
            });
        }

        for (const event of result.parked) {
          await this.events.insertEvent(client, {
            event,
            applyStatus: 'pending_dependency',
            batchId: batchRowId,
          });
        }

        const finalHighWater =
          result.gapAt === undefined
            ? await this.sweepPendingDependency(client, originDeviceId, registeredLocationId)
            : result.newHighWater;

        await this.events.completeBatch(
          client,
          batchRowId,
          result.gapAt === undefined ? 'applied' : 'partial',
          {
            acceptedThrough: Number(finalHighWater),
            resendFrom: result.gapAt === undefined ? undefined : Number(result.gapAt),
          },
        );

        return { highWater: finalHighWater, gapAt: result.gapAt };
      });

      acceptedThrough[originDeviceId] = Number(highWater);
      if (gapAt !== undefined) resendFrom[originDeviceId] = Number(gapAt);
    }

    return {
      batchId: batch.batchId,
      acceptedThrough,
      confirmedThrough: acceptedThrough, // cloud is the terminal tier — the two levels coincide here (§4.3)
      rejected,
      resendFrom: Object.keys(resendFrom).length > 0 ? resendFrom : undefined,
    };
  }
}
