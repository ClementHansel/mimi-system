-- Migration: 054_cash_variance_proposals
-- Block: 050-059 (POS, offline-first origin data)
-- Description: Amendment 2 (D-19) — cash variance at shift close auto-
--              proposes a payroll deduction, never auto-deducts. Supersedes
--              Appendix A-17. employee_id / payroll_line_id are forward
--              references resolved by retro-FKs in block 060 (employees /
--              payroll_lines are created there).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE cash_variance_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID UNIQUE NOT NULL REFERENCES pos_shifts(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  kasir_user_id UUID NOT NULL REFERENCES users(id),   -- who closed short
  employee_id UUID,                              -- deduction target; FK added in block 060 (fk_cvp_employee)
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),   -- the shortfall: expected_cash - closing_cash_counted
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approval_id UUID REFERENCES approvals(id),
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,                          -- REQUIRED on BOTH approve and reject (Amendment 2, §5.9)
  payroll_line_id UUID,                          -- FK added in block 060 (fk_cvp_payroll_line); set when consumed
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Auto-created (cloud, at pos_shifts.closed apply / R7) when shortfall > settings
-- 'pos.cash_variance_propose_above'. Does NOT reach payroll until approved (§5.9); approved => payroll
-- deduction line, component 'deduction_cash_variance', source_ref_type='cash_variance_proposal'. Overage
-- (counted > expected) creates no proposal — it stays an R7 finance exception. NOT eligible for offline
-- authorization (SYNC-PROTOCOL §7.6).

CREATE TRIGGER set_updated_at BEFORE UPDATE ON cash_variance_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
