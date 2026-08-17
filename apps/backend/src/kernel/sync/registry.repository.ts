/**
 * Read-mostly access to registry tables the sync engine needs but does not
 * own: `devices` (M21, block 110-119), `locations` (M03, block 001-009),
 * `settings` (M20, block 001-009). The sync engine never decides device
 * identity or location assignment — it only trusts the registry, never the
 * client's claim (SYNC-PROTOCOL §3.4 step 3, §4.2's scope note).
 *
 * The ONE write this file performs (`touchDeviceSync`) is the sync-specific
 * bookkeeping columns already reserved on `devices` for this purpose
 * (`queue_depth`, `last_seen_at`, `last_sync_at` — CONTRACTS.md block
 * 110-119), not a device-registry business decision.
 */
import { Injectable, Inject } from '@nestjs/common';
import { Pool } from 'pg';
import type { Money, UUID } from '@mimi/shared';
import { DATABASE_POOL } from '../../common/database/database-pool.provider';
import type { DbClient } from './sync-events.repository';
import type { DeviceRow } from './db-rows';
import { withSystemContext } from './system-rls-context';

export interface DeviceIdentity {
  id: UUID;
  locationId: UUID;
  nodeId: UUID | null;
  status: DeviceRow['status'];
}

@Injectable()
export class RegistryRepository {
  constructor(@Inject(DATABASE_POOL) private readonly pool: Pool) {}

  /**
   * `devices` is `LOC`-scoped RLS (CONTRACTS.md §1.14) — this lookup is
   * BY DESIGN cross-tenant (a device's token must resolve regardless of
   * which location it claims, §3.4 step 3: "never the client's claim"), so
   * it runs under the system/central-role context (D-21/D-22), not a
   * per-user scope. See `system-rls-context.ts`'s header for why this is a
   * legitimate bypass rather than a new hole.
   */
  async findDeviceByTokenHash(tokenHash: string): Promise<DeviceRow | undefined> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<DeviceRow>(
        `SELECT * FROM devices WHERE device_token_hash = $1`,
        [tokenHash],
      );
      return res.rows[0];
    });
  }

  /**
   * Node-token lookup — the connection-level counterpart to
   * `findDeviceByTokenHash` for the `/sync` namespace's OTHER legal
   * subscriber tier (SYNC-PROTOCOL §1.2: "a branch node plays both roles
   * simultaneously"). Added for the multi-origin relay fix (BUILD-PLAN §1
   * carried item, W3-10/`node-gateway`): a node authenticates its `/sync`
   * connection with its OWN `nodeToken` (minted at `POST /api/nodes/register`,
   * M22), never a device token — `branch_nodes.node_token_hash` is hashed
   * with the exact same `hashDeviceToken` this file's sibling
   * `device-auth.guard.ts` exports, so one hash function serves both tables.
   */
  async findNodeByTokenHash(tokenHash: string): Promise<{ id: UUID; locationId: UUID; status: string } | undefined> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<{ id: UUID; location_id: UUID; status: string }>(
        `SELECT id, location_id, status FROM branch_nodes WHERE node_token_hash = $1`,
        [tokenHash],
      );
      const row = res.rows[0];
      return row && { id: row.id, locationId: row.location_id, status: row.status };
    });
  }

  /**
   * Per-event authorization for a node-relayed batch (SYNC-PROTOCOL §4.3: "a
   * node relays all its devices" — multi-origin by definition; §3.4 step 3:
   * "never the client's claim"). Unlike a device's OWN connection (where
   * connection identity and event origin are the same thing, checked
   * together in `sync.gateway.ts`'s device path), a node's connection
   * identity (`nodeId`) is NOT the event's origin (`originDeviceId`) — each
   * relayed event must independently resolve to a REGISTERED device that
   * actually belongs to THIS node before its claimed `locationId` is
   * trusted. A device reassigned to a different node (or retired) between
   * pairing and this push must not have its stale registration honored.
   */
  async findDeviceLocationForNode(deviceId: UUID, nodeId: UUID): Promise<UUID | undefined> {
    return withSystemContext(this.pool, async (client) => {
      const res = await client.query<{ location_id: UUID }>(
        `SELECT location_id FROM devices WHERE id = $1 AND node_id = $2 AND status <> 'retired'`,
        [deviceId, nodeId],
      );
      return res.rows[0]?.location_id;
    });
  }

  async findDeviceById(client: DbClient, id: UUID): Promise<DeviceIdentity | undefined> {
    const res = await client.query<{ id: UUID; location_id: UUID; node_id: UUID | null; status: DeviceRow['status'] }>(
      `SELECT id, location_id, node_id, status FROM devices WHERE id = $1`,
      [id],
    );
    const row = res.rows[0];
    return row && { id: row.id, locationId: row.location_id, nodeId: row.node_id, status: row.status };
  }

  async touchDeviceSync(client: DbClient, deviceId: UUID, outboxDepth: number): Promise<void> {
    await client.query(
      `UPDATE devices SET last_seen_at = NOW(), last_sync_at = NOW(), queue_depth = $2 WHERE id = $1`,
      [deviceId, outboxDepth],
    );
  }

  async allActiveLocationIds(client: DbClient): Promise<UUID[]> {
    const res = await client.query<{ id: UUID }>(`SELECT id FROM locations`);
    return res.rows.map((r) => r.id);
  }

  /** `settings.value` for one key, or `fallback` if the row is missing (fresh install). */
  async getSetting<T>(client: DbClient, key: string, fallback: T): Promise<T> {
    const res = await client.query<{ value: unknown }>(`SELECT value FROM settings WHERE key = $1`, [key]);
    return res.rows[0] ? (res.rows[0].value as T) : fallback;
  }

  async getSettingMoney(client: DbClient, key: string, fallback: Money): Promise<Money> {
    return this.getSetting<Money>(client, key, fallback);
  }
}
