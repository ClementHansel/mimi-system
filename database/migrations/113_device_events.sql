-- Migration: 113_device_events
-- Block: 110-119 (device registry & branch nodes, D-13)
-- Description: device lifecycle events (feeds F12 + alerts).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE device_events (                     -- append-only
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  node_id UUID REFERENCES branch_nodes(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),
  type VARCHAR(30) NOT NULL CHECK (type IN
    ('paired','unpaired','online','offline','stale','version_changed','queue_alert','clock_skew','outlet_offline','outlet_online')),
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
