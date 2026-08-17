-- Migration: 116_indexes_rls_110
-- Block: 110-119 (device registry & branch nodes, D-13)
-- Description: indexes + RLS for block 110-119. Per §1.14, devices and
--              branch_nodes are LOC; device_heartbeats/device_events/
--              pairing_tokens/discovered_devices are NONE (API-gated).
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_branch_nodes_status ON branch_nodes(status);

CREATE INDEX idx_devices_location ON devices(location_id);
CREATE INDEX idx_devices_node ON devices(node_id);
CREATE INDEX idx_devices_status ON devices(status);
CREATE INDEX idx_devices_replaces ON devices(replaces_device_id);

CREATE INDEX idx_device_heartbeats_device_at ON device_heartbeats(device_id, at DESC);
CREATE INDEX idx_device_heartbeats_node_at ON device_heartbeats(node_id, at DESC);

CREATE INDEX idx_device_events_device ON device_events(device_id);
CREATE INDEX idx_device_events_node ON device_events(node_id);
CREATE INDEX idx_device_events_location ON device_events(location_id);
CREATE INDEX idx_device_events_type ON device_events(type);
CREATE INDEX idx_device_events_created_at ON device_events(created_at DESC);

CREATE INDEX idx_pairing_tokens_location ON pairing_tokens(location_id);
CREATE INDEX idx_pairing_tokens_expires ON pairing_tokens(expires_at);

CREATE INDEX idx_discovered_devices_node ON discovered_devices(node_id);
CREATE INDEX idx_discovered_devices_status ON discovered_devices(status);

-- =============================================================================
-- RLS — devices / branch_nodes: LOC
-- =============================================================================

ALTER TABLE devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE devices FORCE ROW LEVEL SECURITY;
CREATE POLICY devices_loc ON devices FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE branch_nodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE branch_nodes FORCE ROW LEVEL SECURITY;
CREATE POLICY branch_nodes_loc ON branch_nodes FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

COMMIT;
