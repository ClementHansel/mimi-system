/**
 * In-memory `Store` implementation. This IS the SIMULATE-mode backing store
 * (BUILD-PLAN W2-F: "SIMULATE=true hardware-free mode ... genuinely
 * representative") and the default for every unit/integration test — no
 * Postgres required to exercise the full pairing/heartbeat/discovery/relay
 * lifecycle. `pg-store.ts` implements the identical interface for a real
 * on-prem deployment.
 */
import {
  stockKeyOf,
  type MovementFact,
  type ProjectedBalance,
  type StockKey,
} from '@mimi/sync-protocol';
import {
  addFixed,
  formatFixed,
  parseFixed,
  QTY_SCALE,
  type ISODateTime,
  type Qty,
  type UUID,
} from '@mimi/shared';
import type {
  DiscoveredDeviceRecord,
  EventPage,
  LanDeviceRecord,
  NodeIdentity,
  ProjectionRow,
  Store,
  StoredSyncEvent,
} from './types';

let discoveredIdSeq = 0;

export class MemoryStore implements Store {
  private identity: NodeIdentity = {
    nodeId: null,
    nodeToken: null,
    locationId: null,
    locationCode: null,
    locationName: null,
    lanCert: null,
  };

  private events: StoredSyncEvent[] = [];
  private eventsById = new Map<UUID, StoredSyncEvent>();
  private highWater = new Map<UUID, bigint>();
  private cloudConfirmedHighWater = new Map<UUID, bigint>();
  private eventIdAtSeq = new Map<string, UUID>(); // `${originId}:${seq}` -> eventId
  private nextServerSeq = 1;

  private cursors = new Map<string, number>(); // `${subscriberId}::${stream}` -> cursor

  private lanDevices = new Map<UUID, LanDeviceRecord>();
  private lanDevicesByTokenHash = new Map<string, UUID>();

  private discovered = new Map<UUID, DiscoveredDeviceRecord>();
  private discoveredByKey = new Map<string, UUID>(); // `${ip}:${mac}` -> id

  private masterData = new Map<string, Map<UUID, unknown>>(); // entity -> entityId -> payload
  private projections = new Map<string, Map<UUID, ProjectionRow>>(); // entity -> entityId -> row

  private movementsByFactId = new Map<string, MovementFact>();

  // ── identity ──────────────────────────────────────────────────────────
  async getIdentity(): Promise<NodeIdentity> {
    return { ...this.identity };
  }

  async saveIdentity(identity: NodeIdentity): Promise<void> {
    this.identity = { ...identity };
  }

  // ── event log ─────────────────────────────────────────────────────────
  async appendEvent(event: Omit<StoredSyncEvent, 'serverSeq'>): Promise<StoredSyncEvent> {
    const existing = this.eventsById.get(event.eventId);
    if (existing) return existing;

    const stored: StoredSyncEvent = { ...event, serverSeq: this.nextServerSeq++ };
    this.events.push(stored);
    this.eventsById.set(stored.eventId, stored);
    this.eventIdAtSeq.set(
      `${stored.originDeviceId}:${stored.clientSeq.toString()}`,
      stored.eventId,
    );
    return stored;
  }

  async hasEvent(eventId: UUID): Promise<boolean> {
    return this.eventsById.has(eventId);
  }

  async eventIdAtOriginSeq(originDeviceId: UUID, clientSeq: bigint): Promise<UUID | undefined> {
    return this.eventIdAtSeq.get(`${originDeviceId}:${clientSeq.toString()}`);
  }

  async getHighWater(originDeviceId: UUID): Promise<bigint> {
    return this.highWater.get(originDeviceId) ?? 0n;
  }

  async setHighWater(originDeviceId: UUID, seq: bigint): Promise<void> {
    this.highWater.set(originDeviceId, seq);
  }

  async getCloudConfirmedHighWater(originDeviceId: UUID): Promise<bigint> {
    return this.cloudConfirmedHighWater.get(originDeviceId) ?? 0n;
  }

  async setCloudConfirmedHighWater(originDeviceId: UUID, seq: bigint): Promise<void> {
    const current = this.cloudConfirmedHighWater.get(originDeviceId) ?? 0n;
    if (seq > current) this.cloudConfirmedHighWater.set(originDeviceId, seq);
  }

  async getEventsSince(serverSeqCursor: number, limit: number): Promise<EventPage> {
    const rest = this.events.filter((e) => e.serverSeq > serverSeqCursor);
    const page = rest.slice(0, limit);
    const nextCursor = page.length > 0 ? page[page.length - 1]!.serverSeq : serverSeqCursor;
    return { events: page, nextCursor, hasMore: rest.length > page.length };
  }

  async getMaxServerSeq(): Promise<number> {
    return this.events.length > 0 ? this.events[this.events.length - 1]!.serverSeq : 0;
  }

  async getUnconfirmedByCloud(limit: number): Promise<StoredSyncEvent[]> {
    const result: StoredSyncEvent[] = [];
    for (const e of this.events) {
      const confirmedThrough = this.cloudConfirmedHighWater.get(e.originDeviceId) ?? 0n;
      if (e.clientSeq > confirmedThrough) result.push(e);
      if (result.length >= limit) break;
    }
    return result;
  }

  // ── cursors ───────────────────────────────────────────────────────────
  async getCursor(subscriberId: string, stream = 'main'): Promise<number> {
    return this.cursors.get(`${subscriberId}::${stream}`) ?? 0;
  }

  async setCursor(subscriberId: string, cursor: number, stream = 'main'): Promise<void> {
    this.cursors.set(`${subscriberId}::${stream}`, cursor);
  }

  // ── LAN device cache ──────────────────────────────────────────────────
  async upsertLanDevice(device: LanDeviceRecord): Promise<void> {
    const previous = this.lanDevices.get(device.deviceId);
    if (previous) this.lanDevicesByTokenHash.delete(previous.deviceTokenHash);
    this.lanDevices.set(device.deviceId, { ...device });
    this.lanDevicesByTokenHash.set(device.deviceTokenHash, device.deviceId);
  }

  async getLanDeviceById(deviceId: UUID): Promise<LanDeviceRecord | undefined> {
    const d = this.lanDevices.get(deviceId);
    return d ? { ...d } : undefined;
  }

  async getLanDeviceByTokenHash(tokenHash: string): Promise<LanDeviceRecord | undefined> {
    const id = this.lanDevicesByTokenHash.get(tokenHash);
    return id ? this.getLanDeviceById(id) : undefined;
  }

  async listLanDevices(): Promise<LanDeviceRecord[]> {
    return [...this.lanDevices.values()].map((d) => ({ ...d }));
  }

  // ── discovery ─────────────────────────────────────────────────────────
  async upsertDiscoveredDevice(
    input: Omit<DiscoveredDeviceRecord, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'status'>,
  ): Promise<DiscoveredDeviceRecord> {
    const key = `${input.ipAddress}:${input.macAddress ?? ''}`;
    const now = new Date().toISOString() as ISODateTime;
    const existingId = this.discoveredByKey.get(key);
    if (existingId) {
      const existing = this.discovered.get(existingId)!;
      const updated: DiscoveredDeviceRecord = {
        ...existing,
        ...input,
        lastSeenAt: now,
        status: existing.status === 'disappeared' ? 'new' : existing.status,
      };
      this.discovered.set(existingId, updated);
      return { ...updated };
    }
    const id = `disc-${++discoveredIdSeq}` as UUID;
    const created: DiscoveredDeviceRecord = {
      ...input,
      id,
      firstSeenAt: now,
      lastSeenAt: now,
      status: 'new',
    };
    this.discovered.set(id, created);
    this.discoveredByKey.set(key, id);
    return { ...created };
  }

  async listDiscoveredDevices(): Promise<DiscoveredDeviceRecord[]> {
    return [...this.discovered.values()].map((d) => ({ ...d }));
  }

  async markMissingAsDisappeared(stillPresentIds: readonly UUID[]): Promise<void> {
    const present = new Set(stillPresentIds);
    for (const [id, record] of this.discovered) {
      if (record.status !== 'ignored' && record.status !== 'disappeared' && !present.has(id)) {
        this.discovered.set(id, { ...record, status: 'disappeared' });
      }
    }
  }

  // ── master data cache ────────────────────────────────────────────────
  async upsertMasterData(entity: string, entityId: UUID, payload: unknown): Promise<void> {
    let byId = this.masterData.get(entity);
    if (!byId) {
      byId = new Map();
      this.masterData.set(entity, byId);
    }
    byId.set(entityId, payload);
  }

  async getMasterData(entity: string, entityId: UUID): Promise<unknown | undefined> {
    return this.masterData.get(entity)?.get(entityId);
  }

  async listMasterData(entity: string): Promise<{ entityId: UUID; payload: unknown }[]> {
    const byId = this.masterData.get(entity);
    if (!byId) return [];
    return [...byId.entries()].map(([entityId, payload]) => ({ entityId, payload }));
  }

  // ── whitelisted fan-out projections ──────────────────────────────────
  async upsertProjection(
    entity: string,
    entityId: UUID,
    locationId: UUID | null,
    payload: unknown,
  ): Promise<void> {
    let byId = this.projections.get(entity);
    if (!byId) {
      byId = new Map();
      this.projections.set(entity, byId);
    }
    byId.set(entityId, {
      entityId,
      locationId,
      payload,
      updatedAt: new Date().toISOString() as ISODateTime,
    });
  }

  async listProjections(entity: string, locationId?: UUID): Promise<ProjectionRow[]> {
    const byId = this.projections.get(entity);
    if (!byId) return [];
    const rows = [...byId.values()];
    return locationId ? rows.filter((r) => r.locationId === locationId) : rows;
  }

  // ── stock projection (D-16a) ────────────────────────────────────────
  async appendMovements(movements: readonly MovementFact[]): Promise<void> {
    for (const m of movements) {
      if (!this.movementsByFactId.has(m.factId)) this.movementsByFactId.set(m.factId, m);
    }
  }

  async getBalance(key: StockKey): Promise<Qty | undefined> {
    const targetKey = stockKeyOf(key);
    let total = 0n;
    let any = false;
    for (const m of this.movementsByFactId.values()) {
      if (stockKeyOf(m) !== targetKey) continue;
      any = true;
      const sign = m.movementType.endsWith('_out') ? -1n : 1n;
      total = addFixed(total, parseFixed(m.qty, QTY_SCALE) * sign);
    }
    return any ? formatFixed(total, QTY_SCALE) : undefined;
  }

  async listBalances(locationId: UUID): Promise<ProjectedBalance[]> {
    const totals = new Map<string, { key: StockKey; total: bigint }>();
    for (const m of this.movementsByFactId.values()) {
      if (m.locationId !== locationId) continue;
      const k = stockKeyOf(m);
      const sign = m.movementType.endsWith('_out') ? -1n : 1n;
      const signed = parseFixed(m.qty, QTY_SCALE) * sign;
      const prev = totals.get(k);
      if (prev) prev.total = addFixed(prev.total, signed);
      else
        totals.set(k, {
          key: { locationId: m.locationId, storageAreaId: m.storageAreaId, itemId: m.itemId },
          total: signed,
        });
    }
    return [...totals.values()].map(({ key, total }) => ({
      ...key,
      qtyOnHand: formatFixed(total, QTY_SCALE),
    }));
  }

  async listMovements(locationId: UUID): Promise<MovementFact[]> {
    return [...this.movementsByFactId.values()].filter((m) => m.locationId === locationId);
  }

  async close(): Promise<void> {
    // nothing to release
  }
}
