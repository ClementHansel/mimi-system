-- Migration: 004_audit_log
-- Block: 001-009 (core)
-- Description: append-only audit trail (D-09, FR-AUDIT-01/02). Written ONLY by
--              the @Audited() interceptor at the application layer.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  role_key VARCHAR(30),
  location_id UUID REFERENCES locations(id),
  module VARCHAR(50) NOT NULL,                   -- 'pos', 'replenishment', …
  action VARCHAR(100) NOT NULL,                  -- permission key or verb
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID,
  before_value JSONB,                            -- FR-AUDIT-01
  after_value JSONB,                             -- FR-AUDIT-01
  reason TEXT,                                   -- FR-AUDIT-02 (mandatory on reject/amend paths, enforced by app)
  ip_address INET,
  device_id UUID,                                -- FK added in block 110 (fk_audit_device)
  offline_authorized BOOLEAN NOT NULL DEFAULT false,  -- D-17 provenance
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),     -- client time for offline-born actions
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()       -- server receive time
);

COMMIT;
