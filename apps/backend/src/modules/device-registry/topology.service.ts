/**
 * Assembles the D-13 topology tree (CONTRACTS.md §7.4/§7.5) — Pusat -> Kota
 * -> Outlet -> Node -> Device. Where no branch node exists for a location
 * (the default deployment, SCOPE-OUT-01/02, D-13's own wording) the tree
 * degrades gracefully: `node: null`, the location's `devices` array is just
 * its app-session devices, same shape, same UI. There is no separate
 * "no-node" code path — a location simply never joins a `branch_nodes` row.
 */
import { Inject, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import type { DbClient } from '../../kernel/sync/sync-events.repository';

const ADMINISTRATIVE_STATUSES = new Set(['unpaired', 'retired']);

interface TopologyCounts {
  online: number;
  stale: number;
  offline: number;
  total: number;
}

interface LocationRow {
  id: UUID;
  code: string;
  name: string;
  type: 'warehouse' | 'outlet';
  city: string;
  node_enabled: boolean;
}

interface NodeRow {
  id: UUID;
  location_id: UUID;
  name: string;
  status: string;
  version: string | null;
  last_seen_at: string | null;
}

interface DeviceRowLite {
  id: UUID;
  location_id: UUID;
  name: string;
  category: string;
  status: string;
  app_version: string | null;
  queue_depth: number;
  last_seen_at: string | null;
  ip_address: string | null;
}

function emptyCounts(): TopologyCounts {
  return { online: 0, stale: 0, offline: 0, total: 0 };
}

function tally(counts: TopologyCounts, status: string): void {
  counts.total += 1;
  if (status === 'online') counts.online += 1;
  else if (status === 'stale') counts.stale += 1;
  else if (status === 'offline') counts.offline += 1;
}

@Injectable()
export class TopologyService {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  private async loadRows(client: DbClient) {
    const locations = await client.query<LocationRow>(
      `SELECT id, code, name, type, city, COALESCE((settings->>'nodeEnabled')::boolean, false) AS node_enabled
         FROM locations WHERE is_active ORDER BY city, name`,
    );
    const nodes = await client.query<NodeRow>(`SELECT id, location_id, name, status, version, last_seen_at FROM branch_nodes WHERE status <> 'retired'`);
    const devices = await client.query<DeviceRowLite>(
      `SELECT id, location_id, name, category, status, app_version, queue_depth, last_seen_at, ip_address FROM devices`,
    );
    const discoveredCounts = await client.query<{ node_id: UUID; n: string }>(
      `SELECT node_id, COUNT(*)::text AS n FROM discovered_devices WHERE status = 'new' GROUP BY node_id`,
    );
    const quarantine = await client.query<{ location_id: UUID; n: string }>(
      `SELECT location_id, COUNT(*)::text AS n FROM sync_events WHERE apply_status = 'quarantined' AND location_id IS NOT NULL GROUP BY location_id`,
    );
    const conflicts = await client.query<{ location_id: UUID; queue: string; n: string }>(
      `SELECT location_id, queue, COUNT(*)::text AS n FROM sync_conflicts WHERE status = 'open' AND location_id IS NOT NULL GROUP BY location_id, queue`,
    );

    return {
      locations: locations.rows,
      nodesByLocation: new Map(nodes.rows.map((n) => [n.location_id, n])),
      devicesByLocation: groupBy(devices.rows, (d) => d.location_id),
      discoveredByNode: new Map(discoveredCounts.rows.map((r) => [r.node_id, Number(r.n)])),
      quarantineByLocation: new Map(quarantine.rows.map((r) => [r.location_id, Number(r.n)])),
      conflictsByLocation: aggregateConflicts(conflicts.rows),
    };
  }

  private buildLocation(
    loc: LocationRow,
    node: NodeRow | undefined,
    devices: DeviceRowLite[],
    discoveredByNode: Map<UUID, number>,
    quarantineByLocation: Map<UUID, number>,
    conflictsByLocation: Map<UUID, { conflicts: number; exceptions: number }>,
  ) {
    const counts = emptyCounts();
    const activeDevices = devices.filter((d) => !ADMINISTRATIVE_STATUSES.has(d.status));
    for (const d of activeDevices) tally(counts, d.status);

    const queueDepth = devices.reduce((sum, d) => sum + (d.queue_depth ?? 0), 0);
    const quarantineDepth = quarantineByLocation.get(loc.id) ?? 0;
    const lastSyncCandidates = devices.map((d) => d.last_seen_at).filter((v): v is string => !!v);
    const lastSyncAt = lastSyncCandidates.length ? lastSyncCandidates.sort().at(-1)! : null;
    const conflictBucket = conflictsByLocation.get(loc.id) ?? { conflicts: 0, exceptions: 0 };

    const nodeAbsentOrOffline = !node || node.status === 'offline';
    const allDevicesDown = activeDevices.length === 0 || activeDevices.every((d) => d.status === 'offline');
    const allOnline = (!node || node.status === 'online') && activeDevices.every((d) => d.status === 'online');
    const outletStatus: 'online' | 'degraded' | 'offline' = allDevicesDown && nodeAbsentOrOffline ? 'offline' : allOnline ? 'online' : 'degraded';

    return {
      location: { id: loc.id, code: loc.code, name: loc.name, type: loc.type, city: loc.city },
      // BUILD-PLAN D-26: an outlet whose Owner never switched this ON is not "missing a node it was
      // supposed to have" — `node: null` + `nodeEnabled: false` together tell the UI this is the
      // hardware-free default (RISK-P5), not a degraded/unpaired state. `nodeEnabled: true` with
      // `node: null` is the one state actually worth flagging (setting is on, pairing hasn't happened
      // yet, or the node was unpaired without the setting being turned off first).
      nodeEnabled: loc.node_enabled,
      node: node
        ? {
            id: node.id,
            name: node.name,
            status: node.status,
            version: node.version,
            lastSeenAt: node.last_seen_at,
            relayQueueDepth: 0, // populated from the node's own heartbeat cache once a live-heartbeat store exists (W5-07 follow-up — see report)
            discoveredNewCount: discoveredByNode.get(node.id) ?? 0,
          }
        : null,
      devices: devices.map((d) => ({
        id: d.id,
        name: d.name,
        category: d.category,
        status: d.status,
        appVersion: d.app_version,
        queueDepth: d.queue_depth,
        lastSeenAt: d.last_seen_at,
        ipAddress: d.ip_address,
      })),
      counts,
      syncHealth: {
        queueDepth,
        quarantineDepth,
        lastSyncAt,
        conflictsOpen: conflictBucket.conflicts,
        exceptionsOpen: conflictBucket.exceptions,
        offlineAuthPending: 0, // D-17 pending re-verification count — needs OfflineAuthService's own query surface; left as a follow-up (see report)
      },
      outletStatus,
    };
  }

  async buildTree(client?: DbClient) {
    const run = async (c: DbClient) => {
      const { locations, nodesByLocation, devicesByLocation, discoveredByNode, quarantineByLocation, conflictsByLocation } = await this.loadRows(c);

      const pusatRow = locations.find((l) => l.type === 'warehouse');
      const pusat = pusatRow
        ? this.buildLocation(pusatRow, nodesByLocation.get(pusatRow.id), devicesByLocation.get(pusatRow.id) ?? [], discoveredByNode, quarantineByLocation, conflictsByLocation)
        : null;

      const outlets = locations.filter((l) => l.type === 'outlet');
      const byCity = groupBy(outlets, (l) => l.city);

      const cities = Array.from(byCity.entries()).map(([city, locs]) => {
        const builtOutlets = locs.map((loc) =>
          this.buildLocation(loc, nodesByLocation.get(loc.id), devicesByLocation.get(loc.id) ?? [], discoveredByNode, quarantineByLocation, conflictsByLocation),
        );
        const counts = emptyCounts();
        for (const o of builtOutlets) {
          counts.online += o.counts.online;
          counts.stale += o.counts.stale;
          counts.offline += o.counts.offline;
          counts.total += o.counts.total;
        }
        return { city, counts, outlets: builtOutlets };
      });

      const totals = emptyCounts();
      let outletsOffline = 0;
      let openConflicts = 0;
      let openExceptions = 0;
      const allBuilt = [...(pusat ? [pusat] : []), ...cities.flatMap((c) => c.outlets)];
      for (const loc of allBuilt) {
        totals.online += loc.counts.online;
        totals.stale += loc.counts.stale;
        totals.offline += loc.counts.offline;
        totals.total += loc.counts.total;
        if (loc.outletStatus === 'offline') outletsOffline += 1;
        openConflicts += loc.syncHealth.conflictsOpen;
        openExceptions += loc.syncHealth.exceptionsOpen;
      }

      return {
        generatedAt: new Date().toISOString(),
        pusat,
        cities,
        totals: { ...totals, outletsOffline, openConflicts, openExceptions },
      };
    };

    if (client) return run(client);
    return withSystemContext(this.pool, run as (c: PoolClient) => ReturnType<typeof run>);
  }

  async buildSummary(client?: DbClient) {
    const tree = await this.buildTree(client);
    return {
      totals: tree.totals,
      byCity: tree.cities.map((c) => ({
        city: c.city,
        counts: c.counts,
        outletsOffline: c.outlets.filter((o) => o.outletStatus === 'offline').length,
      })),
    };
  }
}

function groupBy<T, K>(rows: T[], keyFn: (row: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = map.get(key);
    if (list) list.push(row);
    else map.set(key, [row]);
  }
  return map;
}

function aggregateConflicts(rows: { location_id: UUID; queue: string; n: string }[]): Map<UUID, { conflicts: number; exceptions: number }> {
  const map = new Map<UUID, { conflicts: number; exceptions: number }>();
  for (const row of rows) {
    const bucket = map.get(row.location_id) ?? { conflicts: 0, exceptions: 0 };
    if (row.queue === 'conflict') bucket.conflicts += Number(row.n);
    else bucket.exceptions += Number(row.n);
    map.set(row.location_id, bucket);
  }
  return map;
}
