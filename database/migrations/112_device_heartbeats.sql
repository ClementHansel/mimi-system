-- Migration: 112_device_heartbeats
-- Block: 110-119 (device registry & branch nodes, D-13)
-- Description: heartbeats (high volume; BIGSERIAL, 7-day retention pruned
--              nightly by a backend scheduler).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE device_heartbeats (                 -- append-only
  id BIGSERIAL PRIMARY KEY,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  node_id UUID REFERENCES branch_nodes(id) ON DELETE CASCADE, -- exactly one of device_id/node_id set
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_version VARCHAR(30),
  queue_depth INTEGER NOT NULL DEFAULT 0,
  client_time TIMESTAMPTZ,                       -- clock-skew detection
  battery_pct SMALLINT,
  storage_free_mb INTEGER,
  network_type VARCHAR(20),
  payload JSONB NOT NULL DEFAULT '{}',
  CHECK ((device_id IS NULL) <> (node_id IS NULL))
);

COMMIT;
