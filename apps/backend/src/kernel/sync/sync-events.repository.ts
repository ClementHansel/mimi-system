/**
 * Raw `pg` access to `sync_events` / `sync_batches` / `sync_cursors`
 * (CONTRACTS.md §1.13 block 120-129). Parameterized queries only — no ORM,
 * no string-interpolated values (BUILD-PLAN §6, CONSTRAINTS).
 *
 * This is the ONLY place `sync_events` rows are written — mirrors the
 * "single writer" discipline the rest of the kernel uses for
 * `stock_balances` (D-07)/`audit_log` (D-09), even though sync_events isn't
 * named by those specific rules: append-only-by-construction (CONSTRAINTS)
 * means every write path funnels through here so idempotency/ordering
 * invariants can't be bypassed by a shortcut insert elsewhere.
 */
import { Injectable, Inject } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import type { UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ApplyStatus, SyncBatchRow, SyncEventRow } from './db-rows';
import { assertSystemContext } from './system-rls-context';

export type DbClient = Pool | PoolClient;

export interface InsertEventParams {
  event: SyncEventEnvelope;
  applyStatus: ApplyStatus;
  batchId: string | null;
  rejectCode?: string | null;
  rejectDetail?: string | null;
  relayReceivedAt?: string | null;
  relayedViaNodeId?: UUID | null;
  appliedAt?: string | null;
}

@Injectable()
export class SyncEventsRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * The transaction every ingest/emit path shares. Asserts the system/
   * central-role RLS context (D-21/D-22, `system-rls-context.ts`) right
   * after `BEGIN`: `sync_events`/`sync_conflicts` themselves have no RLS
   * (CONTRACTS.md §1.14), but downstream apply-time hooks that run on this
   * SAME client inside `fn` — `OfflineAuthService`'s `users`/`user_locations`
   * lookups (§7.4 check 6) chief among them — DO hit `LOC`/`ROLE`-scoped
   * tables, and this is a cross-tenant system operation, not one user's
   * request.
   */
  async withTransaction<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await assertSystemContext(client);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * The gapless high-water mark for one origin: the highest `client_seq`
   * among rows that are durably DECIDED (applied, quarantined, or
   * superseded) — `pending_dependency` rows (parked past a gap, §4.4) never
   * advance it. Correct only because ingest never skips a seq: every seq
   * below a gap is always either decided or parked, never absent.
   */
  async getHighWater(client: DbClient, originDeviceId: UUID): Promise<bigint> {
    const res = await client.query<{ high_water: string }>(
      `SELECT COALESCE(MAX(client_seq), 0)::text AS high_water
         FROM sync_events
        WHERE origin_device_id = $1
          AND apply_status <> 'pending_dependency'`,
      [originDeviceId],
    );
    return BigInt(res.rows[0]?.high_water ?? '0');
  }

  /** `event_id` already stored at this exact `client_seq` for this origin, if any (§2.2 rule 4 lookup). */
  async findEventIdAtSeq(
    client: DbClient,
    originDeviceId: UUID,
    clientSeq: bigint,
  ): Promise<UUID | undefined> {
    const res = await client.query<{ event_id: UUID }>(
      `SELECT event_id FROM sync_events WHERE origin_device_id = $1 AND client_seq = $2`,
      [originDeviceId, clientSeq.toString()],
    );
    return res.rows[0]?.event_id;
  }

  /** Bulk variant for `processOriginBatch`'s `knownEventIdAtSeq` lookup — avoids one query per event. */
  async loadSeqIndex(client: DbClient, originDeviceId: UUID): Promise<Map<bigint, UUID>> {
    const res = await client.query<{ client_seq: string; event_id: UUID }>(
      `SELECT client_seq, event_id FROM sync_events WHERE origin_device_id = $1`,
      [originDeviceId],
    );
    const map = new Map<bigint, UUID>();
    for (const row of res.rows) map.set(BigInt(row.client_seq), row.event_id);
    return map;
  }

  /**
   * `true` if this origin has ever tripped a permanent `seq_conflict` — SYNC-PROTOCOL §4.4: "freezes the
   * origin pending support". Checked against `sync_conflicts` (kind `poison`, `detail.originDeviceId`),
   * NOT `sync_events`: a `seq_conflict` event is never itself stored as a `sync_events` row (`UNIQUE
   * (origin_device_id, client_seq)` physically forbids two rows sharing that key — see
   * `conflict-detector.service.ts`'s `recordSeqConflict`), so this is the only durable trace of it.
   */
  async isOriginFrozen(client: DbClient, originDeviceId: UUID): Promise<boolean> {
    const res = await client.query(
      `SELECT 1 FROM sync_conflicts
        WHERE kind = 'poison' AND detail->>'code' = 'seq_conflict' AND detail->>'originDeviceId' = $1
        LIMIT 1`,
      [originDeviceId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** All currently-parked events for an origin, ascending by `client_seq` — the gap-fill candidate pool. */
  async loadPendingDependency(client: DbClient, originDeviceId: UUID): Promise<SyncEventRow[]> {
    const res = await client.query<SyncEventRow>(
      `SELECT * FROM sync_events
        WHERE origin_device_id = $1 AND apply_status = 'pending_dependency'
        ORDER BY client_seq ASC`,
      [originDeviceId],
    );
    return res.rows;
  }

  async findByEventId(client: DbClient, eventId: UUID): Promise<SyncEventRow | undefined> {
    const res = await client.query<SyncEventRow>(`SELECT * FROM sync_events WHERE event_id = $1`, [
      eventId,
    ]);
    return res.rows[0];
  }

  /** All of one actor's events for `entity`, most recent 3 days (business-day math is done by the caller in JS — cheap here, avoids WITA arithmetic in SQL). Used by C4 (attendance overlap), which is keyed by actor+day, not by a shared `entity_id`. */
  async findRecentByActor(
    client: DbClient,
    entity: string,
    actorUserId: UUID,
    excludeEventId?: UUID,
  ): Promise<SyncEventRow[]> {
    const res = await client.query<SyncEventRow>(
      `SELECT * FROM sync_events
        WHERE entity = $1 AND actor_user_id = $2 AND ($3::uuid IS NULL OR event_id <> $3)
          AND occurred_at > NOW() - INTERVAL '3 days'
        ORDER BY server_seq ASC`,
      [entity, actorUserId, excludeEventId ?? null],
    );
    return res.rows;
  }

  async findByEntityId(
    client: DbClient,
    entity: string,
    entityId: UUID,
    excludeEventId?: UUID,
  ): Promise<SyncEventRow[]> {
    const res = await client.query<SyncEventRow>(
      `SELECT * FROM sync_events
        WHERE entity = $1 AND entity_id = $2 AND ($3::uuid IS NULL OR event_id <> $3)
        ORDER BY server_seq ASC`,
      [entity, entityId, excludeEventId ?? null],
    );
    return res.rows;
  }

  async insertEvent(client: DbClient, params: InsertEventParams): Promise<SyncEventRow> {
    const {
      event,
      applyStatus,
      batchId,
      rejectCode,
      rejectDetail,
      relayReceivedAt,
      relayedViaNodeId,
      appliedAt,
    } = params;
    const effectiveRelayedViaNodeId = relayedViaNodeId ?? event.relayedViaNodeId ?? null;
    // §2.1: relay_received_at is stamped by the FIRST non-origin tier to durably store the event; when
    // no node relayed (device-direct or cloud-born), it "equals cloud received_at" — i.e. right now.
    const effectiveRelayReceivedAt =
      relayReceivedAt ??
      event.relayReceivedAt ??
      (effectiveRelayedViaNodeId ? null : new Date().toISOString());
    const res = await client.query<SyncEventRow>(
      `INSERT INTO sync_events (
         event_id, origin_tier, origin_device_id, location_id, entity, entity_id, op, payload,
         client_seq, occurred_at, relay_received_at, relayed_via_node_id, actor_user_id, schema_v,
         batch_id, apply_status, applied_at, reject_code, reject_detail
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING *`,
      [
        event.eventId,
        event.originTier,
        event.originDeviceId,
        event.locationId,
        event.entity,
        event.entityId,
        event.op,
        JSON.stringify(event.payload),
        event.clientSeq.toString(),
        event.occurredAt,
        effectiveRelayReceivedAt,
        effectiveRelayedViaNodeId,
        event.actorUserId,
        event.schemaV,
        batchId,
        applyStatus,
        appliedAt ?? null,
        rejectCode ?? null,
        rejectDetail ?? null,
      ],
    );
    if (res.rows[0]) return res.rows[0];
    // ON CONFLICT DO NOTHING fired: idempotent re-delivery of an event_id already stored byte-identically.
    const existing = await this.findByEventId(client, event.eventId);
    if (!existing) throw new Error(`insertEvent: conflict on ${event.eventId} but row not found`);
    return existing;
  }

  /** Promotes a parked `pending_dependency` row to `applied` once its gap is filled. */
  async markApplied(client: DbClient, eventId: UUID): Promise<void> {
    await client.query(
      `UPDATE sync_events SET apply_status = 'applied', applied_at = NOW() WHERE event_id = $1`,
      [eventId],
    );
  }

  async markQuarantined(
    client: DbClient,
    eventId: UUID,
    rejectCode: string,
    rejectDetail: string,
  ): Promise<void> {
    await client.query(
      `UPDATE sync_events SET apply_status = 'quarantined', reject_code = $2, reject_detail = $3 WHERE event_id = $1`,
      [eventId, rejectCode, rejectDetail],
    );
  }

  async markSuperseded(client: DbClient, eventId: UUID): Promise<void> {
    await client.query(`UPDATE sync_events SET apply_status = 'superseded' WHERE event_id = $1`, [
      eventId,
    ]);
  }

  // ── sync_batches (transport observability, §4.3) ──────────────────────────

  async insertBatch(
    client: DbClient,
    params: {
      id: UUID;
      originTier: string;
      originDeviceId: UUID;
      locationId: UUID | null;
      eventCount: number;
      firstSeq: bigint;
      lastSeq: bigint;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO sync_batches (id, origin_tier, origin_device_id, location_id, event_count, first_seq, last_seq, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'received')
       ON CONFLICT (id) DO NOTHING`,
      [
        params.id,
        params.originTier,
        params.originDeviceId,
        params.locationId,
        params.eventCount,
        params.firstSeq.toString(),
        params.lastSeq.toString(),
      ],
    );
  }

  async completeBatch(
    client: DbClient,
    id: UUID,
    status: SyncBatchRow['status'],
    result: unknown,
  ): Promise<void> {
    await client.query(
      `UPDATE sync_batches SET status = $2, result = $3, processed_at = NOW() WHERE id = $1`,
      [id, status, JSON.stringify(result)],
    );
  }

  // ── sync_cursors (per-subscriber pull position, §4.5) ─────────────────────

  async getCursor(client: DbClient, subscriberId: UUID, stream = 'main'): Promise<bigint> {
    const res = await client.query<{ cursor: string }>(
      `SELECT cursor::text AS cursor FROM sync_cursors WHERE subscriber_id = $1 AND stream = $2`,
      [subscriberId, stream],
    );
    return BigInt(res.rows[0]?.cursor ?? '0');
  }

  async upsertCursor(
    client: DbClient,
    subscriberType: 'device' | 'node',
    subscriberId: UUID,
    cursor: bigint,
    stream = 'main',
  ): Promise<void> {
    await client.query(
      `INSERT INTO sync_cursors (subscriber_type, subscriber_id, stream, cursor)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (subscriber_id, stream)
       DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()
       WHERE sync_cursors.cursor < EXCLUDED.cursor`,
      [subscriberType, subscriberId, stream, cursor.toString()],
    );
  }

  /** The highest `server_seq` currently in the log — used to bound `next_cursor`/bootstrap `starting_cursor` (§4.6). */
  async getMaxServerSeq(client: DbClient): Promise<bigint> {
    const res = await client.query<{ max_seq: string }>(
      `SELECT COALESCE(MAX(server_seq), 0)::text AS max_seq FROM sync_events`,
    );
    return BigInt(res.rows[0]?.max_seq ?? '0');
  }

  /**
   * Next server-generated cloud `client_seq` (SYNC-PROTOCOL §1.5's
   * privileged cloud origin). Backed by `cloud_client_seq`
   * (migration `210_w2d_cloud_client_seq.sql`) — crash-safe, gapless.
   */
  async nextCloudClientSeq(client: DbClient): Promise<bigint> {
    const res = await client.query<{ n: string }>(`SELECT nextval('cloud_client_seq')::text AS n`);
    return BigInt(res.rows[0]!.n);
  }
}
