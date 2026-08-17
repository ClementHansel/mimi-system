-- Migration: 216_w1c_fix_surat_jalan_with_check_asymmetry
-- Fix block: 2xx. PRODUCTION-BLOCKING bug found by the cross-kernel test
--             (verified live against the running policy, not just the
--             file): `surat_jalan_scope`'s USING has three arms (origin
--             LOC, any-destination LOC via app_sj_locations(), driver
--             carve-out) but WITH CHECK only ever had two — the
--             destination-outlet arm was missing. An outlet-scoped caller
--             could therefore READ a Surat Jalan bound for them but never
--             WRITE to it. `drop.service.ts` sets `surat_jalan.status =
--             'completed'` when the last drop is received — a real
--             `leader_outlet` completing a (typical) single-drop delivery
--             got `new row violates row-level security policy for table
--             "surat_jalan"`. This broke the primary receiving flow for
--             most deliveries in production today.
--
-- SWEEP PERFORMED (per the coordinator's suggestion): compared
-- pg_get_expr(polqual) against pg_get_expr(polwithcheck) for every policy
-- in the schema, not just the four named tables. Findings:
--   - `returns_loc`/`return_lines_parent`, `replenishment_requests_loc`/
--     `replenishment_request_lines_parent`, `goods_receipts_loc`/
--     `goods_receipt_lines_parent`: USING and WITH CHECK are IDENTICAL on
--     all of these — no asymmetry, nothing to fix.
--   - `sj_drops_scope`: asymmetric, but the narrower WITH CHECK arm
--     (origin-only, not "any sibling drop") is intentional and safe — the
--     broader USING arm exists so an outlet can see the whole route (e.g.
--     which other outlets share their delivery run), but no legitimate
--     write ever needs "I can see a sibling's drop" as its basis; every
--     real write is covered by the row's own location or the origin
--     warehouse, both present in WITH CHECK already.
--   - `sj_lines`/`sj_temperature_logs`/`sj_seals`: WITH CHECK is `true`
--     (documented, intentional — deliberately permissive on the write side
--     for these embedded-fact child tables, relying on the app-layer
--     PermissionsGuard). This is the OPPOSITE shape from the reported bug
--     (too loose, not too tight) and never causes the "can see it but can't
--     write it" failure — noted for a future tightening pass, out of
--     scope for this fix.
--   - A dozen payroll/HR-table asymmetries (`employees`, `employments`,
--     `shift_assignments`, `employee_loans`, `payroll_*`, `chart_of_
--     accounts`, `fiscal_periods`, `posting_rules`, `supplier_items`, …):
--     all of them are a narrower ROLE list on WITH CHECK than USING (e.g.
--     `finance` can read but not write `employees`; `self` can read but
--     never write their own payroll/loan/shift rows). These match RBAC
--     exactly (`hr.employee.manage` excludes finance; nobody has a
--     self-service "edit my own payroll line" permission) — legitimate
--     narrower write permissions, not a missing arm for a role that
--     actually needs to write.
--   - `surat_jalan_scope` was the only real instance of the reported shape.
--
-- Fix: add the missing destination-outlet arm to WITH CHECK, identical to
-- the one USING already has (201/213/214). Safe against the 213 INSERT-time
-- blind spot: this arm only ever needs to pass for an UPDATE on an
-- ALREADY-EXISTING, already-committed row (marking a header 'completed'
-- happens well after the SJ and its drops were created in earlier,
-- separate commands) — `app_sj_locations()`'s snapshot blind spot is
-- specific to a row inserted earlier in the SAME command, which does not
-- apply here.
-- Created at: 2026-08-17

BEGIN;

DROP POLICY IF EXISTS surat_jalan_scope ON surat_jalan;
CREATE POLICY surat_jalan_scope ON surat_jalan FOR ALL
  USING (
    app_has_location(origin_location_id)
    OR EXISTS (SELECT 1 FROM unnest(app_sj_locations(surat_jalan.id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  )
  WITH CHECK (
    app_has_location(origin_location_id)
    OR EXISTS (SELECT 1 FROM unnest(app_sj_locations(surat_jalan.id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  );

COMMIT;
