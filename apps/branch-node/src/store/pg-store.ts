/**
 * Postgres-backed `Store` — the "embedded Postgres 16 on the outlet LAN"
 * half of SYNC-PROTOCOL §1.1's Tier-2 row. Same interface as
 * `memory-store.ts`; `relay.ts`/`projector.ts` are written against `Store`
 * and never know which backend is live. Bootstraps its own schema via
 * `./migrate` on connect, so a fresh mini-PC install just needs a reachable
 * Postgres and `BRANCH_NODE_DATABASE_URL` — no manual migration step.
 */
import pg from 'pg';
import type { MovementFact, ProjectedBalance, StockKey } from '@mimi/sync-protocol';
import type { ISODateTime, Qty, UUID } from '@mimi/shared';
import { runMigrations } from './migrate';
import {
  emptyNetworkState,
  type DiscoveredDeviceRecord,
  type EventPage,
  type LanDeviceRecord,
  type NodeIdentity,
  type NodeNetworkState,
  type ProjectionRow,
  type Store,
  type StoredSyncEvent,
} from './types';

function parseNetworkState(raw: unknown): NodeNetworkState {
  if (!raw || typeof raw !== 'object' || Object.keys(raw).length === 0) return emptyNetworkState();
  return raw as NodeNetworkState;
}

function toIso(v: unknown): ISODateTime {
  return v instanceof Date ? (v.toISOString() as ISODateTime) : (v as ISODateTime);
}

function mapEventRow(row: Record<string, unknown>): StoredSyncEvent {
  return {
    eventId: row.event_id as UUID,
    serverSeq: Number(row.server_seq),
    originTier: row.origin_tier as StoredSyncEvent['originTier'],
    originDeviceId: row.origin_device_id as UUID,
    locationId: (row.location_id as UUID | null) ?? null,
    entity: row.entity as StoredSyncEvent['entity'],
    entityId: row.entity_id as UUID,
    op: row.op as string,
    payload: row.payload as StoredSyncEvent['payload'],
    clientSeq: BigInt(row.client_seq as string | number),
    occurredAt: toIso(row.occurred_at),
    receivedAt: toIso(row.received_at),
    relayReceivedAt: toIso(row.relay_received_at),
    actorUserId: row.actor_user_id as UUID,
    schemaV: Number(row.schema_v),
  };
}

export class PgStore implements Store {
  private pool: pg.Pool;
  private ready: Promise<void>;

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString });
    this.ready = this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await runMigrations(client);
    } finally {
      client.release();
    }
  }

  private async q<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    await this.ready;
    return this.pool.query<T>(text, params);
  }

  // ── identity ──────────────────────────────────────────────────────────
  async getIdentity(): Promise<NodeIdentity> {
    const { rows } = await this.q('SELECT * FROM node_identity WHERE singleton = TRUE');
    const row = rows[0];
    if (!row) {
      return {
        nodeId: null,
        nodeToken: null,
        locationId: null,
        locationCode: null,
        locationName: null,
        lanCert: null,
        networkState: emptyNetworkState(),
      };
    }
    return {
      nodeId: (row.node_id as UUID) ?? null,
      nodeToken: (row.node_token as string) ?? null,
      locationId: (row.location_id as UUID) ?? null,
      locationCode: (row.location_code as string) ?? null,
      locationName: (row.location_name as string) ?? null,
      lanCert: row.lan_cert_dns_name
        ? {
            dnsName: row.lan_cert_dns_name as string,
            pem: row.lan_cert_pem as string,
            keyPem: row.lan_cert_key_pem as string,
            expiresAt: toIso(row.lan_cert_expires_at),
          }
        : null,
      networkState: parseNetworkState(row.network_state),
    };
  }

  async saveIdentity(identity: NodeIdentity): Promise<void> {
    await this.q(
      `INSERT INTO node_identity (singleton, node_id, node_token, location_id, location_code, location_name,
                                   lan_cert_dns_name, lan_cert_pem, lan_cert_key_pem, lan_cert_expires_at,
                                   network_state, updated_at)
       VALUES (TRUE, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
       ON CONFLICT (singleton) DO UPDATE SET
         node_id = EXCLUDED.node_id, node_token = EXCLUDED.node_token, location_id = EXCLUDED.location_id,
         location_code = EXCLUDED.location_code, location_name = EXCLUDED.location_name,
         lan_cert_dns_name = EXCLUDED.lan_cert_dns_name, lan_cert_pem = EXCLUDED.lan_cert_pem,
         lan_cert_key_pem = EXCLUDED.lan_cert_key_pem, lan_cert_expires_at = EXCLUDED.lan_cert_expires_at,
         network_state = EXCLUDED.network_state, updated_at = NOW()`,
      [
        identity.nodeId,
        identity.nodeToken,
        identity.locationId,
        identity.locationCode,
        identity.locationName,
        identity.lanCert?.dnsName ?? null,
        identity.lanCert?.pem ?? null,
        identity.lanCert?.keyPem ?? null,
        identity.lanCert?.expiresAt ?? null,
        JSON.stringify(identity.networkState ?? emptyNetworkState()),
      ],
    );
  }

  // ── event log ─────────────────────────────────────────────────────────
  async appendEvent(event: Omit<StoredSyncEvent, 'serverSeq'>): Promise<StoredSyncEvent> {
    const { rows } = await this.q(
      `INSERT INTO sync_events (event_id, origin_tier, origin_device_id, location_id, entity, entity_id, op,
                                 payload, client_seq, occurred_at, relay_received_at, actor_user_id, schema_v)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
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
        event.relayReceivedAt,
        event.actorUserId,
        event.schemaV,
      ],
    );
    if (rows[0]) return mapEventRow(rows[0]);
    const existing = await this.q('SELECT * FROM sync_events WHERE event_id = $1', [event.eventId]);
    return mapEventRow(existing.rows[0]!);
  }

  async hasEvent(eventId: UUID): Promise<boolean> {
    const { rows } = await this.q('SELECT 1 FROM sync_events WHERE event_id = $1', [eventId]);
    return rows.length > 0;
  }

  async eventIdAtOriginSeq(originDeviceId: UUID, clientSeq: bigint): Promise<UUID | undefined> {
    const { rows } = await this.q<{ event_id: UUID }>(
      'SELECT event_id FROM sync_events WHERE origin_device_id = $1 AND client_seq = $2',
      [originDeviceId, clientSeq.toString()],
    );
    return rows[0]?.event_id;
  }

  async getHighWater(originDeviceId: UUID): Promise<bigint> {
    const { rows } = await this.q<{ high_water: string }>(
      'SELECT high_water FROM origin_high_water WHERE origin_device_id = $1',
      [originDeviceId],
    );
    return rows[0] ? BigInt(rows[0].high_water) : 0n;
  }

  async setHighWater(originDeviceId: UUID, seq: bigint): Promise<void> {
    await this.q(
      `INSERT INTO origin_high_water (origin_device_id, high_water) VALUES ($1, $2)
       ON CONFLICT (origin_device_id) DO UPDATE SET high_water = EXCLUDED.high_water`,
      [originDeviceId, seq.toString()],
    );
  }

  async getCloudConfirmedHighWater(originDeviceId: UUID): Promise<bigint> {
    const { rows } = await this.q<{ high_water: string }>(
      'SELECT high_water FROM cloud_confirmed_high_water WHERE origin_device_id = $1',
      [originDeviceId],
    );
    return rows[0] ? BigInt(rows[0].high_water) : 0n;
  }

  async setCloudConfirmedHighWater(originDeviceId: UUID, seq: bigint): Promise<void> {
    await this.q(
      `INSERT INTO cloud_confirmed_high_water (origin_device_id, high_water) VALUES ($1, $2)
       ON CONFLICT (origin_device_id) DO UPDATE SET
         high_water = GREATEST(cloud_confirmed_high_water.high_water, EXCLUDED.high_water)`,
      [originDeviceId, seq.toString()],
    );
  }

  async getEventsSince(serverSeqCursor: number, limit: number): Promise<EventPage> {
    const { rows } = await this.q(
      'SELECT * FROM sync_events WHERE server_seq > $1 ORDER BY server_seq ASC LIMIT $2',
      [serverSeqCursor, limit + 1],
    );
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const events = page.map(mapEventRow);
    const nextCursor = events.length > 0 ? events[events.length - 1]!.serverSeq : serverSeqCursor;
    return { events, nextCursor, hasMore };
  }

  async getMaxServerSeq(): Promise<number> {
    const { rows } = await this.q<{ max: string | null }>(
      'SELECT MAX(server_seq)::text AS max FROM sync_events',
    );
    return rows[0]?.max ? Number(rows[0].max) : 0;
  }

  async getUnconfirmedByCloud(limit: number): Promise<StoredSyncEvent[]> {
    const { rows } = await this.q(
      `SELECT e.* FROM sync_events e
       LEFT JOIN cloud_confirmed_high_water w ON w.origin_device_id = e.origin_device_id
       WHERE e.client_seq > COALESCE(w.high_water, 0)
       ORDER BY e.server_seq ASC LIMIT $1`,
      [limit],
    );
    return rows.map(mapEventRow);
  }

  // ── cursors ───────────────────────────────────────────────────────────
  async getCursor(subscriberId: string, stream = 'main'): Promise<number> {
    const { rows } = await this.q<{ cursor: string }>(
      'SELECT cursor FROM sync_cursors WHERE subscriber_id = $1 AND stream = $2',
      [subscriberId, stream],
    );
    return rows[0] ? Number(rows[0].cursor) : 0;
  }

  async setCursor(subscriberId: string, cursor: number, stream = 'main'): Promise<void> {
    await this.q(
      `INSERT INTO sync_cursors (subscriber_id, stream, cursor, updated_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (subscriber_id, stream) DO UPDATE SET cursor = EXCLUDED.cursor, updated_at = NOW()`,
      [subscriberId, stream, cursor],
    );
  }

  // ── LAN device cache ──────────────────────────────────────────────────
  async upsertLanDevice(device: LanDeviceRecord): Promise<void> {
    await this.q(
      `INSERT INTO lan_devices (device_id, location_id, device_token_hash, category, name, last_seen_at, queue_depth, revoked)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (device_id) DO UPDATE SET
         location_id = EXCLUDED.location_id, device_token_hash = EXCLUDED.device_token_hash,
         category = EXCLUDED.category, name = EXCLUDED.name, last_seen_at = EXCLUDED.last_seen_at,
         queue_depth = EXCLUDED.queue_depth, revoked = EXCLUDED.revoked`,
      [
        device.deviceId,
        device.locationId,
        device.deviceTokenHash,
        device.category,
        device.name,
        device.lastSeenAt,
        device.queueDepth,
        device.revoked,
      ],
    );
  }

  async getLanDeviceById(deviceId: UUID): Promise<LanDeviceRecord | undefined> {
    const { rows } = await this.q('SELECT * FROM lan_devices WHERE device_id = $1', [deviceId]);
    return rows[0] ? this.mapLanDevice(rows[0]) : undefined;
  }

  async getLanDeviceByTokenHash(tokenHash: string): Promise<LanDeviceRecord | undefined> {
    const { rows } = await this.q('SELECT * FROM lan_devices WHERE device_token_hash = $1', [
      tokenHash,
    ]);
    return rows[0] ? this.mapLanDevice(rows[0]) : undefined;
  }

  async listLanDevices(): Promise<LanDeviceRecord[]> {
    const { rows } = await this.q('SELECT * FROM lan_devices');
    return rows.map((r) => this.mapLanDevice(r));
  }

  private mapLanDevice(row: Record<string, unknown>): LanDeviceRecord {
    return {
      deviceId: row.device_id as UUID,
      locationId: row.location_id as UUID,
      deviceTokenHash: row.device_token_hash as string,
      category: row.category as string,
      name: row.name as string,
      lastSeenAt: row.last_seen_at ? toIso(row.last_seen_at) : null,
      queueDepth: Number(row.queue_depth),
      revoked: Boolean(row.revoked),
    };
  }

  // ── discovery ─────────────────────────────────────────────────────────
  async upsertDiscoveredDevice(
    input: Omit<DiscoveredDeviceRecord, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'status'>,
  ): Promise<DiscoveredDeviceRecord> {
    const { rows } = await this.q(
      `INSERT INTO discovered_devices (source, ip_address, mac_address, vendor, model, suggested_category, suggested_name, raw)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
       ON CONFLICT (ip_address, mac_address) DO UPDATE SET
         source = EXCLUDED.source, vendor = COALESCE(discovered_devices.vendor, EXCLUDED.vendor),
         model = COALESCE(discovered_devices.model, EXCLUDED.model),
         suggested_category = EXCLUDED.suggested_category, suggested_name = EXCLUDED.suggested_name,
         raw = EXCLUDED.raw, last_seen_at = NOW(),
         status = CASE WHEN discovered_devices.status = 'disappeared' THEN 'new' ELSE discovered_devices.status END
       RETURNING *`,
      [
        input.source,
        input.ipAddress,
        input.macAddress,
        input.vendor,
        input.model,
        input.suggestedCategory,
        input.suggestedName,
        JSON.stringify(input.raw),
      ],
    );
    return this.mapDiscovered(rows[0]!);
  }

  async listDiscoveredDevices(): Promise<DiscoveredDeviceRecord[]> {
    const { rows } = await this.q('SELECT * FROM discovered_devices ORDER BY first_seen_at ASC');
    return rows.map((r) => this.mapDiscovered(r));
  }

  async markMissingAsDisappeared(stillPresentIds: readonly UUID[]): Promise<void> {
    await this.q(
      `UPDATE discovered_devices SET status = 'disappeared'
       WHERE status IN ('new', 'confirmed') AND NOT (id = ANY($1::uuid[]))`,
      [stillPresentIds.length > 0 ? stillPresentIds : ['00000000-0000-0000-0000-000000000000']],
    );
  }

  private mapDiscovered(row: Record<string, unknown>): DiscoveredDeviceRecord {
    return {
      id: row.id as UUID,
      source: row.source as DiscoveredDeviceRecord['source'],
      ipAddress: row.ip_address as string,
      macAddress: (row.mac_address as string) ?? null,
      vendor: (row.vendor as string) ?? null,
      model: (row.model as string) ?? null,
      suggestedCategory: (row.suggested_category as string) ?? null,
      suggestedName: (row.suggested_name as string) ?? null,
      status: row.status as DiscoveredDeviceRecord['status'],
      firstSeenAt: toIso(row.first_seen_at),
      lastSeenAt: toIso(row.last_seen_at),
      raw: row.raw as Record<string, unknown>,
    };
  }

  // ── master data cache ────────────────────────────────────────────────
  async upsertMasterData(entity: string, entityId: UUID, payload: unknown): Promise<void> {
    await this.q(
      `INSERT INTO master_data_cache (entity, entity_id, payload, updated_at) VALUES ($1, $2, $3::jsonb, NOW())
       ON CONFLICT (entity, entity_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()`,
      [entity, entityId, JSON.stringify(payload)],
    );
  }

  async getMasterData(entity: string, entityId: UUID): Promise<unknown | undefined> {
    const { rows } = await this.q<{ payload: unknown }>(
      'SELECT payload FROM master_data_cache WHERE entity = $1 AND entity_id = $2',
      [entity, entityId],
    );
    return rows[0]?.payload;
  }

  async listMasterData(entity: string): Promise<{ entityId: UUID; payload: unknown }[]> {
    const { rows } = await this.q<{ entity_id: UUID; payload: unknown }>(
      'SELECT entity_id, payload FROM master_data_cache WHERE entity = $1',
      [entity],
    );
    return rows.map((r) => ({ entityId: r.entity_id, payload: r.payload }));
  }

  // ── whitelisted fan-out projections ──────────────────────────────────
  async upsertProjection(
    entity: string,
    entityId: UUID,
    locationId: UUID | null,
    payload: unknown,
  ): Promise<void> {
    await this.q(
      `INSERT INTO entity_projections (entity, entity_id, location_id, payload, updated_at)
       VALUES ($1, $2, $3, $4::jsonb, NOW())
       ON CONFLICT (entity, entity_id) DO UPDATE SET
         location_id = EXCLUDED.location_id, payload = EXCLUDED.payload, updated_at = NOW()`,
      [entity, entityId, locationId, JSON.stringify(payload)],
    );
  }

  async listProjections(entity: string, locationId?: UUID): Promise<ProjectionRow[]> {
    const { rows } = locationId
      ? await this.q(
          'SELECT entity_id, location_id, payload, updated_at FROM entity_projections WHERE entity = $1 AND location_id = $2',
          [entity, locationId],
        )
      : await this.q(
          'SELECT entity_id, location_id, payload, updated_at FROM entity_projections WHERE entity = $1',
          [entity],
        );
    return rows.map((r) => ({
      entityId: r.entity_id as UUID,
      locationId: (r.location_id as UUID) ?? null,
      payload: r.payload,
      updatedAt: toIso(r.updated_at),
    }));
  }

  // ── stock projection (D-16a) ────────────────────────────────────────
  async appendMovements(movements: readonly MovementFact[]): Promise<void> {
    for (const m of movements) {
      await this.q(
        `INSERT INTO stock_movements (fact_id, location_id, storage_area_id, item_id, movement_type, qty, unit_cost, ref_type, ref_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (fact_id) DO NOTHING`,
        [
          m.factId,
          m.locationId,
          m.storageAreaId,
          m.itemId,
          m.movementType,
          m.qty,
          m.unitCost,
          m.refType,
          m.refId,
          m.occurredAt,
        ],
      );
    }
  }

  async getBalance(key: StockKey): Promise<Qty | undefined> {
    const { rows } = await this.q<{ balance: string | null }>(
      `SELECT SUM(CASE WHEN movement_type LIKE '%\\_out' THEN -qty ELSE qty END)::text AS balance
       FROM stock_movements WHERE location_id = $1 AND storage_area_id = $2 AND item_id = $3`,
      [key.locationId, key.storageAreaId, key.itemId],
    );
    return rows[0]?.balance != null ? (rows[0].balance as Qty) : undefined;
  }

  async listBalances(locationId: UUID): Promise<ProjectedBalance[]> {
    const { rows } = await this.q<{ storage_area_id: UUID; item_id: UUID; balance: string }>(
      `SELECT storage_area_id, item_id, SUM(CASE WHEN movement_type LIKE '%\\_out' THEN -qty ELSE qty END)::text AS balance
       FROM stock_movements WHERE location_id = $1 GROUP BY storage_area_id, item_id`,
      [locationId],
    );
    return rows.map((r) => ({
      locationId,
      storageAreaId: r.storage_area_id,
      itemId: r.item_id,
      qtyOnHand: r.balance as Qty,
    }));
  }

  async listMovements(locationId: UUID): Promise<MovementFact[]> {
    const { rows } = await this.q(
      'SELECT * FROM stock_movements WHERE location_id = $1 ORDER BY occurred_at ASC',
      [locationId],
    );
    return rows.map((r) => ({
      factId: r.fact_id as string,
      locationId: r.location_id as UUID,
      storageAreaId: r.storage_area_id as UUID,
      itemId: r.item_id as UUID,
      movementType: r.movement_type as MovementFact['movementType'],
      qty: r.qty as Qty,
      unitCost: r.unit_cost as MovementFact['unitCost'],
      refType: r.ref_type as string,
      refId: (r.ref_id as UUID) ?? null,
      occurredAt: toIso(r.occurred_at),
    }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}
