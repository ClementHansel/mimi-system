-- Migration: 120_sync_events
-- Block: 120-129 (sync & offline authorization, D-12, D-17)
-- Description: the append-only event log (cloud's canonical copy). Row shape
--              matches SYNC-PROTOCOL.md §2.1 verbatim; cloud-only bookkeeping
--              columns marked (cloud). SYNC-PROTOCOL wins for behavior, this
--              file wins for DDL.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE sync_events (
  event_id UUID PRIMARY KEY,                     -- CLIENT-minted UUIDv7 = THE idempotency key (never regenerated)
  server_seq BIGSERIAL UNIQUE,                   -- this tier's gapless arrival order; pull-cursor domain (§4.5)
  origin_tier VARCHAR(10) NOT NULL CHECK (origin_tier IN ('device','node','cloud')),
  origin_device_id UUID NOT NULL,                -- installation id (devices.id | branch_nodes.id | well-known cloud id)
  location_id UUID REFERENCES locations(id),     -- NULL = global master data
  entity TEXT NOT NULL,                          -- EXACT table name from §4.1 = SyncEntity (§2.9)
  entity_id UUID NOT NULL,                       -- business record id (parent id for embedded children)
  op TEXT NOT NULL,                              -- past-tense fact verb; vocabulary per entity in SYNC-PROTOCOL §3.3
  payload JSONB NOT NULL,                        -- versioned envelope {v, data, meta} (§2.3); <= 256 KB
  client_seq BIGINT NOT NULL,                    -- gapless monotonic per origin; THE ordering authority
  occurred_at TIMESTAMPTZ NOT NULL,              -- origin wall clock (offset-corrected); ADVISORY only
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),-- stamped by this tier at durable store; cloud's = canonical
  relay_received_at TIMESTAMPTZ,                 -- first non-origin tier's stamp (node when present); defensibility bound (§6.4)
  relayed_via_node_id UUID REFERENCES branch_nodes(id), -- (cloud) which node relayed; NULL = direct/cloud-born
  actor_user_id UUID NOT NULL,                   -- who did it (copied from meta for indexing/audit)
  schema_v SMALLINT NOT NULL DEFAULT 1,          -- copy of payload.v
  batch_id UUID,                                 -- (cloud) FK added in 121
  apply_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (apply_status IN
    ('pending','applied','quarantined','superseded','pending_dependency')),  -- (cloud) §4.4/§5.1
  applied_at TIMESTAMPTZ,                        -- (cloud)
  reject_code VARCHAR(40),                       -- (cloud) 'authority_violation'|'malformed'|'seq_conflict'|'payload_version_unsupported'
  reject_detail TEXT,                            -- (cloud)
  UNIQUE (origin_device_id, client_seq)          -- outbox-corruption detector (§2.2 rule 4)
);

COMMIT;
