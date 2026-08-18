/**
 * Apply-time conflict detection — SYNC-PROTOCOL §5.1/§5.2, the enumerated
 * conflicts C1-C4, C8, C9. (C5/C6/C7 live elsewhere: C5 is
 * `StockLedgerService`'s `fact`-mode posting — W2-A, not built yet, wired
 * via `recordExternalConflict` below so it can call in once it exists; C6 is
 * an R5 sweep (`reconciliation.service.ts`); C7 is
 * `offline-auth.service.ts`'s re-verification outcome.)
 *
 * Detection runs INSIDE the same transaction that just inserted/promoted
 * the event (SYNC-PROTOCOL §5.1 rule 4: "runs at cloud apply time") — sees
 * its own uncommitted insert via the same client, so no extra round trip.
 * Idempotent by construction: `SyncConflictsRepository.recordConflictIfAbsent`
 * dedupes on (kind, entity, entityId, loserEventId), so replaying the same
 * batch any number of times (T-01) opens the SAME conflict rows, never more.
 */
import { Injectable } from '@nestjs/common';
import type { UUID } from '@mimi/shared';
import { businessDateOf } from '@mimi/shared';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { DbClient } from './sync-events.repository';
import { SyncEventsRepository } from './sync-events.repository';
import { SyncConflictsRepository } from './sync-conflicts.repository';
import { readAreaCounted, readOnlineOrder } from './payload-shapes';
import type { SyncEventRow } from './db-rows';

interface DecisionOpSet {
  offlineOp: string;
  onlineApprove: string;
  onlineReject: string;
}

const DECISION_OPS: Record<string, DecisionOpSet> = {
  void_refunds: {
    offlineOp: 'approved_offline',
    onlineApprove: 'approved',
    onlineReject: 'rejected',
  },
  replenishment_requests: {
    offlineOp: 'supervisor_approved_offline',
    onlineApprove: 'supervisor_approved',
    onlineReject: 'supervisor_rejected',
  },
  waste_records: {
    offlineOp: 'approved_offline',
    onlineApprove: 'approved',
    onlineReject: 'rejected',
  },
};

@Injectable()
export class ConflictDetectorService {
  constructor(
    private readonly events: SyncEventsRepository,
    private readonly conflicts: SyncConflictsRepository,
  ) {}

  /** C9: malformed / authority_violation — every permanent reject that DID get a sync_events row lands here (§4.4: "Rejected ≠ lost"). */
  async recordPoison(
    client: DbClient,
    event: Pick<SyncEventEnvelope, 'eventId' | 'entity' | 'entityId' | 'locationId' | 'op'>,
    code: string,
    detail: string,
  ): Promise<void> {
    await this.conflicts.recordConflictIfAbsent(client, {
      kind: 'poison',
      queue: 'conflict',
      entity: event.entity,
      entityId: event.entityId ?? null,
      locationId: event.locationId,
      loserEventId: event.eventId,
      detail: { code, detail, op: event.op },
    });
  }

  /**
   * A registered `SyncProjector` threw. The FACT stays `applied` (never rolled back — see
   * `SyncProjectorRegistry.project`'s `SAVEPOINT` isolation and `sync-ingest.service.ts`'s
   * `runApplyHooks`); this is purely the F12/exception-queue visibility half, same bucket as the
   * reconciliation jobs' "no dedicated kind exists" cases (`reconciliation.service.ts`). A future
   * reprocessing sweep can retry by calling `SyncProjectorRegistry.project` again for this `event_id` —
   * safe because `SyncProjector.project` is required to be idempotent (see that interface's doc).
   */
  async recordProjectionFailure(
    client: DbClient,
    event: SyncEventEnvelope,
    error: string,
  ): Promise<void> {
    await this.conflicts.recordConflictIfAbsent(client, {
      kind: 'poison',
      queue: 'exception',
      entity: event.entity,
      entityId: event.entityId,
      locationId: event.locationId,
      loserEventId: event.eventId,
      detail: { reason: 'projection_failed', error, op: event.op },
      assigneeRole: 'owner',
    });
  }

  /**
   * C9 / §2.2 rule 4's `seq_conflict` — the ONE permanent reject that never gets a `sync_events` row
   * (`UNIQUE (origin_device_id, client_seq)` physically forbids it, see `sync-ingest.service.ts`'s
   * comment). The colliding event's identity survives only in `detail`; `originDeviceId` rides there too
   * (rather than as a real FK'd row) so `SyncEventsRepository.isOriginFrozen` can detect "this origin has
   * tripped seq_conflict" without a sync_events row to query.
   */
  async recordSeqConflict(
    client: DbClient,
    incoming: SyncEventEnvelope,
    existingEventId: UUID | undefined,
    locationId: UUID | null,
  ): Promise<void> {
    await this.conflicts.recordConflictIfAbsent(client, {
      kind: 'poison',
      queue: 'conflict',
      entity: incoming.entity,
      entityId: incoming.entityId,
      locationId,
      winnerEventId: existingEventId ?? null,
      loserEventId: null,
      detail: {
        code: 'seq_conflict',
        originDeviceId: incoming.originDeviceId,
        clientSeq: incoming.clientSeq.toString(),
        incomingEventId: incoming.eventId,
        incomingEntity: incoming.entity,
        incomingOp: incoming.op,
        note: 'client_seq collided with a different event_id at this origin — possible cloned/corrupted local store; incoming event was never stored',
      },
    });
  }

  /**
   * Returns `isLoser: true` when THIS event was determined, in this same call, to be the losing side of
   * a conflict with a clear winner (C2 duplicate receipt, C3 decision race, C8 duplicate platform order)
   * — i.e. a domain projector (`sync-projector.types.ts`) MUST NOT post this event's business effect
   * (stock movement, GL posting, a second "verified" state) a second time, even though the FACT itself
   * is still durably logged and still gets a domain row where one legitimately belongs (a disputed opname
   * line, an HR-reviewed attendance overlap, a flagged duplicate order — none of THOSE suppress
   * projection, they only flag it for review, so C1/C4 never set `isLoser`).
   */
  async detectAtApply(client: DbClient, event: SyncEventEnvelope): Promise<{ isLoser: boolean }> {
    let isLoser = false;
    switch (event.entity) {
      case 'stock_opname':
        if (event.op === 'area_counted') await this.detectDoubleCount(client, event);
        break;
      case 'sj_drops':
        if (event.op === 'received') isLoser = await this.detectDuplicateReceipt(client, event);
        break;
      case 'attendance':
        if (event.op === 'checked_in') await this.detectAttendanceOverlap(client, event);
        break;
      case 'online_orders':
        if (event.op === 'recorded')
          isLoser = await this.detectDuplicatePlatformOrder(client, event);
        break;
      default:
        break;
    }
    if (DECISION_OPS[event.entity]) {
      isLoser =
        (await this.detectDecisionRace(client, event, DECISION_OPS[event.entity]!)) || isLoser;
    }
    return { isLoser };
  }

  // ── C1: double_count ────────────────────────────────────────────────────
  private async detectDoubleCount(client: DbClient, event: SyncEventEnvelope): Promise<void> {
    const mine = readAreaCounted(event.payload.data);
    if (!mine) return; // payload shape not yet what this expects (see payload-shapes.ts note) — skip, never crash ingest

    const siblings = await this.events.findByEntityId(
      client,
      'stock_opname',
      event.entityId,
      event.eventId,
    );
    for (const sib of siblings) {
      if (sib.op !== 'area_counted') continue;
      const theirs = readAreaCounted(sib.payload);
      if (!theirs || theirs.storageAreaId !== mine.storageAreaId) continue;

      // `findByEntityId` returns only already-durably-stored siblings, ascending by `server_seq`; the
      // event being applied right now is necessarily younger (BIGSERIAL is monotonic), so the sibling
      // is always "first-at-cloud" for this pair.
      const sharedItemIds = mine.lines
        .map((l) => l.itemId)
        .filter((id) => theirs.lines.some((t) => t.itemId === id));
      for (const itemId of sharedItemIds) {
        await this.conflicts.recordConflictIfAbsent(client, {
          kind: 'double_count',
          queue: 'conflict',
          entity: 'stock_opname',
          entityId: event.entityId,
          locationId: event.locationId,
          winnerEventId: sib.event_id,
          loserEventId: event.eventId,
          detail: { storageAreaId: mine.storageAreaId, itemId, disputed: true },
          assigneeRole: 'supervisor',
        });
      }
    }
  }

  // ── C2: duplicate_receipt ───────────────────────────────────────────────
  /** Returns `true` when THIS event is the second (losing) receipt — the caller must not double-post its stock effect. */
  private async detectDuplicateReceipt(
    client: DbClient,
    event: SyncEventEnvelope,
  ): Promise<boolean> {
    const siblings = (
      await this.events.findByEntityId(client, 'sj_drops', event.entityId, event.eventId)
    ).filter((s) => s.op === 'received');
    if (siblings.length === 0) return false;

    const winner = siblings[0]!; // lowest server_seq = first-at-cloud (findByEntityId orders ascending)
    await this.conflicts.recordConflictIfAbsent(client, {
      kind: 'duplicate_receipt',
      queue: 'conflict',
      entity: 'sj_drops',
      entityId: event.entityId,
      locationId: event.locationId,
      winnerEventId: winner.event_id,
      loserEventId: event.eventId,
      detail: {
        note: 'second sj_drops.received for the same drop; stock effect posts once (winner only)',
      },
      assigneeRole: 'kepala_gudang',
    });
    return true;
  }

  // ── C3: decision_race ───────────────────────────────────────────────────
  /** Returns `true` when THIS event lost to ANY sibling decision (same-outcome merge or divergent race) — a projector must not apply its decision a second time. */
  private async detectDecisionRace(
    client: DbClient,
    event: SyncEventEnvelope,
    ops: DecisionOpSet,
  ): Promise<boolean> {
    const isDecision =
      event.op === ops.offlineOp || event.op === ops.onlineApprove || event.op === ops.onlineReject;
    if (!isDecision) return false;

    const siblings = (
      await this.events.findByEntityId(client, event.entity, event.entityId, event.eventId)
    ).filter(
      (s) => s.op === ops.offlineOp || s.op === ops.onlineApprove || s.op === ops.onlineReject,
    );
    if (siblings.length === 0) return false;

    const isOnline = (op: string) => op === ops.onlineApprove || op === ops.onlineReject;
    const isApprove = (op: string) => op === ops.onlineApprove || op === ops.offlineOp;
    let mineIsLoser = false;

    for (const sib of siblings) {
      const mineOnline = isOnline(event.op);
      const theirsOnline = isOnline(sib.op);
      const sameOutcome = isApprove(event.op) === isApprove(sib.op);

      // §5.3 precedence: any online beats any offline-provisional, regardless of order.
      let winnerEventId: UUID;
      let loserEventId: UUID;
      if (mineOnline && !theirsOnline) {
        winnerEventId = event.eventId;
        loserEventId = sib.event_id;
      } else if (!mineOnline && theirsOnline) {
        winnerEventId = sib.event_id;
        loserEventId = event.eventId;
      } else {
        // same mode: first-at-cloud (the sibling, already stored) wins.
        winnerEventId = sib.event_id;
        loserEventId = event.eventId;
      }
      if (loserEventId === event.eventId) mineIsLoser = true;

      if (sameOutcome) {
        // Same-outcome duplicates merge silently — no queue entry, loser just superseded.
        await this.events.markSuperseded(client, loserEventId);
        continue;
      }

      const loserWasOfflineApproval =
        (loserEventId === sib.event_id ? sib.op : event.op) === ops.offlineOp;
      await this.conflicts.recordConflictIfAbsent(client, {
        kind: 'decision_race',
        queue: loserWasOfflineApproval ? 'finance' : 'conflict',
        entity: event.entity,
        entityId: event.entityId,
        locationId: event.locationId,
        winnerEventId,
        loserEventId,
        physicalEffectSuspected: loserWasOfflineApproval,
        detail: {
          winnerOp: winnerEventId === event.eventId ? event.op : sib.op,
          loserOp: loserEventId === event.eventId ? event.op : sib.op,
        },
        assigneeRole: loserWasOfflineApproval ? 'finance' : 'supervisor',
      });
      await this.events.markSuperseded(client, loserEventId);
    }
    return mineIsLoser;
  }

  // ── C4: attendance_overlap ──────────────────────────────────────────────
  // NOTE: unlike C1/C2 (same `entity_id` = same document), a duplicate/overlapping
  // check-in is, BY DEFINITION, a DIFFERENT attendance record (a fresh `entity_id`
  // minted by the second check-in) — so this looks across all of this actor's
  // attendance events for the same business day, not siblings of one entity_id.
  private async detectAttendanceOverlap(client: DbClient, event: SyncEventEnvelope): Promise<void> {
    const employeeId = event.actorUserId; // best-effort — see payload-shapes.ts note on assumed fields
    const day = businessDateOf(event.occurredAt);

    const siblings = (
      await this.events.findRecentByActor(client, 'attendance', employeeId, event.eventId)
    ).filter((s) => businessDateOf(s.occurred_at) === day);

    const priorCheckIns = siblings.filter((s) => s.op === 'checked_in').length;
    const priorCheckOuts = siblings.filter((s) => s.op === 'checked_out').length;
    if (priorCheckIns > priorCheckOuts) {
      // An open check-in already exists for this employee/day — this new checked_in overlaps it.
      const openEvent = siblings.filter((s) => s.op === 'checked_in').at(-1);
      await this.conflicts.recordConflictIfAbsent(client, {
        kind: 'attendance_overlap',
        queue: 'hr',
        entity: 'attendance',
        entityId: event.entityId,
        locationId: event.locationId,
        winnerEventId: openEvent?.event_id ?? null,
        loserEventId: event.eventId,
        detail: { employeeId, day, note: 'second checked_in without an intervening checked_out' },
        assigneeRole: 'hr_admin',
      });
    }
  }

  // ── C8: duplicate_platform_order ────────────────────────────────────────
  /**
   * Returns `true` when THIS event is the duplicate. NOTE per SYNC-PROTOCOL §5.2 C8: "Both kept; second
   * flagged; revenue reports use first" — unlike C2/C3, a projector for `online_orders` SHOULD still
   * create its own domain row for a `isLoser` duplicate (the order really was recorded twice, both are
   * real facts) but must exclude it from revenue aggregation; this flag exists so the projector can set
   * whatever "excluded from reporting" marker its own table uses, not so it skips writing the row.
   */
  private async detectDuplicatePlatformOrder(
    client: DbClient,
    event: SyncEventEnvelope,
  ): Promise<boolean> {
    const mine = readOnlineOrder(event.payload.data);
    if (!mine) return false;

    const res = await client.query<SyncEventRow>(
      `SELECT * FROM sync_events
        WHERE entity = 'online_orders' AND op = 'recorded' AND entity_id <> $1
          AND payload->'data'->>'platform' = $2
          AND payload->'data'->>'orderRef' = $3
        ORDER BY server_seq ASC`,
      [event.entityId, mine.platform, mine.orderRef],
    );
    if (res.rows.length === 0) return false;
    const winner = res.rows[0]!;
    await this.conflicts.recordConflictIfAbsent(client, {
      kind: 'duplicate_platform_order',
      queue: 'exception',
      entity: 'online_orders',
      entityId: event.entityId,
      locationId: event.locationId,
      winnerEventId: winner.event_id,
      loserEventId: event.eventId,
      detail: { platform: mine.platform, orderRef: mine.orderRef },
      assigneeRole: 'manager',
    });
    return true;
  }
}
