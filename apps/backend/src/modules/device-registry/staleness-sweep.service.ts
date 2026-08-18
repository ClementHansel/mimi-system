/**
 * The D-13 staleness sweep (CONTRACTS.md §7.3) — the single source of truth
 * for device/node/outlet status transitions. Runs every 30s
 * (`OnApplicationBootstrap`, plain `setInterval` — no `@nestjs/schedule`
 * dependency exists in this workspace and adding one needs W1-A per
 * collision rule 2; the branch node's own `RelayEngine` uses the identical
 * `setInterval` pattern for its heartbeat/discovery loops).
 *
 * Thresholds (§7.3, single source of truth):
 *   device: beat 60s -> stale after 180s -> offline after 600s
 *   node:   beat 30s -> stale after 90s  -> offline after 300s
 *   outlet (derived): ALL devices AND node offline (or node absent) for > 10 min
 *
 * "First sighting is silent" (§7.3, AIRE rule): a row with `last_seen_at IS
 * NULL` is never swept (`DeviceRegistryRepository.findDevicesPastThreshold`/
 * the equivalent node query both exclude it) — every row this system
 * creates stamps `last_seen_at = NOW()` at registration for exactly this
 * reason.
 *
 * "Never repeats, only edges" (§7.3): every transition is guarded by
 * `WHERE status <> $newStatus` at the UPDATE (never re-fires for a row
 * that's already in the target state) and the outlet-level edge is guarded
 * by inspecting the location's own most recent `outlet_offline`/
 * `outlet_online` `device_events` row before writing a new one.
 *
 * Notification scope (a judgment call, flagged in the W3-10 report):
 * individual device/node transitions get `device_events` + `topology:update`
 * only — no per-device or per-node notification template exists
 * (`kernel/notification/template-registry.ts`, W2-C-owned, only pre-
 * registers `outlet_offline`). The OUTLET-level edge is what actually pages
 * Owner/Manager, matching CONTRACTS' own singular phrase "the outlet-offline
 * alert." The `outlet_online` RECOVERY edge writes its `device_events` row
 * and broadcasts `topology:update` but does not notify (no `outlet_online`
 * template is registered anywhwere in this codebase to send it through) —
 * an honest gap for whoever owns that registry, not silently invented here.
 */
import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type { UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import { withSystemContext } from '../../kernel/sync/system-rls-context';
import { SyncEmitService } from '../../kernel/sync/sync-emit.service';
import { NotificationService } from '../../kernel/notification/notification.service';
import { DeviceRegistryRepository } from './device-registry.repository';
import { TopologyGateway } from './topology.gateway';

export const DEVICE_STALE_AFTER_MS = 180_000;
export const DEVICE_OFFLINE_AFTER_MS = 600_000;
export const NODE_STALE_AFTER_MS = 90_000;
export const NODE_OFFLINE_AFTER_MS = 300_000;
export const OUTLET_OFFLINE_AFTER_MS = 10 * 60_000;
export const SWEEP_INTERVAL_MS = 30_000;

const CLOUD_ORIGIN_ACTOR = '00000000-0000-0000-0000-0000000000c1' as UUID;

interface NodeRowLite {
  id: UUID;
  location_id: UUID;
  status: string;
}

@Injectable()
export class StalenessSweepService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(StalenessSweepService.name);
  private timer?: NodeJS.Timeout;

  constructor(
    @Inject(DATABASE_POOL) private readonly pool: Pool,
    private readonly devices: DeviceRegistryRepository,
    private readonly syncEmit: SyncEmitService,
    private readonly notifications: NotificationService,
    private readonly topologyGateway: TopologyGateway,
  ) {}

  onApplicationBootstrap(): void {
    // Fire once immediately (a freshly-booted backend shouldn't wait 30s for its first sweep), then
    // on the interval. Errors are caught and logged per-tick — one bad tick must never kill the loop.
    void this.runSweep().catch((err) =>
      this.logger.error(`initial sweep failed: ${(err as Error).message}`),
    );
    this.timer = setInterval(() => {
      void this.runSweep().catch((err) =>
        this.logger.error(`sweep tick failed: ${(err as Error).message}`),
      );
    }, SWEEP_INTERVAL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Exposed for tests — runs one sweep pass synchronously without waiting on the interval. */
  async runSweep(): Promise<void> {
    await withSystemContext(this.pool, async (client) => {
      const now = new Date();
      await this.sweepDevices(client, now);
      await this.sweepNodes(client, now);
      await this.sweepOutlets(client, now);
    });
  }

  private async sweepDevices(client: PoolClient, now: Date): Promise<void> {
    const staleCutoff = new Date(now.getTime() - DEVICE_STALE_AFTER_MS).toISOString();
    const offlineCutoff = new Date(now.getTime() - DEVICE_OFFLINE_AFTER_MS).toISOString();

    // offline first (more time has elapsed — a row past the offline cutoff is also past the stale
    // one, and must land on 'offline', not get caught by the stale branch below).
    const toOffline = await this.devices.findDevicesPastThreshold(client, offlineCutoff, [
      'online',
      'stale',
    ]);
    for (const row of toOffline) {
      await this.devices.setDeviceStatus(client, row.id, 'offline');
      await this.recordDeviceTransition(client, row.id, row.location_id, 'offline');
    }
    const offlineIds = new Set(toOffline.map((r) => r.id));

    const toStale = await this.devices.findDevicesPastThreshold(client, staleCutoff, ['online']);
    for (const row of toStale) {
      if (offlineIds.has(row.id)) continue;
      await this.devices.setDeviceStatus(client, row.id, 'stale');
      await this.recordDeviceTransition(client, row.id, row.location_id, 'stale');
    }
  }

  private async recordDeviceTransition(
    client: PoolClient,
    deviceId: UUID,
    locationId: UUID,
    status: 'stale' | 'offline',
  ): Promise<void> {
    await this.devices.insertDeviceEvent(client, { deviceId, locationId, type: status });
    await this.syncEmit
      .emit(client, {
        entity: 'device_events',
        op: status === 'offline' ? 'went_offline' : 'stale',
        entityId: deviceId,
        locationId,
        actorUserId: CLOUD_ORIGIN_ACTOR,
        data: {},
      })
      .catch((err: Error) =>
        this.logger.warn(
          `sync-emit for device ${deviceId} transition failed (non-fatal): ${err.message}`,
        ),
      );
    this.topologyGateway.emitUpdate({ locationId, deviceId, status });
  }

  private async sweepNodes(client: PoolClient, now: Date): Promise<void> {
    const staleCutoff = new Date(now.getTime() - NODE_STALE_AFTER_MS).toISOString();
    const offlineCutoff = new Date(now.getTime() - NODE_OFFLINE_AFTER_MS).toISOString();

    const toOffline = await client.query<NodeRowLite>(
      `SELECT id, location_id, status FROM branch_nodes
        WHERE status = ANY($1::text[]) AND last_seen_at IS NOT NULL AND last_seen_at < $2`,
      [['online', 'stale'], offlineCutoff],
    );
    for (const row of toOffline.rows) {
      await client.query(`UPDATE branch_nodes SET status = 'offline' WHERE id = $1`, [row.id]);
      await this.recordNodeTransition(client, row.id, row.location_id, 'offline');
    }
    const offlineIds = new Set(toOffline.rows.map((r) => r.id));

    const toStale = await client.query<NodeRowLite>(
      `SELECT id, location_id, status FROM branch_nodes
        WHERE status = 'online' AND last_seen_at IS NOT NULL AND last_seen_at < $1`,
      [staleCutoff],
    );
    for (const row of toStale.rows) {
      if (offlineIds.has(row.id)) continue;
      await client.query(`UPDATE branch_nodes SET status = 'stale' WHERE id = $1`, [row.id]);
      await this.recordNodeTransition(client, row.id, row.location_id, 'stale');
    }
  }

  private async recordNodeTransition(
    client: PoolClient,
    nodeId: UUID,
    locationId: UUID,
    status: 'stale' | 'offline',
  ): Promise<void> {
    await this.devices.insertDeviceEvent(client, { nodeId, locationId, type: status });
    await this.syncEmit
      .emit(client, {
        entity: 'device_events',
        op: status === 'offline' ? 'went_offline' : 'stale',
        entityId: nodeId,
        locationId,
        actorUserId: CLOUD_ORIGIN_ACTOR,
        data: {},
      })
      .catch((err: Error) =>
        this.logger.warn(
          `sync-emit for node ${nodeId} transition failed (non-fatal): ${err.message}`,
        ),
      );
    this.topologyGateway.emitUpdate({ locationId, nodeId, status });
  }

  /**
   * The one condition that pages anyone (§7.3, W6-06 alert precision): ALL
   * of an outlet's ACTIVE devices (excluding administrative `unpaired`/
   * `retired` rows) AND its node (if one exists) have been dark for more
   * than 10 minutes — anchored on the latest `last_seen_at` across that
   * whole set, so a single tablet asleep overnight never pages anyone while
   * the rest of the outlet is up.
   */
  private async sweepOutlets(client: PoolClient, now: Date): Promise<void> {
    const outletsRes = await client.query<{ id: UUID; code: string; name: string }>(
      `SELECT id, code, name FROM locations WHERE type = 'outlet' AND is_active`,
    );

    for (const outlet of outletsRes.rows) {
      const devicesRes = await client.query<{ status: string; last_seen_at: string | null }>(
        `SELECT status, last_seen_at FROM devices WHERE location_id = $1 AND status NOT IN ('unpaired','retired')`,
        [outlet.id],
      );
      const nodeRes = await client.query<{ status: string; last_seen_at: string | null }>(
        `SELECT status, last_seen_at FROM branch_nodes WHERE location_id = $1 AND status <> 'retired'`,
        [outlet.id],
      );

      const activeRows = [...devicesRes.rows, ...nodeRes.rows];
      if (activeRows.length === 0) continue; // no hardware ever registered at this outlet — nothing to alert on

      const allOffline = activeRows.every((r) => r.status === 'offline');
      const lastSeenTimes = activeRows.map((r) =>
        r.last_seen_at ? new Date(r.last_seen_at).getTime() : 0,
      );
      const mostRecentSeenAt = Math.max(...lastSeenTimes);
      const darkForMs = now.getTime() - mostRecentSeenAt;

      const lastEdgeRes = await client.query<{ type: string }>(
        `SELECT type FROM device_events
          WHERE location_id = $1 AND device_id IS NULL AND node_id IS NULL AND type IN ('outlet_offline','outlet_online')
          ORDER BY created_at DESC LIMIT 1`,
        [outlet.id],
      );
      const currentlyMarkedOffline = lastEdgeRes.rows[0]?.type === 'outlet_offline';

      if (allOffline && darkForMs > OUTLET_OFFLINE_AFTER_MS && !currentlyMarkedOffline) {
        await this.devices.insertDeviceEvent(client, {
          locationId: outlet.id,
          type: 'outlet_offline',
          detail: { darkForMs },
        });
        await this.syncEmit
          .emit(client, {
            entity: 'device_events',
            op: 'outlet_offline',
            entityId: outlet.id,
            locationId: outlet.id,
            actorUserId: CLOUD_ORIGIN_ACTOR,
            data: {},
          })
          .catch((err: Error) =>
            this.logger.warn(
              `sync-emit for outlet ${outlet.id} offline failed (non-fatal): ${err.message}`,
            ),
          );
        this.topologyGateway.emitUpdate({ locationId: outlet.id, status: 'offline' });
        await this.notifyOutletOffline(client, outlet, mostRecentSeenAt);
      } else if (!allOffline && currentlyMarkedOffline) {
        await this.devices.insertDeviceEvent(client, {
          locationId: outlet.id,
          type: 'outlet_online',
        });
        await this.syncEmit
          .emit(client, {
            entity: 'device_events',
            op: 'outlet_online',
            entityId: outlet.id,
            locationId: outlet.id,
            actorUserId: CLOUD_ORIGIN_ACTOR,
            data: {},
          })
          .catch((err: Error) =>
            this.logger.warn(
              `sync-emit for outlet ${outlet.id} online failed (non-fatal): ${err.message}`,
            ),
          );
        this.topologyGateway.emitUpdate({ locationId: outlet.id, status: 'online' });
        // No `outlet_online` notification template exists (see file header) — device_events + topology:update only.
      }
    }
  }

  private async notifyOutletOffline(
    client: PoolClient,
    outlet: { id: UUID; name: string },
    mostRecentSeenAt: number,
  ): Promise<void> {
    const recipients = await client.query<{ id: UUID }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.key IN ('owner','manager') AND u.is_active`,
    );
    if (recipients.rows.length === 0) return;
    await this.notifications.notify({
      templateKey: 'outlet_offline',
      userIds: recipients.rows.map((r) => r.id),
      params: {
        locationName: outlet.name,
        lastSeenAt: mostRecentSeenAt > 0 ? new Date(mostRecentSeenAt).toISOString() : 'unknown',
      },
      locationId: outlet.id,
    });
  }
}
