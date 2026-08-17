-- Migration: 110_branch_nodes
-- Block: 110-119 (device registry & branch nodes, D-13)
-- Description: branch nodes (Tier 2, optional per D-12).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE branch_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID UNIQUE NOT NULL REFERENCES locations(id),  -- max one node per location
  name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unpaired' CHECK (status IN
    ('online','stale','offline','unpaired','retired')),
  version VARCHAR(30),                           -- node software version
  node_token_hash VARCHAR(255),                  -- socket auth credential
  ip_address INET,
  hostname VARCHAR(100),
  os_info JSONB NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  paired_at TIMESTAMPTZ,
  paired_by UUID REFERENCES users(id),
  unpaired_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON branch_nodes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
