-- Migration: 008_approval_engine
-- Block: 001-009 (core)
-- Description: generic approval engine (D-08), used by all approvable
--              document types (replenishment, void/refund, PR/PO, opname,
--              return, payroll run, payment verification, leave, loan).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE approval_chain_steps (              -- config: seeded from CONTRACTS.md §5, editable via settings.approval_chain.manage
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(40) NOT NULL,            -- 'replenishment_request','void_refund','purchase_request','purchase_order',
                                                  -- 'stock_opname','return','payroll_run','payment_verification','leave_request','employee_loan'
  step_no INTEGER NOT NULL,
  approver_role VARCHAR(30) NOT NULL,            -- role key from §3
  min_amount NUMERIC(18,2),                      -- step applies only when doc amount >= min_amount (threshold escalation)
  max_amount NUMERIC(18,2),
  UNIQUE (document_type, step_no)
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(40) NOT NULL,
  document_id UUID NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','cancelled')),
  current_step INTEGER NOT NULL DEFAULT 1,
  amount NUMERIC(18,2),                          -- doc value used for threshold routing (nullable)
  location_id UUID REFERENCES locations(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_type, document_id)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON approvals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE approval_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  approver_role VARCHAR(30) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','skipped')),
  acted_by UUID REFERENCES users(id),
  acted_at TIMESTAMPTZ,
  reason TEXT,                                   -- REQUIRED on reject/amend (FR-LOG-13, FR-SO-02); engine enforces
  offline_authorized BOOLEAN NOT NULL DEFAULT false,   -- D-17
  offline_credential_id UUID,                    -- FK added in block 120 (fk_as_offline_cred)
  reverified_at TIMESTAMPTZ,
  reverification_status VARCHAR(20) CHECK (reverification_status IN ('verified','failed','unprovable')),
    -- three-valued per SYNC-PROTOCOL §7.4 (unprovable => finance exception queue, human verdict)
  UNIQUE (approval_id, step_no)
);

COMMIT;
