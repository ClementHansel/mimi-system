-- Migration: 207_w1c_fix_empty_string_uuid_cast
-- Fix block: 2xx. P0 found by W3-01, reproduced live by the coordinator, in
--             a function this agent owns.
--
-- Bug: `set_config('app.user_id', ..., is_local => true)` (i.e. `SET LOCAL
-- app.user_id = ...`) reverts the GUC to '' — not NULL — once the
-- transaction that set it commits or rolls back, because a custom
-- (placeholder) GUC that has been touched in a session has no "unset"
-- state to fall back to. So on a POOLED connection previously used by an
-- authenticated request, `current_setting('app.user_id', true)` returns ''
-- for every subsequent transaction that does not itself call `SET LOCAL
-- app.user_id`, not NULL as the original comment in migration 001 assumed
-- ("current_setting(name, true) so they are NULL ... when unset").
--
-- app_is_self()'s guard was:
--   owner_user_id IS NOT NULL
--   AND current_setting('app.user_id', true) IS NOT NULL
--   AND owner_user_id = current_setting('app.user_id', true)::uuid
-- `'' IS NOT NULL` is TRUE, so evaluation proceeds to `''::uuid`, which
-- raises `invalid input syntax for type uuid: ""` — the query ERRORS
-- instead of evaluating to false. Every policy that calls app_is_self()
-- (drivers, users, sessions, notifications, offline_credentials,
-- employees/employments/attendance/leave_requests/shift_assignments,
-- employee_salary_components/employee_loans/employee_loan_payments,
-- payroll_lines/payroll_runs/payroll_periods, user_locations) is exposed,
-- plus every hand-written driver-assignment clause that used the identical
-- unguarded pattern directly instead of calling app_is_self(): surat_jalan
-- and sj_drops (redefined in 201), and sj_temperature_logs, sj_seals, and
-- sj_lines (still exactly as defined in 037 — 201 only touched
-- surat_jalan/sj_drops). Any system-context path landing on a recycled
-- connection can hit this, including kernel/sync's own device-token routes.
--
-- Fix: treat '' as absent by applying `NULLIF(current_setting(...), '')`
-- BEFORE the ::uuid cast, everywhere this pattern occurs — casting NULL to
-- any type never raises invalid-input-syntax (only parsing a non-null
-- malformed string does), so this also removes the need for the separate
-- "IS NOT NULL" guard entirely: `x = NULLIF(current_setting(...), '')::uuid`
-- is already correctly NULL (⇒ false, for filtering purposes) when the GUC
-- is absent OR empty, with no error either way. `app_has_location()` already
-- used this exact idiom for `app.location_ids` (the coordinator's own
-- observation) — this migration makes `app.user_id` consistent with it.
-- `app_is_central()` and `app_has_location()` were re-audited and need no
-- change: neither ever casts a GUC to ::uuid (app_is_central does a plain
-- string IN-comparison; app_has_location casts its UUID *parameter* to
-- ::text, never the reverse), so '' flows through them as a normal
-- non-matching string, not a cast target.
-- Created at: 2026-08-17

BEGIN;

-- ---------------------------------------------------------------------------
-- The function: fixes every policy that calls app_is_self() in place, with
-- no need to touch those policies themselves.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_is_self(owner_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT
    owner_user_id IS NOT NULL
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- The five policies that hand-wrote the same unguarded pattern instead of
-- calling app_is_self() (their subject is a *related* row's user_id — a
-- driver's — not the row's own, so app_is_self() as written doesn't fit;
-- same fix, applied inline).
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS surat_jalan_scope ON surat_jalan;
CREATE POLICY surat_jalan_scope ON surat_jalan FOR ALL
  USING (
    EXISTS (SELECT 1 FROM unnest(app_sj_locations(surat_jalan.id)) AS loc WHERE app_has_location(loc))
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
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  );

DROP POLICY IF EXISTS sj_drops_scope ON sj_drops;
CREATE POLICY sj_drops_scope ON sj_drops FOR ALL
  USING (
    EXISTS (SELECT 1 FROM unnest(app_sj_locations(sj_drops.sj_id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  )
  WITH CHECK (
    app_has_location(location_id)
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  );

DROP POLICY IF EXISTS sj_temperature_logs_scope ON sj_temperature_logs;
CREATE POLICY sj_temperature_logs_scope ON sj_temperature_logs FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM surat_jalan sj
      WHERE sj.id = sj_temperature_logs.sj_id
        AND (
          app_has_location(sj.origin_location_id)
          OR EXISTS (SELECT 1 FROM sj_drops d WHERE d.sj_id = sj.id AND app_has_location(d.location_id))
          OR (
            current_setting('app.role', true) = 'driver'
            AND EXISTS (
              SELECT 1 FROM drivers dr
              WHERE dr.id = sj.driver_id
                AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
            )
          )
        )
    )
  )
  WITH CHECK (true);  -- inserted by origin/drop/driver actions; app layer picks the correct sj_id

DROP POLICY IF EXISTS sj_seals_scope ON sj_seals;
CREATE POLICY sj_seals_scope ON sj_seals FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM surat_jalan sj
      WHERE sj.id = sj_seals.sj_id
        AND (
          app_has_location(sj.origin_location_id)
          OR EXISTS (SELECT 1 FROM sj_drops d WHERE d.sj_id = sj.id AND app_has_location(d.location_id))
          OR (
            current_setting('app.role', true) = 'driver'
            AND EXISTS (
              SELECT 1 FROM drivers dr
              WHERE dr.id = sj.driver_id
                AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
            )
          )
        )
    )
  )
  WITH CHECK (true);

DROP POLICY IF EXISTS sj_lines_parent ON sj_lines;
CREATE POLICY sj_lines_parent ON sj_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM sj_drops d
      WHERE d.id = sj_lines.drop_id
        AND (
          app_has_location(d.location_id)
          OR EXISTS (SELECT 1 FROM surat_jalan sj WHERE sj.id = d.sj_id AND app_has_location(sj.origin_location_id))
          OR (
            current_setting('app.role', true) = 'driver'
            AND EXISTS (
              SELECT 1 FROM surat_jalan sj
              JOIN drivers dr ON dr.id = sj.driver_id
              WHERE sj.id = d.sj_id
                AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
            )
          )
        )
    )
  )
  WITH CHECK (true);

COMMIT;
