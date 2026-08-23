-- =============================================================================
-- A manager runs SEVERAL BRANCHES, not the whole company (owner, 2026-08-23).
--
-- The owner's org is two managers over regions: Balikpapan+Samarinda and
-- Banjarmasin+Pontianak. `simulate-org.ts` wrote those regions into
-- `user_locations` and they did nothing at all — a day simulation had manager2
-- reading 50 rows of Balikpapan's sales, because `app_is_central()` returned
-- true for `manager` and 46 policies named `manager` in an unrestricted role
-- array. Assigning branches to a manager looked like scoping and was decoration.
--
-- ## The rule
--
-- A manager with NO `user_locations` rows stays company-wide. A manager WITH
-- rows is restricted to them.
--
-- That shape is deliberate and does the most work for the least risk:
--
--   * It is BACKWARD COMPATIBLE. `database/seed.ts` creates its managers with
--     `locations: []`, so every existing environment and the whole test suite
--     behave exactly as before — nothing silently loses access on migration.
--   * It makes the restriction OPT-IN and visible: you scope a manager by
--     giving them branches, which is the same gesture the UI already offers.
--   * It needs no new session variable. `app_has_location()` already consults
--     `app_is_central()` internally, so narrowing that ONE function
--     automatically scopes every policy written as `app_has_location(...)` —
--     including `sales`, which is where the leak was first observed.
--
-- ## What is scoped, and what deliberately is not
--
-- Only the 14 policies on tables that HAVE a `location_id` are rewritten. The
-- other 32 that name `manager` sit on tables with no location at all —
-- suppliers, users, the chart of accounts, fiscal periods, payroll periods,
-- drivers, locations itself. A supplier list is not per-branch, and inventing a
-- join to scope one would be a guess dressed as a security boundary.
--
-- Two consequences worth stating plainly rather than discovering later:
--
--   1. Child tables (`po_lines`, `po_receipt_lines`, `purchase_request_lines`)
--      have no `location_id` and are not touched, but their policies delegate to
--      the parent document, which IS scoped — so they inherit the restriction.
--   2. `employee_loans`, `leave_requests` and the payroll tables have no
--      `location_id` either, so a regional manager still sees those for every
--      employee. Scoping them means an EXISTS join through `employees`, which is
--      a bigger change than this one and is left for a decision of its own.
--
-- `auth_lockouts` and `approval_codes` gate on `app_is_central()` alone and
-- carry no location, so they name `manager` explicitly now — otherwise a
-- regional manager holding `auth.lockout.clear` could no longer see the row they
-- are meant to clear.
-- =============================================================================

BEGIN;

-- The one function that makes the rest of this work.
CREATE OR REPLACE FUNCTION public.app_is_central()
  RETURNS boolean
  LANGUAGE sql
  STABLE
AS $function$
  SELECT
    current_setting('app.role', true) IN ('owner', 'finance', 'hr_admin', 'superadmin')
    OR (
      -- A manager is company-wide only while no branches are assigned to them.
      -- `app.location_ids` is set by RlsContextGuard from `user_locations`, so
      -- "empty" here means exactly "this manager has been given no region".
      current_setting('app.role', true) = 'manager'
      AND coalesce(NULLIF(current_setting('app.location_ids', true), ''), '') = ''
    );
$function$;

-- These two carry no location to scope by, and a manager must still be able to
-- act on them (clearing a lockout, issuing an approval code).
ALTER POLICY auth_lockouts_scope ON auth_lockouts
  USING (
    app_is_central()
    OR current_setting('app.role'::text, true) = 'manager'::text
    OR app_is_self(user_id)
  );

ALTER POLICY approval_codes_scope ON approval_codes
  USING (
    app_is_central()
    OR current_setting('app.role'::text, true) = 'manager'::text
    OR app_is_self(issued_by_user_id)
    OR app_is_self(redeemable_by_user_id)
  );

-- ── the 14 location-scoped policies ─────────────────────────────────────────
-- Generated from the expressions Postgres itself reported, with exactly two
-- edits each: `'manager'` dropped from the unrestricted role array, and a
-- manager-plus-location branch OR'd on. `app_has_location()` returns true for an
-- UNSCOPED manager, so this single branch covers both halves of the rule.

ALTER POLICY attendance_scope ON attendance
  USING (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id)) OR (EXISTS ( SELECT 1
   FROM employees e
  WHERE ((e.id = attendance.employee_id) AND app_is_self(e.user_id))))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id)) OR (EXISTS ( SELECT 1
   FROM employees e
  WHERE ((e.id = attendance.employee_id) AND app_is_self(e.user_id))))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY audit_log_select ON audit_log
  USING (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY employees_scope ON employees
  USING (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id)) OR app_is_self(user_id)))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY employment_contracts_scope ON employment_contracts
  USING (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text])) OR (EXISTS ( SELECT 1
   FROM employees e
  WHERE ((e.id = employment_contracts.employee_id) AND (app_is_self(e.user_id) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(e.location_id))))))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY employments_scope ON employments
  USING (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id)) OR (EXISTS ( SELECT 1
   FROM employees e
  WHERE ((e.id = employments.employee_id) AND app_is_self(e.user_id))))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY journal_entries_role ON journal_entries
  USING (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY journal_lines_role ON journal_lines
  USING (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY payment_verifications_role ON payment_verifications
  USING (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY purchase_orders_loc_role ON purchase_orders
  USING (
    ((app_has_location(location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text]))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    ((app_has_location(location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text]))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY purchase_requests_loc_role ON purchase_requests
  USING (
    ((app_has_location(location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text]))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    ((app_has_location(location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text]))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY shift_assignments_scope ON shift_assignments
  USING (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id)) OR (EXISTS ( SELECT 1
   FROM employees e
  WHERE ((e.id = shift_assignments.employee_id) AND app_is_self(e.user_id))))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  )
  WITH CHECK (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'hr_admin'::text])) OR ((current_setting('app.role'::text, true) = 'supervisor'::text) AND app_has_location(location_id))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY user_locations_delete ON user_locations
  USING (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY user_locations_insert ON user_locations
  WITH CHECK (
    ((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text])))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

ALTER POLICY user_locations_select ON user_locations
  USING (
    (((current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'hr_admin'::text, 'finance'::text])) OR app_is_self(user_id)))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
  );

-- Nothing on a location-bearing table may still treat `manager` as unrestricted.
-- Checked here rather than trusted, because the whole point of this migration is
-- one predicate and a single missed policy re-opens the leak everywhere it
-- reaches.
DO $$
DECLARE
  leftover text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ')
    INTO leftover
    FROM pg_policies
   WHERE (qual LIKE '%''manager''::text, %' OR qual LIKE '%, ''manager''::text%'
          OR with_check LIKE '%''manager''::text, %' OR with_check LIKE '%, ''manager''::text%')
     AND EXISTS (SELECT 1 FROM information_schema.columns c
                  WHERE c.table_name = pg_policies.tablename
                    AND c.column_name = 'location_id');
  IF leftover IS NOT NULL THEN
    RAISE EXCEPTION 'manager is still unrestricted on location-scoped policies: %', leftover;
  END IF;
END $$;

COMMIT;
