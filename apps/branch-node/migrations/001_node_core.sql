CREATE EXTENSION IF NOT EXISTS pgcrypto; -- gen_random_uuid()

-- Branch-node local schema, part 1: identity, the event log, cursors, and the
-- LAN device registry cache. This is deliberately NOT a copy of the cloud's
-- ~95-table schema (SYNC-PROTOCOL §1.1: the node holds "full event log for
-- its location + global master data... local projections for LAN fan-out...
-- per-device cursors" — not the canonical relational state, which stays
-- cloud-only). See migrations/002_node_projections.sql for the
-- whitelist-apply projections (§1.4).

-- One-row table: this node's own identity, set at /api/nodes/register and
-- refreshed by pull events (cert_rotated, config_updated).
CREATE TABLE IF NOT EXISTS node_identity (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  node_id UUID,
  node_token TEXT,
  location_id UUID,
  location_code VARCHAR(20),
  location_name VARCHAR(100),
  lan_cert_dns_name VARCHAR(255),
  lan_cert_pem TEXT,
  lan_cert_key_pem TEXT,
  lan_cert_expires_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The node's local copy of the sync_events envelope (SYNC-PROTOCOL §2.1),
-- covering BOTH directions this node relays: device-origin events pushed up
-- (relay outbox toward cloud) and events pulled down from cloud (LAN
-- fan-out). `server_seq` is THIS node's own gapless arrival order — the
-- domain of the pull cursors it serves to its LAN devices (§4.5); it is
-- unrelated to the cloud's own `server_seq`.
CREATE TABLE IF NOT EXISTS sync_events (
  event_id UUID PRIMARY KEY,
  server_seq BIGSERIAL UNIQUE,
  origin_tier VARCHAR(10) NOT NULL CHECK (origin_tier IN ('device', 'node', 'cloud')),
  origin_device_id UUID NOT NULL,
  location_id UUID,
  entity TEXT NOT NULL,
  entity_id UUID NOT NULL,
  op TEXT NOT NULL,
  payload JSONB NOT NULL,
  client_seq BIGINT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  relay_received_at TIMESTAMPTZ NOT NULL,
  actor_user_id UUID NOT NULL,
  schema_v SMALLINT NOT NULL DEFAULT 1,
  UNIQUE (origin_device_id, client_seq)
);
CREATE INDEX IF NOT EXISTS idx_sync_events_entity ON sync_events (entity, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_events_origin_seq ON sync_events (origin_device_id, client_seq);

-- Per-origin gapless high-water this node has applied — the `accepted_through`
-- this node reports to ITS downstreams (§4.4 apply order).
CREATE TABLE IF NOT EXISTS origin_high_water (
  origin_device_id UUID PRIMARY KEY,
  high_water BIGINT NOT NULL DEFAULT 0
);

-- What the CLOUD has confirmed per origin, as far as this node knows (learned
-- from the cloud's own push acks) — the `confirmed_through` this node relays
-- onward (§4.3's two-level ack), and the boundary of this node's relay outbox
-- (events with client_seq beyond this per origin are still owed to the cloud).
CREATE TABLE IF NOT EXISTS cloud_confirmed_high_water (
  origin_device_id UUID PRIMARY KEY,
  high_water BIGINT NOT NULL DEFAULT 0
);

-- Per-subscriber pull cursors this node serves to ITS downstreams (LAN
-- devices), plus this node's own cursor toward the cloud (subscriber_id =
-- this node's own id, keyed the same way for uniformity).
CREATE TABLE IF NOT EXISTS sync_cursors (
  subscriber_id TEXT NOT NULL,
  stream VARCHAR(40) NOT NULL DEFAULT 'main',
  cursor BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (subscriber_id, stream)
);

-- LAN device registry cache (SYNC-PROTOCOL §4.1): lets the node validate a
-- device's credential and accept its pushes even while the cloud is
-- unreachable. Kept in sync from `devices.*` pull events (class B, §3.3
-- group 12) — the node never mints or revokes a device credential itself.
CREATE TABLE IF NOT EXISTS lan_devices (
  device_id UUID PRIMARY KEY,
  location_id UUID NOT NULL,
  device_token_hash VARCHAR(255) NOT NULL,
  category VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  last_seen_at TIMESTAMPTZ,
  queue_depth INTEGER NOT NULL DEFAULT 0,
  revoked BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lan_devices_token ON lan_devices (device_token_hash);

-- LAN discovery results (D-13; mirrors CONTRACTS.md block 115 `discovered_devices`,
-- scoped to just this node since a node only ever discovers its own LAN).
CREATE TABLE IF NOT EXISTS discovered_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source VARCHAR(20) NOT NULL CHECK (source IN ('mdns', 'ssdp', 'tcp_probe')),
  ip_address INET NOT NULL,
  mac_address VARCHAR(17),
  vendor VARCHAR(100),
  model VARCHAR(100),
  suggested_category VARCHAR(20),
  suggested_name VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'confirmed', 'ignored', 'disappeared')),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}',
  UNIQUE (ip_address, mac_address)
);
