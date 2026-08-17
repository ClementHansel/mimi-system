-- Migration: 066_payroll_runs
-- Block: 060-069 (HR & payroll)
-- Description: payroll periods, runs, lines (FR-HR-03/04). statutory_mode
--              (Amendment 1) snapshots the payroll.statutory flag at
--              calculate time so historical runs stay reproducible across a
--              later toggle. Resolves the employee_loan_payments and
--              cash_variance_proposals forward references to payroll_lines.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE payroll_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code VARCHAR(7) UNIQUE NOT NULL,        -- '2026-08'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','processing','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON payroll_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES payroll_periods(id),
  run_seq INTEGER NOT NULL DEFAULT 1,
  run_number VARCHAR(30) UNIQUE NOT NULL,        -- 'PRUN/YYYYMM/nn'
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','calculated','pending_approval','approved','paid','cancelled')),
  statutory_mode BOOLEAN NOT NULL DEFAULT false, -- Amendment 1: mode the run EXECUTED in (snapshot of the
                                                  -- payroll.statutory flag at calculate time) — historical runs stay
                                                  -- reproducible after a later toggle; recalculate re-snapshots
  calculated_by UUID REFERENCES users(id),
  calculated_at TIMESTAMPTZ,
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_verification_id UUID,                  -- FK added in block 090 (fk_prun_pv; FR-ACCT-04 payroll)
  total_gross NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_net NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, run_seq)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON payroll_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payroll_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  component_id UUID NOT NULL REFERENCES salary_components(id),
  qty NUMERIC(14,3),                             -- e.g. overtime hours, late minutes, absent days, SO diff qty
  rate NUMERIC(18,2),                            -- per-unit rate used
  amount NUMERIC(18,2) NOT NULL,                 -- positive; sign implied by component type
  source_ref_type VARCHAR(40),                   -- 'attendance','stock_opname','employee_loan',
                                                  -- 'cash_variance_proposal','manual'
  source_ref_id UUID,                            -- traceability: POUT-05 links the opname, POUT-06 the loan
  manual_override BOOLEAN NOT NULL DEFAULT false,
  override_reason TEXT,                          -- REQUIRED when manual_override
  UNIQUE (run_id, employee_id, component_id)
);

ALTER TABLE employee_loan_payments ADD CONSTRAINT fk_elp_payroll_line
  FOREIGN KEY (payroll_line_id) REFERENCES payroll_lines(id);
ALTER TABLE cash_variance_proposals ADD CONSTRAINT fk_cvp_payroll_line
  FOREIGN KEY (payroll_line_id) REFERENCES payroll_lines(id);  -- Amendment 2 retro-FK
-- Slip gaji (8.3.3): generated PDF stored as attachments(kind='slip_pdf', entity_type='payroll_run', entity_id),
-- delivery via notification_outbox (email/WA) after run approved.

COMMIT;
