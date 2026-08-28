/**
 * The node's local store — SYNC-PROTOCOL §1.1 Tier-2 column: "full event log
 * for its location (90-day window) + global master data, relay outbox of
 * device events not yet cloud-confirmed, local projections for LAN fan-out,
 * per-device cursors." This file is the interface only; `memory-store.ts`
 * (SIMULATE + test default) and `pg-store.ts` (production, embedded
 * Postgres) both implement it identically so `relay.ts`/`projector.ts` never
 * know which backend they're talking to.
 */
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ProjectedBalance, StockKey, MovementFact } from '@mimi/sync-protocol';
import type { UUID, ISODateTime, Qty } from '@mimi/shared';

/** A node event row: the wire envelope plus the node-local stamp SYNC-PROTOCOL §2.1 assigns. */
export interface StoredSyncEvent extends SyncEventEnvelope {
  /** This node's own gapless arrival order (BIGSERIAL equivalent) — the domain of LAN pull cursors this node serves (§4.5). */
  serverSeq: number;
  /** Stamped by THIS node if it is the first non-origin tier to see the event (§2.1); passed through unchanged if already set upstream (never true for node-origin-received device events, since the node IS the first non-origin tier). */
  relayReceivedAt: ISODateTime;
}

/** Node's persisted self-identity, set at `/api/nodes/register` and updated on `cert_rotated`/`config_updated` pulls. */
export interface NodeIdentity {
  nodeId: UUID | null;
  nodeToken: string | null;
  locationId: UUID | null;
  locationCode: string | null;
  locationName: string | null;
  lanCert: LanCert | null;
  /** W3-10: this node's own network-config apply-then-confirm state — see `network/applier.ts`'s doc comment for why the revert decision lives here (locally) rather than on the cloud. */
  networkState: NodeNetworkState;
}

/** The subset of a node's "network settings" this build can genuinely apply in-process, with no
 *  host-level network-management privileges (WiFi SSID/passphrase and static-IP assignment are
 *  OS-level concerns this Node.js process has no dependency/capability for — see
 *  `network/applier.ts`'s doc comment; they are accepted and stored cloud-side but reported back
 *  `applied: false, reason: 'unsupported...'` rather than silently no-opped). */
export interface AppliableNetworkConfig {
  /** This node's own LAN listener port (`LanServer`/`config.healthPort`). */
  healthPort: number;
  /** Discovery scan subnet (`config.scanSubnet`); `null` = auto-derive from local interfaces. */
  scanSubnet: string | null;
}

export interface NodeNetworkState {
  /** What this node is actually running with right now. */
  effective: AppliableNetworkConfig;
  /** The last config CONFIRMED reachable — the revert target. Only promoted from `effective` once
   *  an apply is confirmed; an apply that never confirms leaves this untouched. */
  lastKnownGood: AppliableNetworkConfig;
  status: 'stable' | 'applying' | 'reverted';
  /** Correlates with the cloud's `config_updated` push while an apply is in flight; `null` once acked. */
  pendingConfigId: UUID | null;
}

/**
 * The "nothing persisted yet" sentinel (`healthPort: 0`, never a valid real port) — a fresh store
 * that has never gone through `RelayEngine`'s boot reconciliation (`resolveBootNetworkState`) reports
 * this rather than a plausible-looking but made-up port/subnet, so the boot logic can tell "never set"
 * apart from "genuinely applied port happens to look like a default" without a separate nullable field.
 */
export function emptyNetworkState(): NodeNetworkState {
  return {
    effective: { healthPort: 0, scanSubnet: null },
    lastKnownGood: { healthPort: 0, scanSubnet: null },
    status: 'stable',
    pendingConfigId: null,
  };
}

export interface LanCert {
  dnsName: string;
  pem: string;
  keyPem: string;
  expiresAt: ISODateTime;
}

/** The node's cache of the LAN devices it serves — lets it validate a device push while the cloud is unreachable (SYNC-PROTOCOL §4.1). */
export interface LanDeviceRecord {
  deviceId: UUID;
  locationId: UUID;
  deviceTokenHash: string;
  category: string;
  name: string;
  lastSeenAt: ISODateTime | null;
  queueDepth: number;
  revoked: boolean;
}

/** One `discovered_devices` row (CONTRACTS block 115) — this node's LAN scan results. */
export interface DiscoveredDeviceRecord {
  id: UUID;
  source: 'mdns' | 'ssdp' | 'tcp_probe';
  ipAddress: string;
  macAddress: string | null;
  vendor: string | null;
  model: string | null;
  suggestedCategory: string | null;
  suggestedName: string | null;
  status: 'new' | 'confirmed' | 'ignored' | 'disappeared';
  firstSeenAt: ISODateTime;
  lastSeenAt: ISODateTime;
  raw: Record<string, unknown>;
}

export interface EventPage {
  events: StoredSyncEvent[];
  nextCursor: number;
  hasMore: boolean;
}

export interface ProjectionRow {
  entityId: UUID;
  locationId: UUID | null;
  payload: unknown;
  updatedAt: ISODateTime;
}

export interface Store {
  // ── identity ────────────────────────────────────────────────────────────
  getIdentity(): Promise<NodeIdentity>;
  saveIdentity(identity: NodeIdentity): Promise<void>;

  // ── node's local event log (relay outbox + LAN-serving copy) ───────────
  /** Idempotent: a repeat `eventId` is a no-op (already durable). Assigns `serverSeq` on first insert. */
  appendEvent(event: Omit<StoredSyncEvent, 'serverSeq'>): Promise<StoredSyncEvent>;
  hasEvent(eventId: UUID): Promise<boolean>;
  /** For seq-conflict detection (SYNC-PROTOCOL §2.2 rule 4): the eventId already durably stored at this origin+seq, if any. */
  eventIdAtOriginSeq(originDeviceId: UUID, clientSeq: bigint): Promise<UUID | undefined>;
  /** This node's own gapless "accepted" high-water per origin — everything this node durably has, contiguous from 1 (§4.4 apply order; the `accepted_through` this node reports to ITS downstreams). */
  getHighWater(originDeviceId: UUID): Promise<bigint>;
  setHighWater(originDeviceId: UUID, seq: bigint): Promise<void>;
  /** What the CLOUD has confirmed for one origin, as far as this node knows (learned from the cloud's push acks) — the `confirmed_through` this node relays onward, and the boundary of its own relay outbox. */
  getCloudConfirmedHighWater(originDeviceId: UUID): Promise<bigint>;
  setCloudConfirmedHighWater(originDeviceId: UUID, seq: bigint): Promise<void>;
  /** LAN pull serving: events in this node's own `serverSeq` order (§4.5), for devices. */
  getEventsSince(serverSeqCursor: number, limit: number): Promise<EventPage>;
  /** This node's current max `serverSeq` — the `starting_cursor` a bootstrap snapshot anchors to (§4.6). */
  getMaxServerSeq(): Promise<number>;
  /** The relay outbox: events this node has accepted (`clientSeq` beyond that origin's cloud-confirmed high-water) that the CLOUD has not yet confirmed, oldest-first, across all origins. */
  getUnconfirmedByCloud(limit: number): Promise<StoredSyncEvent[]>;

  // ── cursors (per-subscriber, this node acting as upstream; also this node's own cursor toward cloud) ──
  getCursor(subscriberId: string, stream?: string): Promise<number>;
  setCursor(subscriberId: string, cursor: number, stream?: string): Promise<void>;

  // ── LAN device registry cache (§4.1: node validates device pushes even with cloud down) ──
  upsertLanDevice(device: LanDeviceRecord): Promise<void>;
  getLanDeviceById(deviceId: UUID): Promise<LanDeviceRecord | undefined>;
  getLanDeviceByTokenHash(tokenHash: string): Promise<LanDeviceRecord | undefined>;
  listLanDevices(): Promise<LanDeviceRecord[]>;

  // ── LAN discovery results (D-13; CONTRACTS block 115) ──────────────────
  upsertDiscoveredDevice(
    input: Omit<DiscoveredDeviceRecord, 'id' | 'firstSeenAt' | 'lastSeenAt' | 'status'>,
  ): Promise<DiscoveredDeviceRecord>;
  listDiscoveredDevices(): Promise<DiscoveredDeviceRecord[]>;
  /** Marks every currently-`new`/`confirmed` row NOT in `stillPresentIds` as `disappeared` (one discovery sweep's worth of churn). */
  markMissingAsDisappeared(stillPresentIds: readonly UUID[]): Promise<void>;

  // ── master-data cache (class M pull events applied locally, §1.4) ──────
  upsertMasterData(entity: string, entityId: UUID, payload: unknown): Promise<void>;
  getMasterData(entity: string, entityId: UUID): Promise<unknown | undefined>;
  listMasterData(entity: string): Promise<{ entityId: UUID; payload: unknown }[]>;

  // ── whitelisted F/B fan-out projections (§1.4 table) ────────────────────
  upsertProjection(
    entity: string,
    entityId: UUID,
    locationId: UUID | null,
    payload: unknown,
  ): Promise<void>;
  listProjections(entity: string, locationId?: UUID): Promise<ProjectionRow[]>;

  // ── node-local derived stock (D-16a shared projector output) ────────────
  /** Dedupes by `factId` internally (idempotent replay — T-02). */
  appendMovements(movements: readonly MovementFact[]): Promise<void>;
  getBalance(key: StockKey): Promise<Qty | undefined>;
  listBalances(locationId: UUID): Promise<ProjectedBalance[]>;
  listMovements(locationId: UUID): Promise<MovementFact[]>;

  close(): Promise<void>;
}
