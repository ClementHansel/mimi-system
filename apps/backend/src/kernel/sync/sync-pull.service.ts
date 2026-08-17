/**
 * The downstream-facing half of the wire (§4.2 handshake, §4.5 pull, §4.6
 * bootstrap). The scope filter is ALWAYS computed here from the registry —
 * never trusted from the caller's claim (§4.2: "the upstream verifies,
 * never trusts").
 */
import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import type { UUID } from '@mimi/shared';
import { wireEligibleEntities, type SyncEventEnvelope, type SyncHelloAck, type SyncPullResult, type SyncScope } from '@mimi/sync-protocol';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { SyncEventsRepository } from './sync-events.repository';
import type { SyncEventRow } from './db-rows';
import { MAX_PULL_LIMIT } from './constants';
import { withSystemContext } from './system-rls-context';

function rowToEnvelope(row: SyncEventRow): SyncEventEnvelope {
  return {
    eventId: row.event_id,
    originTier: row.origin_tier as SyncEventEnvelope['originTier'],
    originDeviceId: row.origin_device_id,
    locationId: row.location_id,
    entity: row.entity,
    entityId: row.entity_id,
    op: row.op,
    payload: row.payload as SyncEventEnvelope['payload'],
    clientSeq: BigInt(row.client_seq),
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    relayReceivedAt: row.relay_received_at,
    relayedViaNodeId: row.relayed_via_node_id,
    actorUserId: row.actor_user_id,
    schemaV: row.schema_v,
  };
}

export interface DeviceScopeInputs {
  subscriberId: UUID;
  subscriberTier: 'device' | 'node';
  /** Registry-resolved location(s) — for a device, exactly its paired location; for a node, its outlet. */
  locationIds: UUID[];
  projectionRole: SyncScope['projectionRole'];
}

@Injectable()
export class SyncPullService {
  private readonly wireEntities = wireEligibleEntities();

  constructor(
    private readonly events: SyncEventsRepository,
    @Inject(DATABASE_POOL) private readonly pool: Pool,
  ) {}

  buildScope(inputs: DeviceScopeInputs): SyncScope {
    return {
      globalMaster: true,
      locationIds: inputs.locationIds,
      projectionRole: inputs.projectionRole,
      excludeOrigin: inputs.subscriberId,
    };
  }

  /** `_requestedOutboxDepth` is telemetry-only (mirrors the socket heartbeat's `outbox_depth`) — not yet consumed by this handshake; kept in the signature so callers match the wire shape (§4.2) even though nothing here reads it today. */
  async hello(inputs: DeviceScopeInputs, requestedCursor: number, _requestedOutboxDepth: number): Promise<SyncHelloAck> {
    return this.events.withTransaction(async (client) => {
      const stored = await this.events.getCursor(client, inputs.subscriberId);
      // Trust whichever is larger — the client's own claim can only ever ask to "not go backwards"; the
      // scope/location side of the handshake is what must never be client-trusted (§4.2), not this number.
      const resumeCursor = BigInt(requestedCursor) > stored ? BigInt(requestedCursor) : stored;
      await this.events.upsertCursor(client, inputs.subscriberTier, inputs.subscriberId, resumeCursor);

      // confirmed_through (§4.3): this subscriber's OWN origin high-water, so it can prune its outbox
      // immediately on reconnect even before pushing anything new. Only meaningful when the subscriber
      // IS an origin (a device pushing its own facts) — a node relaying many devices' origins is M22's
      // extension of this, not yet built.
      const ownHighWater = await this.events.getHighWater(client, inputs.subscriberId);

      return {
        ok: true,
        protocolV: 1,
        serverTime: new Date().toISOString(),
        resumeCursor: Number(resumeCursor),
        confirmedThrough: { [inputs.subscriberId]: Number(ownHighWater) },
        scope: this.buildScope(inputs),
      };
    });
  }

  /**
   * §4.5 catch-up pull. §3.2's sensitive-field re-projection (`users` ->
   * strip password hash, `employees` -> strip salary/bank data, ...) is
   * deliberately NOT applied here: this engine treats a `payload.data` as
   * whatever the EMITTING side constructed, and §3.2 is a constraint on
   * that construction ("the canonical row is never shipped whole"), not a
   * transform this generic pull path can safely apply without per-entity
   * knowledge of which fields are sensitive. Binding on whichever module
   * emits `users`/`employees` events (M02/M14, not built yet): construct
   * the payload already stripped — never rely on this layer to redact it.
   */
  async pull(scope: SyncScope, cursor: number, limit: number): Promise<SyncPullResult> {
    const boundedLimit = Math.max(1, Math.min(limit, MAX_PULL_LIMIT));

    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<SyncEventRow>(
        `SELECT * FROM sync_events
          WHERE server_seq > $1
            AND apply_status IN ('applied', 'superseded')
            AND origin_device_id <> $2
            AND entity = ANY($3::text[])
            AND (location_id IS NULL OR location_id = ANY($4::uuid[]))
          ORDER BY server_seq ASC
          LIMIT $5`,
        [cursor.toString(), scope.excludeOrigin, this.wireEntities, scope.locationIds, boundedLimit + 1],
      );

      const hasMore = res.rows.length > boundedLimit;
      const page = res.rows.slice(0, boundedLimit);
      const nextCursor = page.length > 0 ? Number(page[page.length - 1]!.server_seq) : cursor;

      return { events: page.map(rowToEnvelope), nextCursor, hasMore };
    });
  }

  /** Persists the downstream's cursor advance after it durably applied a page (§4.5: "atomically with its cursor advance" — that atomicity is the CALLER's transaction; this just records the position). */
  async advanceCursor(subscriberType: 'device' | 'node', subscriberId: UUID, cursor: number): Promise<void> {
    await withSystemContext(this.pool, (client) => this.events.upsertCursor(client, subscriberType, subscriberId, BigInt(cursor)));
  }

  /**
   * §4.6 bootstrap: this V1 implementation returns the FULL applied window
   * in `server_seq` order as one "snapshot" (no separate projected-state
   * pages) — correct (idempotent, resumable by re-pulling from
   * `starting_cursor`) but not yet the leaner "master-data projection +
   * open documents + 14 days" shape SYNC-PROTOCOL describes, since that
   * requires each domain module's notion of "currently open documents"
   * (Wave 3+, not built). Flagged as a follow-up; the wire shape
   * (`events`, `next_cursor`, `has_more`, `starting_cursor`) is final and
   * won't change when the leaner snapshot lands — only the row selection
   * inside `pull()` above would.
   */
  async bootstrapStartingCursor(): Promise<number> {
    return withSystemContext(this.pool, async (client) => Number(await this.events.getMaxServerSeq(client)));
  }
}
