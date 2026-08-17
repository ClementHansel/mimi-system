/**
 * Raw-`pg` access to `branch_nodes` (CONTRACTS.md block 110-119) — M22's
 * table. `FORCE ROW LEVEL SECURITY` (`app_has_location`, migration 116)
 * applies exactly like `devices` — every query here runs against a
 * `DbClient` the caller already put under `SET LOCAL ROLE app_user`
 * (a request's `req.dbClient`, or `withSystemContext` for the public/
 * node-token routes that have no user session at all).
 */
import { Injectable } from '@nestjs/common';
import type { UUID } from '@mimi/shared';
import type { DbClient } from '../../kernel/sync/sync-events.repository';

export type NodeStatusRow = 'online' | 'stale' | 'offline' | 'unpaired' | 'retired';

export interface BranchNodeRow {
  id: UUID;
  location_id: UUID;
  name: string;
  status: NodeStatusRow;
  version: string | null;
  node_token_hash: string | null;
  ip_address: string | null;
  hostname: string | null;
  os_info: Record<string, unknown>;
  last_seen_at: string | null;
  paired_at: string | null;
  paired_by: UUID | null;
  unpaired_at: string | null;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BranchNodeWithLocation extends BranchNodeRow {
  location_name: string;
}

const NODE_SELECT = `
  SELECT n.*, l.name AS location_name
    FROM branch_nodes n
    JOIN locations l ON l.id = n.location_id
`;

@Injectable()
export class BranchNodesRepository {
  async findById(client: DbClient, id: UUID): Promise<BranchNodeWithLocation | undefined> {
    const res = await client.query<BranchNodeWithLocation>(`${NODE_SELECT} WHERE n.id = $1`, [id]);
    return res.rows[0];
  }

  async findByLocationId(client: DbClient, locationId: UUID): Promise<BranchNodeRow | undefined> {
    const res = await client.query<BranchNodeRow>(`SELECT * FROM branch_nodes WHERE location_id = $1 AND status <> 'retired'`, [locationId]);
    return res.rows[0];
  }

  async list(client: DbClient, filters: { locationId?: UUID; status?: string; locationIds?: readonly UUID[] | null }): Promise<BranchNodeWithLocation[]> {
    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (filters.locationId) { conds.push(`n.location_id = $${i++}`); args.push(filters.locationId); }
    else if (filters.locationIds) { conds.push(`n.location_id = ANY($${i++}::uuid[])`); args.push(filters.locationIds); }
    if (filters.status) { conds.push(`n.status = $${i}`); args.push(filters.status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const res = await client.query<BranchNodeWithLocation>(`${NODE_SELECT} ${where} ORDER BY n.created_at DESC`, args);
    return res.rows;
  }

  /** `POST /api/nodes/register` (CONTRACTS §4.22) — one node max per location (`branch_nodes.location_id UNIQUE`), so this is idempotent-by-conflict: a location that already has a (non-retired) node is a caller error, checked by `NodesController` before this insert. */
  async create(
    client: DbClient,
    params: { locationId: UUID; name: string; version: string; hostname: string; osInfo: Record<string, unknown>; nodeTokenHash: string; pairedBy: UUID | null },
  ): Promise<BranchNodeRow> {
    // `last_seen_at` stamped NOW at registration — same "first sighting is silent" reasoning as
    // `DeviceRegistryRepository.create` (§7.3): a NULL `last_seen_at` must mean "never contacted,"
    // never "contacted long enough ago to be stale."
    const res = await client.query<BranchNodeRow>(
      `INSERT INTO branch_nodes (location_id, name, status, version, node_token_hash, hostname, os_info, last_seen_at, paired_at, paired_by)
       VALUES ($1,$2,'online',$3,$4,$5,$6,NOW(),NOW(),$7)
       RETURNING *`,
      [params.locationId, params.name, params.version, params.nodeTokenHash, params.hostname, JSON.stringify(params.osInfo ?? {}), params.pairedBy],
    );
    return res.rows[0]!;
  }

  async update(client: DbClient, id: UUID, patch: { name?: string }): Promise<BranchNodeRow | undefined> {
    if (patch.name === undefined) {
      const res = await client.query<BranchNodeRow>(`SELECT * FROM branch_nodes WHERE id = $1`, [id]);
      return res.rows[0];
    }
    const res = await client.query<BranchNodeRow>(`UPDATE branch_nodes SET name = $2 WHERE id = $1 RETURNING *`, [id, patch.name]);
    return res.rows[0];
  }

  async unpair(client: DbClient, id: UUID): Promise<BranchNodeRow | undefined> {
    const res = await client.query<BranchNodeRow>(
      `UPDATE branch_nodes SET status = 'unpaired', node_token_hash = NULL, unpaired_at = NOW() WHERE id = $1 RETURNING *`,
      [id],
    );
    // A node's own disappearance must not strand its devices mid-air (§7.3): they fall back to
    // cloud-direct per SYNC-PROTOCOL §1.3's fail-away rule, but the registry link is severed
    // immediately here rather than waiting on the next heartbeat/sweep cycle.
    await client.query(`UPDATE devices SET node_id = NULL WHERE node_id = $1`, [id]);
    return res.rows[0];
  }

  /**
   * `relayQueueDepth` (§7.2's `NodeHeartbeat.relayQueueDepth`) is persisted into `settings` alongside
   * a `relayQueueDepthAt` timestamp — the ONLY place the cloud durably learns how many events a node
   * is still holding that haven't reached the cloud yet. This is what BUILD-PLAN D-26's drain-before-off
   * check reads (`OutletNodeSettingController`): the cloud has no other way to know a node's outbox
   * depth (the events themselves don't exist here until the node actually pushes them), so a
   * heartbeat-reported number, timestamped so a caller can judge its own freshness, is the only signal
   * available. Omitted (`undefined`) leaves the previous reading untouched rather than zeroing it —
   * a heartbeat that doesn't carry the field must never be misread as "queue is now empty."
   */
  async recordHeartbeat(client: DbClient, id: UUID, beat: { version: string; ipAddress?: string | null; relayQueueDepth?: number }): Promise<void> {
    await client.query(
      `UPDATE branch_nodes
          SET last_seen_at = NOW(), version = $2, status = 'online', ip_address = COALESCE($3, ip_address),
              settings = CASE WHEN $4::int IS NULL THEN settings
                         ELSE jsonb_set(jsonb_set(settings, '{relayQueueDepth}', to_jsonb($4::int), true), '{relayQueueDepthAt}', to_jsonb(NOW()::text), true)
                         END
        WHERE id = $1`,
      [id, beat.version, beat.ipAddress ?? null, beat.relayQueueDepth ?? null],
    );
  }

  async setSettings(client: DbClient, id: UUID, patch: Record<string, unknown>): Promise<BranchNodeRow | undefined> {
    const res = await client.query<BranchNodeRow>(
      `UPDATE branch_nodes SET settings = settings || $2::jsonb WHERE id = $1 RETURNING *`,
      [id, JSON.stringify(patch)],
    );
    return res.rows[0];
  }

  async findByTokenHash(client: DbClient, tokenHash: string): Promise<BranchNodeRow | undefined> {
    const res = await client.query<BranchNodeRow>(`SELECT * FROM branch_nodes WHERE node_token_hash = $1`, [tokenHash]);
    return res.rows[0];
  }

  /** §7.3 sweep read side — `last_seen_at IS NULL` excluded (never swept), same "first sighting is silent" reasoning as `DeviceRegistryRepository.findDevicesPastThreshold`. */
  async findNodesPastThreshold(client: DbClient, cutoffIso: string, fromStatuses: readonly NodeStatusRow[]): Promise<BranchNodeRow[]> {
    const res = await client.query<BranchNodeRow>(
      `SELECT * FROM branch_nodes WHERE status = ANY($1::text[]) AND last_seen_at IS NOT NULL AND last_seen_at < $2`,
      [fromStatuses, cutoffIso],
    );
    return res.rows;
  }

  async setStatus(client: DbClient, id: UUID, status: NodeStatusRow): Promise<void> {
    await client.query(`UPDATE branch_nodes SET status = $2 WHERE id = $1`, [id, status]);
  }
}
