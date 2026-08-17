/**
 * Cloud sync engine constants (SYNC-PROTOCOL.md, W2-D).
 *
 * These are cloud-side implementation constants (not protocol surface —
 * `@mimi/sync-protocol` stays the frozen wire contract). Defaults mirror
 * `@mimi/shared`'s `DEFAULT_*` constants; live values are read from the
 * `settings` table at runtime and fall back to these only if a row is
 * missing (fresh/partial install).
 */

/**
 * SYNC-PROTOCOL §1.5: "the cloud is just another (privileged) origin... the
 * well-known origin id `00000000-0000-0000-0000-0000000000c1`". `sync_events
 * .origin_device_id` carries no FK (CONTRACTS.md block 120-129), so this id
 * needs no registry row — only a durable client_seq source, which is
 * `cloud_client_seq` (migration `210_w2d_cloud_client_seq.sql`).
 */
export const CLOUD_ORIGIN_DEVICE_ID = '00000000-0000-0000-0000-0000000000c1';
export const CLOUD_ORIGIN_TIER = 'cloud' as const;

/** §4.4 / R9: a persisting gap past this raises `possible_data_loss`. */
export const GAP_STALE_THRESHOLD_MS = 60 * 60 * 1000;

/** §4.7 / R3: an unresolved required `attachment_ref` past this raises an exception. */
export const EVIDENCE_SLA_MS = 24 * 60 * 60 * 1000;

/** §4.4: a `pending_dependency` event whose parent stays quarantined this long converts to a conflict-queue entry. */
export const PENDING_DEPENDENCY_TTL_MS = 24 * 60 * 60 * 1000;

/** §4.3: push batch limits (mirrored here for HTTP body-size validation; `@mimi/sync-protocol`'s `MAX_EVENTS_PER_BATCH`/`MAX_BATCH_BYTES` are the authority). */
export const MAX_PULL_LIMIT = 500;

/** §4.5: bootstrap/pull page byte cap. */
export const MAX_PULL_PAGE_BYTES = 2_000_000;

/** §4.6: node heartbeat cadence reference (device is 60s) — used only for staleness math on the cloud side. */
export const NODE_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEVICE_HEARTBEAT_INTERVAL_MS = 60_000;

/** R1 nightly full recompute time-of-day, Asia/Makassar (SYNC-PROTOCOL §5.5). */
export const R1_NIGHTLY_HOUR_WITA = 2;
