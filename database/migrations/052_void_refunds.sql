-- Migration: 052_void_refunds
-- Block: 050-059 (POS, offline-first origin data)
-- Description: void/refund (FR-POS-03) — supervisor-authorized, offline-
--              provisional capable (D-17).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE void_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id),
  type VARCHAR(10) NOT NULL CHECK (type IN ('void','refund')),
  amount NUMERIC(18,2) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by UUID NOT NULL REFERENCES users(id),      -- kasir
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),                -- supervisor (APR-02)
  approved_at TIMESTAMPTZ,
  offline_authorized BOOLEAN NOT NULL DEFAULT false,    -- D-17
  reverification_status VARCHAR(20) CHECK (reverification_status IN ('verified','failed','unprovable')),
  rejection_reason TEXT,
  client_id UUID UNIQUE NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Approval applied => sales.status flips, payments reversed, usage_out reversed (usage 'return_in' to
-- kitchen_line), journal reversal (§6).

CREATE TRIGGER set_updated_at BEFORE UPDATE ON void_refunds
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
