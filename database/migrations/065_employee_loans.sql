-- Migration: 065_employee_loans
-- Block: 060-069 (HR & payroll)
-- Description: loans / kasbon (POUT-06) with automatic amortization.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE employee_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_number VARCHAR(30) UNIQUE NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees(id),
  principal NUMERIC(18,2) NOT NULL,
  monthly_installment NUMERIC(18,2) NOT NULL,
  outstanding NUMERIC(18,2) NOT NULL,            -- sisa pinjaman otomatis
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','active','paid_off','written_off','rejected')),
  reason TEXT,
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  disbursed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON employee_loans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE employee_loan_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
  payroll_line_id UUID,                          -- FK added in block 066 (fk_elp_payroll_line)
  amount NUMERIC(18,2) NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'payroll_deduction' CHECK (method IN ('payroll_deduction','cash')),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

COMMIT;
