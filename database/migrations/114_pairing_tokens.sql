-- Migration: 114_pairing_tokens
-- Block: 110-119 (device registry & branch nodes, D-13)
-- Description: pairing tokens (topology contract §7.2 flow).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE pairing_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(255) UNIQUE NOT NULL,
  display_code VARCHAR(12) NOT NULL,             -- human-typable, shown next to QR
  target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('device','node')),
  location_id UUID NOT NULL REFERENCES locations(id),
  suggested_category VARCHAR(20),
  created_by UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,               -- mint + 15 min
  used_at TIMESTAMPTZ,
  used_by_ref UUID,                              -- devices.id or branch_nodes.id
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
