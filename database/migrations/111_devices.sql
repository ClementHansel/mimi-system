-- Migration: 111_devices
-- Block: 110-119 (device registry & branch nodes, D-13)
-- Description: devices (Tier 1: tablets/laptops running the PWA; plus LAN
--              gear found by discovery). Resolves the device_id forward
--              references dangling on sessions, audit_log, pos_shifts,
--              attendance.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  node_id UUID REFERENCES branch_nodes(id),      -- NULL when no branch node at the location
  category VARCHAR(20) NOT NULL CHECK (category IN
    ('tablet','pos_terminal','printer','laptop','router','branch_node','other')),
  name VARCHAR(100) NOT NULL,
  fingerprint VARCHAR(100) UNIQUE,               -- stable device-generated id (PWA install identity)
  replaces_device_id UUID REFERENCES devices(id),-- SYNC-PROTOCOL §1.5: links successive installations of the
                                                  -- same physical device; a retired id's un-synced queue stays attributable
  status VARCHAR(20) NOT NULL DEFAULT 'unpaired' CHECK (status IN
    ('online','stale','offline','unpaired','retired')),
  app_version VARCHAR(30),                       -- D-13
  queue_depth INTEGER NOT NULL DEFAULT 0,        -- D-13: outbox events pending push (last reported)
  last_seen_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  device_token_hash VARCHAR(255),                -- long-lived device JWT (scope: heartbeat+sync)
  ip_address INET,
  mac_address VARCHAR(17),
  vendor VARCHAR(100),
  model VARCHAR(100),
  os_info JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  paired_at TIMESTAMPTZ,
  paired_by UUID REFERENCES users(id),
  unpaired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON devices
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Retro-FKs to earlier blocks:
ALTER TABLE sessions   ADD CONSTRAINT fk_sessions_device FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE audit_log  ADD CONSTRAINT fk_audit_device    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE pos_shifts ADD CONSTRAINT fk_shift_device    FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE attendance ADD CONSTRAINT fk_att_device      FOREIGN KEY (check_in_device_id) REFERENCES devices(id) ON DELETE SET NULL;

COMMIT;
