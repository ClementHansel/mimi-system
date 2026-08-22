/**
 * Local-only (never-on-the-wire) row shapes for the Tier-1 IndexedDB schema.
 * Wire shapes (the envelope itself, hello/push/pull bodies) come straight
 * from `@mimi/sync-protocol` — this file only adds the device-local
 * bookkeeping wrapped around them.
 */
import type { SyncEventEnvelope } from '@mimi/sync-protocol';
import type { ISODateTime, Money, UUID } from '@mimi/shared';
import type { MovementFact } from '@mimi/sync-protocol';

// ── §2.2 outbox ────────────────────────────────────────────────────────────────

export type OutboxLocalStatus = 'pending' | 'sending' | 'accepted';

/**
 * One outbox row = one `SyncEventEnvelope` plus device-local transport state.
 * `status` tracks only THIS upstream's acknowledgement; the two-level ack
 * (accepted vs confirmed, §4.3) is tracked separately in `PushAckState`
 * because "confirmed" is a property of the (origin, clientSeq) high-water
 * mark, not of an individual row re-derived every read.
 */
export interface OutboxRecord {
  eventId: UUID;
  envelope: SyncEventEnvelope;
  status: OutboxLocalStatus;
  attempt: number;
  lastAttemptAt: ISODateTime | null;
  lastError: string | null;
  createdAt: ISODateTime;
}

export interface QuarantineRecord {
  eventId: UUID;
  envelope: SyncEventEnvelope;
  code: string;
  detail: string;
  quarantinedAt: ISODateTime;
}

/** §4.5 dedupe window for pulled events — 14-day pruned. */
export interface AppliedEventRecord {
  eventId: UUID;
  entity: string;
  appliedAt: ISODateTime;
}

// ── §4.5 cursors (per-upstream, non-transferable) ─────────────────────────────

export type UpstreamKind = 'cloud' | 'node';

export interface CursorRecord {
  upstream: UpstreamKind;
  cursor: number;
  updatedAt: ISODateTime;
}

/**
 * §4.3 two-level ack bookkeeping for THIS device's own origin stream.
 * `acceptedThrough` = durably stored at the CURRENT upstream; `confirmedThrough`
 * = durably stored at the CLOUD (may lag behind `acceptedThrough` when the
 * upstream is a node still relaying). An outbox row prunes only once its
 * `clientSeq <= confirmedThrough`.
 */
export interface PushAckState {
  id: 'self';
  acceptedThrough: string; // bigint-as-string
  confirmedThrough: string; // bigint-as-string
}

// ── §1.5 device identity ───────────────────────────────────────────────────────

export interface DeviceIdentity {
  id: 'self';
  originDeviceId: UUID;
  deviceToken: string | null;
  fingerprint: string;
  locationId: UUID | null;
  locationCode: string | null;
  locationName: string | null;
  /** Learned from cloud at pairing time (SYNC-PROTOCOL §1.3); absent = no node at this location. */
  nodeLanUrl: string | null;
  cloudUrl: string;
  protocolV: number;
  registeredAt: ISODateTime | null;
}

/** The durable per-device client_seq counter (§2.1, §2.2) — gapless, monotonic. */
export interface ClientSeqCounter {
  id: 'self';
  value: string; // bigint-as-string; next assigned seq = value + 1
}

// ── §6 clock discipline ────────────────────────────────────────────────────────

export interface ClockState {
  id: 'self';
  /** EWMA-smoothed offset vs the current upstream's server_time, in ms (device_now + offset = server_time). */
  offsetMs: number;
  /** Raw samples kept for the EWMA window (§6.2: "smoothed EWMA over last 5 samples"). */
  samples: number[];
  lastMeasuredAt: ISODateTime | null;
}

// ── master data cache (class M/F/B pull projections) ──────────────────────────

/**
 * The driver's route for one business day, cached so a hard reload with no
 * signal does not lose the day's work (F13).
 *
 * A SEPARATE store rather than a row in `master_data`: the reconciler wipes
 * `master_data` wholesale (`RECONCILE_STORES`), and a driver halfway through a
 * run in a dead zone is exactly when that must not happen.
 */
export interface DriverJobsRecord {
  /** The WITA business date, `YYYY-MM-DD` — one cached route per day. */
  key: string;
  /** `SuratJalan[]` as returned by `GET /delivery/my-jobs`, stored opaquely: this layer must not need updating every time a delivery field is added. */
  jobs: unknown;
  cachedAt: ISODateTime;
}

export interface MasterDataRecord {
  /** `${entity}:${entityId}` */
  key: string;
  entity: string;
  entityId: UUID;
  op: string;
  data: unknown;
  locationId: UUID | null;
  updatedAt: ISODateTime;
}

// ── conflict hints (local-only, preemptive UX warnings; §5.1) ─────────────────

export interface ConflictHintRecord {
  id: string;
  kind: string;
  entity: string;
  entityId: UUID;
  detail: unknown;
  createdAt: ISODateTime;
}

// ── §7 offline credentials ─────────────────────────────────────────────────────

/** Decoded claims of the signed offline-approval credential (§7.2 shape). */
export interface OfflineCredentialClaims {
  credentialId: UUID;
  sub: UUID;
  role: string;
  locationIds: UUID[];
  scopes: Record<string, { maxIdr?: Money }>;
  iat: ISODateTime;
  exp: ISODateTime;
  /** 32-byte per-issuance binding secret, base64. Never transmitted anywhere except in this cache. */
  k: string;
  pinVerifier: string;
  selfieRequiredAboveIdr: Money;
}

export interface CachedCredentialRecord {
  credentialId: UUID;
  /** Opaque signed token exactly as received from the cloud (never re-derived locally). */
  token: string;
  claims: OfflineCredentialClaims;
  cachedAt: ISODateTime;
}

/** CRL entry — SYNC-PROTOCOL §7.2 revocation, arrives as a pulled `offline_authorizations.revoked` event. */
export interface CredentialRevocationRecord {
  credentialId: UUID;
  revokedAt: ISODateTime;
}

/** §7.3: 5 attempts then hard lockout of that credential ON THIS DEVICE. */
export interface PinAttemptState {
  credentialId: UUID;
  failedAttempts: number;
  /**
   * TERMINAL. Reached at `PIN_MAX_ATTEMPTS`, and not self-clearing — the
   * credential is dead on this device until it is re-issued online (B-17's
   * offline recovery path is not built yet; see docs/PROGRESS.md).
   */
  lockedOut: boolean;
  /**
   * B-17 — the SOFT, self-clearing cooldown that now precedes `lockedOut`
   * (ISO timestamp, absent when not backing off).
   *
   * Mirrors the online ladder the owner accepted for B-15 Q5, and exists for
   * the same reason: a mistyped digit is not an attack, and an outlet with no
   * internet that burns its supervisor's credential on five fat-fingered
   * attempts has no way back until connectivity returns. Backing off first
   * recovers that case with no human process at all — which is the only kind
   * of recovery available to a device in a dead zone.
   */
  lockedUntil?: ISODateTime;
  /**
   * B-17 — the 6-digit challenge this device generated when it locked the
   * credential, read to head office over the phone. Present only while
   * `lockedOut` is true.
   *
   * Generated ONCE per lock and kept, not regenerated per attempt: the
   * supervisor is mid-phone-call, and a challenge that changed under them would
   * invalidate the code being read back to them as they type it.
   */
  unlockChallenge?: string;
  /**
   * Wrong unlock codes entered against the CURRENT challenge. At
   * `UNLOCK_MAX_ATTEMPTS` the credential is beyond offline recovery and waits
   * for the device to come back online.
   */
  unlockAttempts?: number;
}

// ── §4.7 attachment side-channel ──────────────────────────────────────────────

export type AttachmentUploadStatus = 'pending' | 'uploaded';

export interface AttachmentRecord {
  /** Content-address dedupe key (§4.7 rule 3: "same-sha256 re-upload is a no-op") — the STORE's primary key, never edited after first capture. */
  sha256: string;
  /**
   * The id an OWNING event actually references (`attachment_ref.sha256` is
   * for cloud-side sha256 verification only — the wire schema itself wants a
   * UUID: `packages/sync-protocol/src/schema/registry.ts`'s
   * `photoAttachmentIds: array(uuid())` / `signatureAttachmentId: uuid()`).
   * Minted ONCE per distinct sha256 at first capture and reused on every
   * dedupe hit — one physical blob has exactly one canonical id, even if
   * multiple events end up referencing it. Two different identities for two
   * different jobs: `sha256` is the content-addressed storage/dedupe key,
   * `attachmentId` is the business-fact reference key — neither substitutes
   * for the other (see `attachments/attachment-store.ts`'s header).
   */
  attachmentId: UUID;
  blob: Blob;
  size: number;
  mime: string;
  kind: string;
  capturedAt: ISODateTime;
  uploadStatus: AttachmentUploadStatus;
  uploadedAt: ISODateTime | null;
}

// ── local fact-derived movements (D-16a shared projector input) ──────────────

export type StoredMovement = MovementFact;

// ── store name registry ────────────────────────────────────────────────────────

export const STORE_NAMES = [
  'device_identity',
  'client_seq_counter',
  'push_ack_state',
  'clock_state',
  'outbox',
  'outbox_quarantine',
  'applied_events',
  'cursors',
  'master_data',
  'movements',
  'conflict_hints',
  'credentials',
  'credential_crl',
  'pin_attempts',
  'attachments',
  'driver_jobs',
] as const;

export type StoreName = (typeof STORE_NAMES)[number];

/** The key path field name per store — singletons always key on the literal `'self'`. */
export const STORE_KEY_PATH: Record<StoreName, string> = {
  device_identity: 'id',
  client_seq_counter: 'id',
  push_ack_state: 'id',
  clock_state: 'id',
  outbox: 'eventId',
  outbox_quarantine: 'eventId',
  applied_events: 'eventId',
  cursors: 'upstream',
  master_data: 'key',
  movements: 'factId',
  conflict_hints: 'id',
  credentials: 'credentialId',
  credential_crl: 'credentialId',
  pin_attempts: 'credentialId',
  attachments: 'sha256',
  driver_jobs: 'key',
};
