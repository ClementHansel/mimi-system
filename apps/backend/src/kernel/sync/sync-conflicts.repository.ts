/**
 * Raw `pg` access to `sync_conflicts` (CONTRACTS.md §1.13, SYNC-PROTOCOL §5).
 * Every §5.2 conflict (C1-C9) and every reconciliation-job exception (R1-R10)
 * lands here — the single F12/F07 queue table (§5.4).
 */
import { Injectable } from '@nestjs/common';
import type { UUID } from '@mimi/shared';
import type { DbClient } from './sync-events.repository';
import type { SyncConflictRow } from './db-rows';

export type ConflictKind =
  | 'double_count'
  | 'duplicate_receipt'
  | 'decision_race'
  | 'attendance_overlap'
  | 'negative_balance'
  | 'duplicate_inbound'
  | 'offline_auth'
  | 'duplicate_platform_order'
  | 'poison';

export type ConflictQueue = 'conflict' | 'exception' | 'finance' | 'hr';

export interface RecordConflictParams {
  kind: ConflictKind;
  queue: ConflictQueue;
  entity: string;
  entityId: UUID | null;
  locationId: UUID | null;
  winnerEventId?: UUID | null;
  loserEventId?: UUID | null;
  detail: Record<string, unknown>;
  physicalEffectSuspected?: boolean;
  assigneeRole?: string | null;
}

/** Every method takes its own `client: DbClient` — no pool of its own, same reasoning as `OfflineCredentialsRepository`. */
@Injectable()
export class SyncConflictsRepository {
  /**
   * Idempotent-by-content: the same detection running twice (e.g. a
   * re-processed batch overlap, or the nightly sweep re-scanning a day it
   * already flagged) must not open a second open row for the same
   * (kind, entity, entityId, loserEventId) — every property test that
   * replays a batch would otherwise fabricate duplicate queue entries.
   */
  async recordConflictIfAbsent(
    client: DbClient,
    params: RecordConflictParams,
  ): Promise<{ id: UUID; created: boolean }> {
    const existing = await client.query<{ id: UUID }>(
      `SELECT id FROM sync_conflicts
        WHERE kind = $1 AND entity = $2
          AND entity_id IS NOT DISTINCT FROM $3
          AND loser_event_id IS NOT DISTINCT FROM $4
          AND status = 'open'
        LIMIT 1`,
      [params.kind, params.entity, params.entityId, params.loserEventId ?? null],
    );
    if (existing.rows[0]) return { id: existing.rows[0].id, created: false };

    const res = await client.query<{ id: UUID }>(
      `INSERT INTO sync_conflicts (
         kind, queue, entity, entity_id, location_id, winner_event_id, loser_event_id,
         detail, physical_effect_suspected, assignee_role
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [
        params.kind,
        params.queue,
        params.entity,
        params.entityId,
        params.locationId,
        params.winnerEventId ?? null,
        params.loserEventId ?? null,
        JSON.stringify(params.detail),
        params.physicalEffectSuspected ?? false,
        params.assigneeRole ?? null,
      ],
    );
    return { id: res.rows[0]!.id, created: true };
  }

  async findOpen(
    client: DbClient,
    filter: { kind?: ConflictKind; entity?: string; entityId?: UUID },
  ): Promise<SyncConflictRow[]> {
    const res = await client.query<SyncConflictRow>(
      `SELECT * FROM sync_conflicts
        WHERE status = 'open'
          AND ($1::text IS NULL OR kind = $1)
          AND ($2::text IS NULL OR entity = $2)
          AND ($3::uuid IS NULL OR entity_id = $3)
        ORDER BY created_at ASC`,
      [filter.kind ?? null, filter.entity ?? null, filter.entityId ?? null],
    );
    return res.rows;
  }

  async list(
    client: DbClient,
    filter: {
      kind?: string;
      queue?: string;
      status?: string;
      locationIds?: string[] | null;
      page: number;
      pageSize: number;
    },
  ): Promise<{ rows: SyncConflictRow[]; total: number }> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (filter.kind) {
      conds.push(`kind = $${i++}`);
      args.push(filter.kind);
    }
    if (filter.queue) {
      conds.push(`queue = $${i++}`);
      args.push(filter.queue);
    }
    if (filter.status) {
      conds.push(`status = $${i++}`);
      args.push(filter.status);
    }
    if (filter.locationIds) {
      conds.push(`location_id = ANY($${i++}::uuid[])`);
      args.push(filter.locationIds);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const offset = (filter.page - 1) * filter.pageSize;

    const [rows, count] = await Promise.all([
      client.query<SyncConflictRow>(
        `SELECT * FROM sync_conflicts ${where} ORDER BY created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
        [...args, filter.pageSize, offset],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM sync_conflicts ${where}`,
        args,
      ),
    ]);
    return { rows: rows.rows, total: Number(count.rows[0]?.count ?? '0') };
  }

  async dismiss(
    client: DbClient,
    id: UUID,
    resolvedBy: UUID,
    reason: string,
  ): Promise<SyncConflictRow | undefined> {
    const res = await client.query<SyncConflictRow>(
      `UPDATE sync_conflicts
          SET status = 'dismissed', resolved_by = $2, resolved_at = NOW(), resolution = $3
        WHERE id = $1 AND status = 'open'
        RETURNING *`,
      [id, resolvedBy, reason],
    );
    return res.rows[0];
  }

  async resolve(
    client: DbClient,
    id: UUID,
    resolvedBy: UUID,
    resolution: string,
    resolutionEventId?: UUID | null,
  ): Promise<SyncConflictRow | undefined> {
    const res = await client.query<SyncConflictRow>(
      `UPDATE sync_conflicts
          SET status = 'resolved', resolved_by = $2, resolved_at = NOW(), resolution = $3, resolution_event_id = $4
        WHERE id = $1
        RETURNING *`,
      [id, resolvedBy, resolution, resolutionEventId ?? null],
    );
    return res.rows[0];
  }
}
