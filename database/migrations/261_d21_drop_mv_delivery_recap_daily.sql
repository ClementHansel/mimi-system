-- Migration: 261_d21_drop_mv_delivery_recap_daily
-- Block: 2xx (fixes)
-- Description: D-21 — drop `mv_delivery_recap_daily`; nothing reads it and its
--              grain makes it unsafe to aggregate.
--
--              THE GRAIN PROBLEM. The view is keyed
--              (planned_date, city, shipment_type, item_id) and carries
--              sj_count/drop_count/outlet_count alongside qty. Those counters
--              are correct WITHIN a row — they are COUNT(DISTINCT ...), which
--              is what migration 100's header was careful about. They are
--              wrong the moment anyone SUMs them, because the same Surat Jalan
--              appears once per item on it. Two grains live in one view:
--              counts belong at (date, city, type), quantities at
--              (date, city, type, item).
--
--              That is a shape that reads as usable and is not. Nobody caught
--              it from the definition; two agents caught it independently by
--              trying to use it, and both then avoided it in writing:
--              `report/services/delivery-report.service.ts` queries the base
--              tables "despite the ticket's data-source note pointing at"
--              this view, and `dashboard/services/ops-status.service.ts:77`
--              records an explicit instruction that its counter must NOT come
--              from here.
--
--              So it has no consumers — only a refresher keeping it warm every
--              five minutes. A materialized view that is refreshed and never
--              read is pure write amplification, and one whose obvious use is
--              silently wrong is worse than absent: the next person to find it
--              will reasonably SUM it.
--
--              DROPPED RATHER THAN RESHAPED. Fixing the grain means splitting
--              it in two, i.e. building two views for nobody. FR-LOG-04 is
--              served by `RecapService.dailyRecap()`, which reads the base
--              tables and now has a behavioural test (MA-9) asserting exact
--              counts and the DISTINCT-destination/summed-quantity pairing
--              this view got wrong. If a future workload needs the
--              precomputation, re-add it as TWO views at their own grains —
--              not one at both.
-- Created at: 2026-08-29

BEGIN;

DROP MATERIALIZED VIEW IF EXISTS mv_delivery_recap_daily;

-- The refresh helper's allow-list named the view; a REFRESH call for it would
-- now fail on a missing relation instead of the legible "not a recognized
-- dashboard materialized view". Redefined with the three views that remain.
CREATE OR REPLACE FUNCTION refresh_dashboard_matview(p_view_name TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_view_name NOT IN ('mv_sales_daily', 'mv_item_usage_daily', 'mv_employee_kpi_daily') THEN
    RAISE EXCEPTION 'refresh_dashboard_matview: % is not a recognized dashboard materialized view', p_view_name;
  END IF;
  EXECUTE format('REFRESH MATERIALIZED VIEW CONCURRENTLY %I', p_view_name);
END;
$$;

REVOKE ALL ON FUNCTION refresh_dashboard_matview(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION refresh_dashboard_matview(TEXT) TO app_user;

COMMIT;
