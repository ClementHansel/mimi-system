/**
 * The `sync_events` envelope — SYNC-PROTOCOL §2.1, transcribed as a type. One
 * shape at every tier (IndexedDB object store on device, PG table on node and
 * cloud). Cloud-only bookkeeping columns (`applied_at`, `apply_status`,
 * `batch_id`) are CONTRACTS.md's to define (block 120-129) — they are not
 * protocol surface and are intentionally absent here.
 *
 * **`client_seq` wire encoding — read this before touching any JSON boundary
 * in this protocol.** `SyncEventEnvelope.clientSeq` below is typed `bigint`
 * because it is a `BIGINT` counter (§2.1) that can exceed
 * `Number.MAX_SAFE_INTEGER` well within one device's lifetime. `bigint` is
 * the correct IN-MEMORY/logical type for it — but `JSON.stringify`/`JSON.parse`
 * have no `bigint` support at all (`stringify` throws; there is no bigint
 * literal in the JSON grammar `parse` could produce even if it wanted to).
 * Every tier's actual wire payload therefore carries `client_seq` as a
 * DECIMAL STRING, and each tier (cloud ingest, node relay, device outbox)
 * must convert at its own JSON boundary using `parseClientSeq`/
 * `formatClientSeq` below — never hand-roll `String(seq)`/`BigInt(str)` at a
 * new call site, and never let a raw `bigint` reach `JSON.stringify` (see
 * `../cursor.ts`'s `estimateEventBytes` and `../checksum.ts`'s
 * `canonicalRowString` for the two places this bit before these two
 * functions existed).
 */
import type { ISODateTime, Money, SyncEntity, SyncOriginType, UUID } from '@mimi/shared';

/**
 * Parses `client_seq` off the wire (a decimal string in every JSON payload —
 * see the file header). Throws on anything that isn't a non-negative integer
 * string, rather than returning `NaN`-shaped nonsense that would silently
 * corrupt ordering.
 */
export function parseClientSeq(wireValue: string): bigint {
  if (!/^\d+$/.test(wireValue)) {
    throw new RangeError(`client_seq must be a non-negative integer string, got ${JSON.stringify(wireValue)}`);
  }
  return BigInt(wireValue);
}

/** Formats an in-memory `client_seq` back to its wire decimal-string form. */
export function formatClientSeq(seq: bigint): string {
  if (seq < 0n) throw new RangeError(`client_seq must be non-negative, got ${seq}`);
  return seq.toString();
}

/** §2.3 — the versioned payload envelope every event carries. */
export interface SyncPayloadMeta {
  /** Required on every event. */
  actorUserId: UUID;
  /** Role at the time of action; informative — cloud re-checks. */
  actorRole: string;
  appVersion: string;
  deviceLabel?: string;
  /** Last measured offset vs. upstream at stamping time (§6.2). */
  clockOffsetMs?: number;
  /** Uncorrected wall clock at capture (§6.2). */
  rawDeviceTime?: ISODateTime;
  /** Present iff this event records an offline-provisional approval (§7.3). */
  authorization?: OfflineAuthorizationMeta;
}

/** §7.3 — carried in `meta.authorization` on an `<entity>.approved_offline` event. */
export interface OfflineAuthorizationMeta {
  credentialId: UUID;
  approverUserId: UUID;
  /** `HMAC_SHA256(k, event_id ‖ entity ‖ entity_id ‖ op ‖ amount_idr ‖ occurred_at)`, hex-encoded. */
  binding: string;
  pinAttemptsBeforeSuccess: number;
  selfieRef?: { sha256: string; size: number; mime: string };
  amountIdr?: Money;
}

export interface SyncPayload<TData = unknown> {
  /** Schema version, scoped per `(entity, op)` pair, starting at 1 (§2.3). */
  v: number;
  data: TData;
  meta: SyncPayloadMeta;
}

/** §2.1 — the wire/storage shape of one `sync_events` row. */
export interface SyncEventEnvelope<TData = unknown> {
  /** UUIDv7. The idempotency key — minted once, before first transmission (§2.2). */
  eventId: UUID;
  originTier: SyncOriginType;
  originDeviceId: UUID;
  /** `null` = global (class-M events visible to all subscribers). */
  locationId: UUID | null;
  /** Exact table name from BUILD-PLAN §4.1 (= `SyncEntity`). */
  entity: SyncEntity | string;
  entityId: UUID;
  /** Past-tense fact verb from the per-entity vocabulary (`./authority-matrix`). */
  op: string;
  payload: SyncPayload<TData>;
  /**
   * Gapless, monotonic per origin (§2.1, §6.1). `bigint` in memory; a
   * DECIMAL STRING on the wire — see this file's header note and
   * `parseClientSeq`/`formatClientSeq`. Never `JSON.stringify` an envelope
   * carrying a live `bigint` here without converting first.
   */
  clientSeq: bigint;
  /** Device wall clock, offset-corrected (§6.2). Advisory — never ordering. */
  occurredAt: ISODateTime;
  /** Stamped by the tier that owns this copy of the row when durably stored; not carried on the wire. */
  receivedAt?: ISODateTime;
  /** Stamped by the FIRST upstream that durably stored the event (§2.1); carried on the wire once set. */
  relayReceivedAt?: ISODateTime | null;
  relayedViaNodeId?: UUID | null;
  actorUserId: UUID;
  /** Copy of `payload.v`, for cheap filtering. */
  schemaV: number;
}

/** §4.2 handshake request. */
export interface SyncHelloRequest {
  protocolV: number;
  subscriberId: UUID;
  subscriberTier: 'device' | 'node';
  locationIds: UUID[];
  pullCursor: number;
  outboxDepth: number;
  appVersion: string;
  deviceTime: ISODateTime;
}

/** §4.2 handshake reply — the scope filter is computed by the upstream, never trusted from the client. */
export interface SyncScope {
  globalMaster: boolean;
  locationIds: UUID[];
  assigned?: Record<string, UUID>;
  projectionRole: 'pos_device' | 'driver_device' | 'employee_device' | 'node';
  excludeOrigin: UUID;
}

export interface SyncHelloAck {
  ok: true;
  protocolV: number;
  serverTime: ISODateTime;
  resumeCursor: number;
  confirmedThrough: Record<UUID, number>;
  scope: SyncScope;
  /**
   * §4.5 (pull retention): set when the subscriber's cursor has fallen
   * further behind than this upstream's retention window (device 14 days,
   * node 90 days) or its cursor memory — the resume position it just
   * received is no longer valid. The subscriber MUST re-`POST /sync/v1/
   * bootstrap` (§4.6) instead of resuming incremental pull from
   * `resumeCursor`. Absent (not merely `false`) in the ordinary case — this
   * flag exists to be checked for presence, not for its (always-`true`)
   * value.
   */
  cursorExpired?: true;
}

/** §4.3 push batch — ≤ 200 events AND ≤ 1MB serialized, in client_seq order per origin. */
export interface SyncPushBatch {
  batchId: UUID;
  sentAt: ISODateTime;
  events: SyncEventEnvelope[];
}

export interface SyncPushAck {
  batchId: UUID;
  acceptedThrough: Record<UUID, number>;
  confirmedThrough: Record<UUID, number>;
  rejected: { eventId: UUID; code: string; detail: string }[];
  resendFrom?: Record<UUID, number>;
}

/** §4.5 pull page. */
export interface SyncPullResult {
  events: SyncEventEnvelope[];
  nextCursor: number;
  hasMore: boolean;
}

/**
 * §4.5 — pushed proactively over the socket once a subscriber is caught up
 * (i.e. after its last `sync:pull:result` had `hasMore: false`), as matching
 * events arrive. Same event shape as a pull page; no `hasMore` because this
 * is a live feed, not a paginated catch-up walk.
 */
export interface SyncDeliverMessage {
  events: SyncEventEnvelope[];
  nextCursor: number;
}

/**
 * §4.1/§4.8 — the health check every upstream candidate is probed with
 * before the sync channel connects to it (§1.3), over both the socket
 * namespace and the `GET /sync/v1/health` HTTP fallback.
 */
export interface SyncHealthResponse {
  ok: boolean;
  protocolV: number;
  serverTime: ISODateTime;
  tier: 'cloud' | 'node';
}

/**
 * §4.6 — sent once per snapshot by a new/wiped device, a subscriber told
 * `cursorExpired` in a `hello:ack`, or a node's first pairing. `scope` is the
 * same `SyncScope` shape `hello:ack` computes — the upstream recomputes it
 * from its registry here too, never trusting a client-supplied scope.
 */
export interface SyncBootstrapRequest {
  scope: SyncScope;
}

/**
 * §4.6 — one chunked page of a bootstrap snapshot. Pages are deterministic
 * per `(snapshotId, page)` so an interrupted bootstrap resumes rather than
 * restarting; `startingCursor` is the upstream's server sequence at snapshot
 * start and becomes the downstream's pull cursor once every page has landed.
 *
 * RESOLVED (was flagged ambiguous; W0-B settled it in §4.6): a page is
 * `SyncEventEnvelope[]`, mixing two kinds of rows —
 *  1. **Verbatim real events**, replayed exactly as they were originally
 *     applied (real `eventId`, real `clientSeq`, subject to the same
 *     dedupe/apply rules as any pulled event); and
 *  2. **Synthetic state-carrying events** for master data and open
 *     documents — a freshly-minted `eventId` per row, existing solely as
 *     projection food for this snapshot. These are never logged, never
 *     deduped against, and never themselves re-pushed; they let the
 *     snapshot reuse the one projector every tier already has instead of
 *     inventing a second, pre-projected row format that would have to stay
 *     in permanent agreement with it.
 */
export interface SyncBootstrapPage {
  snapshotId: string;
  page: number;
  hasMore: boolean;
  /** The upstream's server sequence at snapshot start (§4.6) — set the local pull cursor to this once the whole snapshot is loaded, not per-page. */
  startingCursor: number;
  events: SyncEventEnvelope[];
}

/**
 * §4.6 — class-T telemetry (loss-tolerant, NOT a sync event: no outbox, no
 * dedupe, no `eventId`/`clientSeq`). Sent every 30 s (node) / 60 s (device,
 * while awake). A node aggregates its devices' latest heartbeats into its
 * own cloud heartbeat so F12 sees LAN devices even when only the node has
 * WAN — that aggregation is carried in `deviceSummaries`, present on a
 * node's heartbeat only.
 *
 * Field names and set are taken field-for-field from the SHIPPED artifact —
 * W2-E's device runtime (`apps/frontend/src/lib/local/transport/types.ts`,
 * `sync-engine.ts`) and CONTRACTS.md §7.2's `DeviceHeartbeat` — not from
 * SYNC-PROTOCOL's original §4.6 prose, which had independently drifted from
 * both (`ts`/`outboxDepth`/`battery` here vs. `at`/`queueDepth`/`batteryPct`
 * shipped) and was missing `deviceId`/`lastSyncAt`/`networkType`/
 * `activeUserId`/`shiftOpen` entirely. This type is deliberately
 * field-set-identical to that artifact — a narrower type here would just
 * invite the next silent divergence.
 *
 * Do NOT rename this message's `queueDepth` to match `sync:hello`'s
 * `outboxDepth` (or vice versa) for symmetry: they are two different
 * messages, each already locked to its own shipped field name, and the
 * asymmetry between them is deliberate (W0-B).
 */
export interface SyncHeartbeatMessage {
  /** The device/node's own registry id — present on every heartbeat, not only a node's `deviceSummaries` entries. */
  deviceId: UUID;
  at: ISODateTime;
  queueDepth: number;
  quarantineDepth: number;
  pullLag: number;
  lastSyncAt: ISODateTime | null;
  storage: { usedMb: number; quotaMb: number };
  clockOffsetMs: number;
  appVersion: string;
  batteryPct?: number;
  networkType?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  /** Who is logged in on this device right now (POS attribution); `null` = no active session. */
  activeUserId?: UUID | null;
  /** POS devices only: whether a shift is currently open. */
  shiftOpen?: boolean;
  /** Node-only: its LAN devices' latest heartbeats, aggregated into this one cloud-facing heartbeat. */
  deviceSummaries?: { deviceId: UUID; lastSeenAt: ISODateTime; queueDepth: number }[];
}

/** §4.6 — piggybacked ack for `sync:heartbeat`; not a per-event ack (heartbeats aren't sync events). */
export interface SyncHeartbeatAck {
  confirmedThrough: Record<UUID, number>;
  serverTime: ISODateTime;
}

/**
 * §5.5 R2 — the tier-checksum probe, sent once per day-close by every
 * device/node over the same telemetry channel as `sync:heartbeat` (class T:
 * loss-tolerant, no outbox, no dedupe). `areaHashes` maps a storage-area id
 * to that area's checksum of derived balances at `asOfCursor` (see
 * `../checksum.ts`'s `computeAreaBalanceChecksums`, which returns exactly
 * this `Record<string, string>` shape) — the cloud recomputes its own
 * balances at the SAME cursor horizon and compares, so a divergence can only
 * mean the projector or the fact stream disagrees, never clock skew.
 */
export interface SyncChecksumMessage {
  locationId: UUID;
  /** The origin's last-applied cursor — the fact horizon this checksum was computed at (§5.5 R2). */
  asOfCursor: number;
  areaHashes: Record<string, string>;
}
