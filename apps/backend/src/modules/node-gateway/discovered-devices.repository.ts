/**
 * Raw-`pg` access to `discovered_devices` (CONTRACTS.md block 110-119, D-13
 * LAN discovery). No RLS policy (migration 116 — API-gated only, like
 * `device_heartbeats`/`device_events`), but `mimi_app` still has no direct
 * grants of its own (D-21/D-22), so every call still needs a `DbClient`
 * whose transaction already issued `SET LOCAL ROLE app_user`.
 */
import { Injectable } from '@nestjs/common';
import type { UUID } from '@mimi/shared';
import type { DbClient } from '../../kernel/sync/sync-events.repository';

export type DiscoveredDeviceStatusRow = 'new' | 'confirmed' | 'ignored';

export interface DiscoveredDeviceRow {
  id: UUID;
  node_id: UUID;
  source: 'mdns' | 'ssdp' | 'onvif' | 'tcp_probe';
  ip_address: string;
  mac_address: string | null;
  vendor: string | null;
  model: string | null;
  suggested_category: string | null;
  suggested_name: string | null;
  status: DiscoveredDeviceStatusRow;
  confirmed_device_id: UUID | null;
  first_seen_at: string;
  last_seen_at: string;
  raw: Record<string, unknown>;
}

@Injectable()
export class DiscoveredDevicesRepository {
  /** `discovery:report` ingest (§4.22, D-13) — one row per `(node_id, ip_address, mac_address)`, upserted on every scan so `last_seen_at` tracks presence without growing unboundedly. */
  async upsert(
    client: DbClient,
    nodeId: UUID,
    item: { source: string; ipAddress: string; macAddress: string | null; vendor: string | null; model: string | null; suggestedCategory: string | null; suggestedName: string | null; raw?: Record<string, unknown> },
  ): Promise<DiscoveredDeviceRow> {
    const res = await client.query<DiscoveredDeviceRow>(
      `INSERT INTO discovered_devices (node_id, source, ip_address, mac_address, vendor, model, suggested_category, suggested_name, raw, last_seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (node_id, ip_address, mac_address) DO UPDATE SET
         source = EXCLUDED.source, vendor = EXCLUDED.vendor, model = EXCLUDED.model,
         suggested_category = EXCLUDED.suggested_category, suggested_name = EXCLUDED.suggested_name,
         raw = EXCLUDED.raw, last_seen_at = NOW(),
         -- a device that reappears after being marked 'ignored'/'new' stays as-is; only resurrect
         -- nothing already 'confirmed' (that link must be broken explicitly, not by a rescan).
         status = discovered_devices.status
       RETURNING *`,
      [nodeId, item.source, item.ipAddress, item.macAddress, item.vendor, item.model, item.suggestedCategory, item.suggestedName, JSON.stringify(item.raw ?? {})],
    );
    return res.rows[0]!;
  }

  /** Rows for this node not present in the latest scan's `stillPresentIds` are NOT deleted (they may reappear) — this only matters for a future "flag as gone" UX; V1 keeps `last_seen_at` as the presence signal and leaves `status` untouched. */
  async listByNode(client: DbClient, nodeId: UUID, status?: string): Promise<DiscoveredDeviceRow[]> {
    const conds = ['node_id = $1'];
    const args: unknown[] = [nodeId];
    if (status) { conds.push(`status = $2`); args.push(status); }
    const res = await client.query<DiscoveredDeviceRow>(
      `SELECT * FROM discovered_devices WHERE ${conds.join(' AND ')} ORDER BY last_seen_at DESC`,
      args,
    );
    return res.rows;
  }

  async findById(client: DbClient, id: UUID): Promise<DiscoveredDeviceRow | undefined> {
    const res = await client.query<DiscoveredDeviceRow>(`SELECT * FROM discovered_devices WHERE id = $1`, [id]);
    return res.rows[0];
  }

  async markConfirmed(client: DbClient, id: UUID, deviceId: UUID): Promise<void> {
    await client.query(`UPDATE discovered_devices SET status = 'confirmed', confirmed_device_id = $2 WHERE id = $1`, [id, deviceId]);
  }

  async markIgnored(client: DbClient, id: UUID): Promise<void> {
    await client.query(`UPDATE discovered_devices SET status = 'ignored' WHERE id = $1`, [id]);
  }
}
