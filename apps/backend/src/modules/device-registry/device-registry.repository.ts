/**
 * Raw-`pg` access to `devices` / `device_heartbeats` / `device_events`
 * (CONTRACTS.md block 110-119) — M21's own tables. `devices`/`branch_nodes`
 * carry `FORCE ROW LEVEL SECURITY` (`app_has_location(location_id)`,
 * migration 116); `device_heartbeats`/`device_events` carry none (API-gated
 * only, per that same migration's own comment). Every query here still runs
 * through a role that has actually issued `SET LOCAL ROLE app_user` first
 * (D-21/D-22) — `mimi_app`'s own grants are empty, membership alone isn't
 * inherited (`NOINHERIT`) — so callers pass either `req.dbClient` (a
 * user-authenticated request's RLS transaction) or a client obtained via
 * `withSystemContext`/`assertSystemContext` (`kernel/sync/system-rls-
 * context.ts`, reused here rather than re-implemented — the identical
 * central-role bypass a real Owner/Manager already gets, per that file's own
 * header) for the device-token/public routes that have no user session at
 * all (register, heartbeat).
 */
import { Injectable } from '@nestjs/common';
import type { UUID } from '@mimi/shared';
import { DeviceCategory, DeviceEventType, DeviceStatus } from '@mimi/shared';
import type { DbClient } from '../../kernel/sync/sync-events.repository';

export type DeviceStatusRow = `${DeviceStatus}`;
export type DeviceCategoryRow = `${DeviceCategory}`;

export interface DeviceRow {
  id: UUID;
  location_id: UUID;
  node_id: UUID | null;
  category: DeviceCategoryRow;
  name: string;
  fingerprint: string | null;
  replaces_device_id: UUID | null;
  status: DeviceStatusRow;
  app_version: string | null;
  queue_depth: number;
  last_seen_at: string | null;
  last_sync_at: string | null;
  device_token_hash: string | null;
  ip_address: string | null;
  mac_address: string | null;
  vendor: string | null;
  model: string | null;
  os_info: Record<string, unknown>;
  metadata: Record<string, unknown>;
  paired_at: string | null;
  paired_by: UUID | null;
  unpaired_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceWithLocation extends DeviceRow {
  location_name: string;
}

export interface DeviceListFilters {
  locationIds?: readonly UUID[] | null;
  locationId?: UUID;
  category?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

const DEVICE_SELECT = `
  SELECT d.*, l.name AS location_name
    FROM devices d
    JOIN locations l ON l.id = d.location_id
`;

/** Pure repository — every method takes its own `DbClient` (either a request's RLS-scoped `PoolClient` or a system-context one); it holds no `Pool` of its own to inject. */
@Injectable()
export class DeviceRegistryRepository {
  async findById(client: DbClient, id: UUID): Promise<DeviceWithLocation | undefined> {
    const res = await client.query<DeviceWithLocation>(`${DEVICE_SELECT} WHERE d.id = $1`, [id]);
    return res.rows[0];
  }

  async findByFingerprint(client: DbClient, fingerprint: string): Promise<DeviceRow | undefined> {
    const res = await client.query<DeviceRow>(`SELECT * FROM devices WHERE fingerprint = $1`, [fingerprint]);
    return res.rows[0];
  }

  async list(client: DbClient, filters: DeviceListFilters): Promise<{ rows: DeviceWithLocation[]; total: number }> {
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(200, Math.max(1, filters.pageSize ?? 50));
    const offset = (page - 1) * pageSize;

    const conds: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (filters.locationId) { conds.push(`d.location_id = $${i++}`); args.push(filters.locationId); }
    else if (filters.locationIds) { conds.push(`d.location_id = ANY($${i++}::uuid[])`); args.push(filters.locationIds); }
    if (filters.category) { conds.push(`d.category = $${i++}`); args.push(filters.category); }
    if (filters.status) { conds.push(`d.status = $${i++}`); args.push(filters.status); }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

    const rows = await client.query<DeviceWithLocation>(
      `${DEVICE_SELECT} ${where} ORDER BY d.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
      [...args, pageSize, offset],
    );
    const count = await client.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM devices d ${where}`, args);
    return { rows: rows.rows, total: Number(count.rows[0]?.n ?? '0') };
  }

  /** `POST /api/devices/register` (CONTRACTS §4.21) — the row a pairing-token redemption creates. */
  async create(
    client: DbClient,
    params: {
      locationId: UUID;
      nodeId: UUID | null;
      category: string;
      name: string;
      fingerprint: string;
      appVersion: string;
      osInfo: Record<string, unknown>;
      replacesDeviceId: UUID | null;
      /** `null` for passive/discovered gear (printers, routers — CONTRACTS §7.1) that never itself calls `/register` and therefore has no device credential. */
      deviceTokenHash: string | null;
      pairedBy: UUID | null;
    },
  ): Promise<DeviceRow> {
    // `last_seen_at` is stamped NOW at registration (the handshake itself IS first contact) —
    // otherwise a freshly-paired device would have `last_seen_at IS NULL` and the staleness sweep
    // (§7.3's "first sighting is silent" rule) would have no way to distinguish "never seen" from
    // "seen long ago," and could sweep it into `stale`/`offline` before its first real heartbeat.
    const res = await client.query<DeviceRow>(
      `INSERT INTO devices (
         location_id, node_id, category, name, fingerprint, app_version, os_info,
         replaces_device_id, device_token_hash, status, last_seen_at, paired_at, paired_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'online',NOW(),NOW(),$10)
       RETURNING *`,
      [
        params.locationId,
        params.nodeId,
        params.category,
        params.name,
        params.fingerprint,
        params.appVersion,
        JSON.stringify(params.osInfo ?? {}),
        params.replacesDeviceId,
        params.deviceTokenHash,
        params.pairedBy,
      ],
    );
    return res.rows[0]!;
  }

  async update(client: DbClient, id: UUID, patch: { name?: string; category?: string; locationId?: UUID }): Promise<DeviceRow | undefined> {
    const sets: string[] = [];
    const args: unknown[] = [];
    let i = 1;
    if (patch.name !== undefined) { sets.push(`name = $${i++}`); args.push(patch.name); }
    if (patch.category !== undefined) { sets.push(`category = $${i++}`); args.push(patch.category); }
    if (patch.locationId !== undefined) { sets.push(`location_id = $${i++}`); args.push(patch.locationId); }
    if (sets.length === 0) return this.findById(client, id) as unknown as Promise<DeviceRow | undefined>;
    args.push(id);
    const res = await client.query<DeviceRow>(`UPDATE devices SET ${sets.join(', ')} WHERE id = $${i} RETURNING *`, args);
    return res.rows[0];
  }

  /** Revokes the device token (kill switch) and marks `unpaired` — un-synced queue stays attributable (the row, and its `replaces_device_id` chain, is never deleted). */
  async unpair(client: DbClient, id: UUID): Promise<DeviceRow | undefined> {
    const res = await client.query<DeviceRow>(
      `UPDATE devices SET status = 'unpaired', device_token_hash = NULL, unpaired_at = NOW() WHERE id = $1 RETURNING *`,
      [id],
    );
    return res.rows[0];
  }

  /** Permanent terminal state (SYNC-PROTOCOL §1.5) — `replacedByDeviceId` is recorded on the NEW row via `replaces_device_id` at its own registration; this only marks the OLD row retired. */
  async retire(client: DbClient, id: UUID): Promise<DeviceRow | undefined> {
    const res = await client.query<DeviceRow>(
      `UPDATE devices SET status = 'retired', device_token_hash = NULL, unpaired_at = COALESCE(unpaired_at, NOW()) WHERE id = $1 RETURNING *`,
      [id],
    );
    return res.rows[0];
  }

  /** Heartbeat ingest bookkeeping (§7.2) — the row update AND the append-only `device_heartbeats` history in one call. */
  async recordHeartbeat(
    client: DbClient,
    id: UUID,
    beat: {
      appVersion: string;
      queueDepth: number;
      clientTime: string;
      batteryPct?: number;
      storageFreeMb?: number;
      networkType?: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await client.query(
      `UPDATE devices SET last_seen_at = NOW(), last_sync_at = NOW(), app_version = $2, queue_depth = $3, status = 'online'
        WHERE id = $1`,
      [id, beat.appVersion, beat.queueDepth],
    );
    await client.query(
      `INSERT INTO device_heartbeats (device_id, app_version, queue_depth, client_time, battery_pct, storage_free_mb, network_type, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, beat.appVersion, beat.queueDepth, beat.clientTime, beat.batteryPct ?? null, beat.storageFreeMb ?? null, beat.networkType ?? null, JSON.stringify(beat.payload)],
    );
  }

  async recentHeartbeats(client: DbClient, deviceId: UUID, limit = 20): Promise<{ at: string; queue_depth: number; app_version: string | null; battery_pct: number | null }[]> {
    const res = await client.query<{ at: string; queue_depth: number; app_version: string | null; battery_pct: number | null }>(
      `SELECT at, queue_depth, app_version, battery_pct FROM device_heartbeats WHERE device_id = $1 ORDER BY at DESC LIMIT $2`,
      [deviceId, limit],
    );
    return res.rows;
  }

  async recentEvents(client: DbClient, deviceId: UUID, limit = 20): Promise<{ type: string; detail: unknown; created_at: string }[]> {
    const res = await client.query<{ type: string; detail: unknown; created_at: string }>(
      `SELECT type, detail, created_at FROM device_events WHERE device_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [deviceId, limit],
    );
    return res.rows;
  }

  /** `device_events` (block 113) — feeds F12 + `outlet_offline` alerting (§7.3). `type` MUST be a value the migration 113 CHECK constraint accepts (`DeviceEventType`); never invent a new one here without a schema migration. */
  async insertDeviceEvent(
    client: DbClient,
    params: { deviceId?: UUID | null; nodeId?: UUID | null; locationId: UUID | null; type: `${DeviceEventType}`; detail?: Record<string, unknown> },
  ): Promise<void> {
    await client.query(
      `INSERT INTO device_events (device_id, node_id, location_id, type, detail) VALUES ($1,$2,$3,$4,$5)`,
      [params.deviceId ?? null, params.nodeId ?? null, params.locationId, params.type, JSON.stringify(params.detail ?? {})],
    );
  }

  /**
   * Devices whose `last_seen_at` is older than `cutoffIso` and whose current
   * status is in `fromStatuses` — the staleness sweep's read side (§7.3).
   * `last_seen_at IS NULL` is deliberately EXCLUDED (never swept): §7.3's
   * "first sighting is silent" rule means a device with no sighting at all
   * yet must not be judged stale/offline before its first heartbeat — every
   * row this repository creates stamps `last_seen_at = NOW()` at
   * registration for exactly this reason, so NULL should not occur in
   * practice, but the guard stays explicit rather than relying on that.
   */
  async findDevicesPastThreshold(client: DbClient, cutoffIso: string, fromStatuses: readonly DeviceStatusRow[]): Promise<DeviceRow[]> {
    const res = await client.query<DeviceRow>(
      `SELECT * FROM devices
        WHERE status = ANY($1::text[])
          AND last_seen_at IS NOT NULL
          AND last_seen_at < $2`,
      [fromStatuses, cutoffIso],
    );
    return res.rows;
  }

  async setDeviceStatus(client: DbClient, id: UUID, status: DeviceStatusRow): Promise<void> {
    await client.query(`UPDATE devices SET status = $2 WHERE id = $1`, [id, status]);
  }

  async allLocationsWithDeviceOrNode(client: DbClient): Promise<{ id: UUID }[]> {
    const res = await client.query<{ id: UUID }>(
      `SELECT DISTINCT location_id AS id FROM devices
       UNION
       SELECT DISTINCT location_id AS id FROM branch_nodes`,
    );
    return res.rows;
  }
}
