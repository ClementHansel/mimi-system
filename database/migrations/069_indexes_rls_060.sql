-- Migration: 069_indexes_rls_060
-- Block: 060-069 (HR & payroll)
-- Description: indexes + RLS for block 060-069, plus the approval_chain_steps
--              seed for every ApprovalDocumentType (CONTRACTS.md §5).
--
-- Known representational gaps flagged for W2-B (kernel/approvals owner):
--   1. `stock_opname` and `return` (5.4 / 5.5 / 5.6) select their step-1
--      approver by LOCATION TYPE (supervisor at an outlet, kepala_gudang at
--      the warehouse) and, for `return`, by DIRECTION as well. This table
--      is (document_type, step_no) -> one role, so it cannot encode a
--      location/direction-conditional role. Seeded with the outlet-side role
--      (supervisor) as the representative default; the approval engine must
--      substitute kepala_gudang at runtime when `approvals.location_id`
--      resolves to a warehouse (or, for `return`, when direction is
--      warehouse_to_supplier).
--   2. `waste` approvals (§5.10) have the identical gap (SPV outlet-step
--      offline-eligible / KGD warehouse-step online-only) AND `waste` is
--      missing from the `ApprovalDocumentType` TS enum in CONTRACTS.md §2.5
--      even though `waste_records.approval_id` references `approvals` and
--      `waste.approve` is a real permission key. `approvals.document_type` is
--      an unconstrained VARCHAR(40) in the DB (no CHECK), so seeding
--      document_type='waste' here is safe, but packages/shared should add
--      `WASTE = 'waste'` to the enum for type-checking parity.
--   3. `leave_request` (§5.10) is approvable by SPV, HRA, or MGR
--      interchangeably at step 1, not a fixed single role. Seeded with
--      supervisor; hr_admin/manager approve the same step via the "role-rank
--      / equivalent-role" override the engine must implement.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_employees_location ON employees(location_id);
CREATE INDEX idx_employees_status ON employees(employment_status);

CREATE INDEX idx_employments_employee ON employments(employee_id);
CREATE INDEX idx_employments_location ON employments(location_id);

CREATE INDEX idx_work_shifts_location ON work_shifts(location_id);

CREATE INDEX idx_shift_assignments_location ON shift_assignments(location_id);
CREATE INDEX idx_shift_assignments_date ON shift_assignments(date);
CREATE INDEX idx_shift_assignments_work_shift ON shift_assignments(work_shift_id);

CREATE INDEX idx_attendance_location ON attendance(location_id);
CREATE INDEX idx_attendance_date ON attendance(date);
CREATE INDEX idx_attendance_status ON attendance(status);

CREATE INDEX idx_leave_requests_employee ON leave_requests(employee_id);
CREATE INDEX idx_leave_requests_status ON leave_requests(status);

CREATE INDEX idx_employee_salary_components_employee ON employee_salary_components(employee_id);
CREATE INDEX idx_employee_salary_components_component ON employee_salary_components(component_id);

CREATE INDEX idx_employee_loans_employee ON employee_loans(employee_id);
CREATE INDEX idx_employee_loans_status ON employee_loans(status);
CREATE INDEX idx_employee_loan_payments_loan ON employee_loan_payments(loan_id);
CREATE INDEX idx_employee_loan_payments_payroll_line ON employee_loan_payments(payroll_line_id);

CREATE INDEX idx_payroll_periods_status ON payroll_periods(status);
CREATE INDEX idx_payroll_runs_period ON payroll_runs(period_id);
CREATE INDEX idx_payroll_runs_status ON payroll_runs(status);
CREATE INDEX idx_payroll_lines_employee ON payroll_lines(employee_id);
CREATE INDEX idx_payroll_lines_component ON payroll_lines(component_id);
CREATE INDEX idx_payroll_lines_run ON payroll_lines(run_id);

CREATE INDEX idx_bpjs_configs_program_effective ON bpjs_configs(program, effective_from DESC);
CREATE INDEX idx_pph21_ter_rates_category_effective ON pph21_ter_rates(category, effective_from DESC);
CREATE INDEX idx_pph21_ptkp_code_effective ON pph21_ptkp(ptkp_code, effective_from DESC);

-- =============================================================================
-- RLS — employees / employments / attendance / leave_requests / shift_assignments
-- ROLE(owner,manager,finance,hr_admin) OR (supervisor AND LOC) OR SELF
-- =============================================================================

ALTER TABLE employees ENABLE ROW LEVEL SECURITY;
ALTER TABLE employees FORCE ROW LEVEL SECURITY;
CREATE POLICY employees_scope ON employees FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
    OR app_is_self(user_id)
  )
  WITH CHECK (
    current_setting('app.role', true) IN ('owner','manager','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
  );

ALTER TABLE employments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employments FORCE ROW LEVEL SECURITY;
CREATE POLICY employments_scope ON employments FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = employments.employee_id AND app_is_self(e.user_id))
  )
  WITH CHECK (
    current_setting('app.role', true) IN ('owner','manager','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
  );

ALTER TABLE attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance FORCE ROW LEVEL SECURITY;
CREATE POLICY attendance_scope ON attendance FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = attendance.employee_id AND app_is_self(e.user_id))
  )
  WITH CHECK (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = attendance.employee_id AND app_is_self(e.user_id))
  );

ALTER TABLE leave_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE leave_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY leave_requests_scope ON leave_requests FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR (
      current_setting('app.role', true) = 'supervisor'
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = leave_requests.employee_id AND app_has_location(e.location_id))
    )
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = leave_requests.employee_id AND app_is_self(e.user_id))
  )
  WITH CHECK (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR (
      current_setting('app.role', true) = 'supervisor'
      AND EXISTS (SELECT 1 FROM employees e WHERE e.id = leave_requests.employee_id AND app_has_location(e.location_id))
    )
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = leave_requests.employee_id AND app_is_self(e.user_id))
  );

ALTER TABLE shift_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE shift_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY shift_assignments_scope ON shift_assignments FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = shift_assignments.employee_id AND app_is_self(e.user_id))
  )
  WITH CHECK (
    current_setting('app.role', true) IN ('owner','manager','hr_admin')
    OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(location_id))
  );

-- =============================================================================
-- RLS — salary_components (no per-employee row; broad read for slip
-- rendering joins, writes restricted to payroll.component.manage holders)
-- =============================================================================

ALTER TABLE salary_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE salary_components FORCE ROW LEVEL SECURITY;
CREATE POLICY salary_components_select ON salary_components FOR SELECT USING (true);
CREATE POLICY salary_components_write ON salary_components FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('owner','finance','hr_admin'));
CREATE POLICY salary_components_update ON salary_components FOR UPDATE
  USING (current_setting('app.role', true) IN ('owner','finance','hr_admin'));
CREATE POLICY salary_components_delete ON salary_components FOR DELETE
  USING (current_setting('app.role', true) IN ('owner','finance','hr_admin'));

-- =============================================================================
-- RLS — employee_salary_components / employee_loans / employee_loan_payments:
-- ROLE(owner,manager,finance,hr_admin) OR SELF
-- =============================================================================

ALTER TABLE employee_salary_components ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_salary_components FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_salary_components_scope ON employee_salary_components FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_salary_components.employee_id AND app_is_self(e.user_id))
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance','hr_admin'));

ALTER TABLE employee_loans ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_loans FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_loans_scope ON employee_loans FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_loans.employee_id AND app_is_self(e.user_id))
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance','hr_admin'));

ALTER TABLE employee_loan_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE employee_loan_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY employee_loan_payments_scope ON employee_loan_payments FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR EXISTS (
      SELECT 1 FROM employee_loans l
      JOIN employees e ON e.id = l.employee_id
      WHERE l.id = employee_loan_payments.loan_id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance','hr_admin'));

-- =============================================================================
-- RLS — payroll_periods / payroll_runs / payroll_lines:
-- ROLE(owner,manager,finance,hr_admin) OR SELF (read own lines/loans/slips)
-- =============================================================================

ALTER TABLE payroll_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_lines_scope ON payroll_lines FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR EXISTS (SELECT 1 FROM employees e WHERE e.id = payroll_lines.employee_id AND app_is_self(e.user_id))
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance','hr_admin'));

ALTER TABLE payroll_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_runs_scope ON payroll_runs FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR EXISTS (
      SELECT 1 FROM payroll_lines pl
      JOIN employees e ON e.id = pl.employee_id
      WHERE pl.run_id = payroll_runs.id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance','hr_admin'));

ALTER TABLE payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY payroll_periods_scope ON payroll_periods FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','hr_admin')
    OR EXISTS (
      SELECT 1 FROM payroll_runs r
      JOIN payroll_lines pl ON pl.run_id = r.id
      JOIN employees e ON e.id = pl.employee_id
      WHERE r.period_id = payroll_periods.id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance','hr_admin'));

-- =============================================================================
-- NO RLS (§1.14 "NONE"): bpjs_configs, pph21_ter_rates, pph21_ptkp,
-- employee_tax_profiles are not listed in the amended RLS matrix as their own
-- rows; treated as statutory config (API-gated via payroll.statutory.* keys)
-- consistent with how the rest of payroll *config* master data is handled.
-- =============================================================================

-- =============================================================================
-- SEED — approval_chain_steps (CONTRACTS.md §5). See header note for the
-- three representational gaps (opname/return/waste location-or-direction
-- branching; leave_request's either-role step).
-- =============================================================================

INSERT INTO approval_chain_steps (document_type, step_no, approver_role, min_amount, max_amount) VALUES
  ('replenishment_request', 1, 'supervisor', NULL, NULL),
  ('replenishment_request', 2, 'kepala_gudang', NULL, NULL),
  ('void_refund', 1, 'supervisor', NULL, NULL),
  ('void_refund', 2, 'manager', 200000.00, NULL),
  ('purchase_request', 1, 'manager', NULL, NULL),
  ('purchase_order', 1, 'manager', NULL, NULL),
  ('purchase_order', 2, 'owner', 10000000.00, NULL),
  ('stock_opname', 1, 'supervisor', NULL, NULL),
  ('stock_opname', 2, 'manager', 2000000.00, NULL),
  ('return', 1, 'supervisor', NULL, NULL),
  ('payroll_run', 1, 'finance', NULL, NULL),
  ('payroll_run', 2, 'owner', NULL, NULL),
  ('payment_verification', 1, 'owner', 20000000.00, NULL),
  ('leave_request', 1, 'supervisor', NULL, NULL),
  ('employee_loan', 1, 'finance', NULL, NULL),
  ('employee_loan', 2, 'manager', NULL, NULL),
  ('cash_variance_proposal', 1, 'supervisor', NULL, NULL),
  ('waste', 1, 'supervisor', NULL, NULL)
ON CONFLICT (document_type, step_no) DO NOTHING;

COMMIT;
