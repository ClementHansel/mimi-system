-- =============================================================================
-- Finish scoping the manager: HR and payroll, reached through `employees`.
--
-- Migration 235 confined a manager to their branches on the 14 policies whose
-- table carries a `location_id`. It deliberately stopped there and recorded what
-- it was leaving: five policies where the location is one join away, through
-- `employees`. So a manager who runs Banjarmasin and Pontianak could not read
-- Balikpapan's SALES, and could still read every Balikpapan employee's LOANS,
-- LEAVE REQUESTS, SALARY COMPONENTS and PAYSLIP LINES.
--
-- That is the more sensitive half. Closing it is why this migration exists.
--
-- ## The shape, and why it is not a guess
--
-- `leave_requests` already contained exactly this pattern for supervisors:
--
--     role = 'supervisor' AND EXISTS (
--       SELECT 1 FROM employees e
--        WHERE e.id = leave_requests.employee_id AND app_has_location(e.location_id))
--
-- The manager branch below is that same predicate with the role changed, on all
-- five policies. Nothing new is invented — the join that expresses "this person
-- works at a branch I run" was already the accepted way to say it here.
--
-- `app_has_location()` still returns true for a manager with NO branches
-- assigned (it consults `app_is_central()`), so the head-office manager keeps
-- company-wide reach and this stays backward compatible with every database
-- whose managers are unscoped — the whole test suite included.
--
-- ## What is deliberately NOT scoped
--
-- `payroll_runs` and `payroll_periods`: a payroll RUN is one company-wide
-- document with no per-person data on it. Scoping the run would mean a regional
-- manager could not see that a period exists, which is not a confidentiality
-- boundary, just an obstruction. The per-person rows inside it (`payroll_lines`)
-- ARE scoped, which is where the salaries live.
-- =============================================================================

BEGIN;

-- ── loans ────────────────────────────────────────────────────────────────────
ALTER POLICY employee_loans_scope ON employee_loans
  USING (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = employee_loans.employee_id AND app_has_location(e.location_id)
      )
    )
    OR EXISTS (
      SELECT 1 FROM employees e
       WHERE e.id = employee_loans.employee_id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = employee_loans.employee_id AND app_has_location(e.location_id)
      )
    )
  );

-- ── loan repayments: the location is two joins away ──────────────────────────
ALTER POLICY employee_loan_payments_scope ON employee_loan_payments
  USING (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employee_loans l JOIN employees e ON e.id = l.employee_id
         WHERE l.id = employee_loan_payments.loan_id AND app_has_location(e.location_id)
      )
    )
    OR EXISTS (
      SELECT 1 FROM employee_loans l JOIN employees e ON e.id = l.employee_id
       WHERE l.id = employee_loan_payments.loan_id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employee_loans l JOIN employees e ON e.id = l.employee_id
         WHERE l.id = employee_loan_payments.loan_id AND app_has_location(e.location_id)
      )
    )
  );

-- ── leave ────────────────────────────────────────────────────────────────────
ALTER POLICY leave_requests_scope ON leave_requests
  USING (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = ANY (ARRAY['manager'::text, 'supervisor'::text])
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = leave_requests.employee_id AND app_has_location(e.location_id)
      )
    )
    OR EXISTS (
      SELECT 1 FROM employees e
       WHERE e.id = leave_requests.employee_id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = ANY (ARRAY['manager'::text, 'supervisor'::text])
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = leave_requests.employee_id AND app_has_location(e.location_id)
      )
    )
    OR EXISTS (
      SELECT 1 FROM employees e
       WHERE e.id = leave_requests.employee_id AND app_is_self(e.user_id)
    )
  );

-- ── payslip lines: where the salaries actually are ───────────────────────────
ALTER POLICY payroll_lines_scope ON payroll_lines
  USING (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = payroll_lines.employee_id AND app_has_location(e.location_id)
      )
    )
    OR EXISTS (
      SELECT 1 FROM employees e
       WHERE e.id = payroll_lines.employee_id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = payroll_lines.employee_id AND app_has_location(e.location_id)
      )
    )
  );

-- ── standing salary components ───────────────────────────────────────────────
ALTER POLICY employee_salary_components_scope ON employee_salary_components
  USING (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = employee_salary_components.employee_id AND app_has_location(e.location_id)
      )
    )
    OR EXISTS (
      SELECT 1 FROM employees e
       WHERE e.id = employee_salary_components.employee_id AND app_is_self(e.user_id)
    )
  )
  WITH CHECK (
    (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text]))
    OR (
      current_setting('app.role'::text, true) = 'manager'::text
      AND EXISTS (
        SELECT 1 FROM employees e
         WHERE e.id = employee_salary_components.employee_id AND app_has_location(e.location_id)
      )
    )
  );

-- No unrestricted `manager` may remain on any of the five. Checked rather than
-- trusted, for the same reason 235 checks its own fourteen: this is one predicate
-- repeated, and a single one left behind re-opens the whole thing.
DO $$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ')
    INTO leftover
    FROM pg_policies
   WHERE tablename IN ('employee_loans', 'employee_loan_payments', 'leave_requests',
                       'payroll_lines', 'employee_salary_components')
     AND (qual LIKE '%''manager''::text, %' OR qual LIKE '%, ''manager''::text%'
          OR with_check LIKE '%''manager''::text, %' OR with_check LIKE '%, ''manager''::text%')
     -- The scoped branch legitimately contains ARRAY['manager','supervisor'];
     -- what must not survive is manager sitting in the UNRESTRICTED role list
     -- alongside owner.
     AND (qual LIKE '%''owner''::text, ''manager''%' OR with_check LIKE '%''owner''::text, ''manager''%');
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'manager is still unrestricted on: %', leftover;
  END IF;
END $$;

COMMIT;
