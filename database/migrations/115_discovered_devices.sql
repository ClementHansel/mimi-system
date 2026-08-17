-- Migration: 115_discovered_devices
-- Block: 110-119 (device registry & branch nodes, D-13)
-- Description: LAN discovery results (only where a node exists).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE discovered_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES branch_nodes(id) ON DELETE CASCADE,
  source VARCHAR(20) NOT NULL CHECK (source IN ('mdns','ssdp','onvif','tcp_probe')),
  ip_address INET NOT NULL,
  mac_address VARCHAR(17),
  vendor VARCHAR(100),
  model VARCHAR(100),
  suggested_category VARCHAR(20),
  suggested_name VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','ignored')),
  confirmed_device_id UUID REFERENCES devices(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}',
  UNIQUE (node_id, ip_address, mac_address)
);

COMMIT;
