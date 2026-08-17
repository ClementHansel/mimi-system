-- Migration: 219_w1c_matview_refresh_function
-- Fix block: 2xx. Production blocker found live while building the
--             dashboard: all four materialized views (100) are owned by the
--             migration/admin role ('mimi'), and REFRESH MATERIALIZED VIEW
--             requires ownership (or superuser) — `app_user` got
--             `must be owner of materialized view mv_sales_daily`.
--             `MatviewRefreshService`'s 5-minute auto-refresh and its
--             manual `POST /refresh` endpoint both catch the error per view
--             and log rather than crash (good defensive design), which
--             means both paths were silently no-op-ing: revenue, top
--             products, staff KPI, and the delivery recap dashboards would
--             freeze at whatever the migration last built, with nothing
--             surfaced to anyone. Same failure shape as D-22: a security
--             boundary silently disabling a feature instead of visibly
--             blocking it.
--
-- CHOICE MADE: a SECURITY DEFINER refresh function, not a change of
-- ownership — the same pattern used three times already
-- (app_sj_locations, app_offline_credential_for_verification,
-- app_user_display), for the same reason each time: it keeps DDL-adjacent
-- rights (matview ownership carries DROP/ALTER, not just REFRESH) off the
-- runtime role, leaving `mimi_app`/`app_user` able to do exactly one new
-- thing — refresh these four specific views — rather than everything an
-- owner can do to them.
--
-- Supports REFRESH ... CONCURRENTLY, which is what MatviewRefreshService
-- actually calls (confirmed necessary, not assumed): a plain (non-
-- concurrent) refresh takes an ACCESS EXCLUSIVE lock and would stall every
-- dashboard read for the duration, unacceptable for a 5-minute auto-refresh
-- on a system with concurrent readers. CONCURRENTLY needs the unique index
-- each view already has (100_reporting_matviews.sql) — already satisfied.
--
-- One function, not four: takes the view name and validates it against a
-- fixed allow-list before running dynamic SQL, so the caller's existing
-- per-view loop (and its existing try/catch-per-view error handling) keeps
-- working unchanged — a failure refreshing one view still doesn't touch
-- the other three's ability to be called, exactly the current behavior
-- `MatviewRefreshService` already relies on.
-- Created at: 2026-08-17

BEGIN;

CREATE FUNCTION refresh_dashboard_matview(p_view_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_view_name NOT IN ('mv_sales_daily', 'mv_item_usage_daily', 'mv_employee_kpi_daily', 'mv_delivery_recap_daily') THEN
    RAISE EXCEPTION 'refresh_dashboard_matview: % is not a recognized dashboard materialized view', p_view_name;
  END IF;
  EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', p_view_name);
END;
$$;

REVOKE ALL ON FUNCTION refresh_dashboard_matview(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_dashboard_matview(TEXT) TO app_user;

COMMIT;
