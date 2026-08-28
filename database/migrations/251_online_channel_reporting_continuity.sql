-- Migration: 251_online_channel_reporting_continuity
-- Block: 100-109 lineage (reporting rollups), filed as a 2xx fix per
--        database/README.md's "applied migrations are never edited" rule.
-- Description: teaches `mv_sales_daily` (100) about `sales.channel`
--              (migration 249) so the online-vs-walk-in split it drives does
--              not silently flatline the moment GoFood/ShopeeFood orders
--              stop being written to `online_orders`.
-- Created at: 2026-08-27
--
-- THE BUG THIS FIXES
-- --------------------------------------------------------------------------
-- `mv_sales_daily` (100) UNIONs `sales` (grouped with `platform` hardcoded to
-- NULL) with `online_orders` (grouped BY `platform`) — `platform IS NOT NULL`
-- is the matview's only signal for "this bucket is online revenue", used
-- directly by `OverviewService.revenueOnline`, `OutletsService.onlineNet`
-- (both `dashboard`), and indirectly by every consumer of `mv_sales_daily`.
--
-- Migration 249 retired `online_orders` as a write path: GoFood/ShopeeFood
-- orders are now ordinary POS `sales` rows with `channel IN ('gofood',
-- 'shopeefood')`. Total revenue is unaffected (only one path posts now), but
-- the ONLINE SPLIT breaks from this migration's effective date forward: new
-- channel sales land in the `sales` branch, which still hardcodes
-- `platform` to NULL, so they get silently counted as WALK-IN. Nobody sees
-- an error — `revenueOnline` and every dependent figure just stop growing.
--
-- THE FIX
-- --------------------------------------------------------------------------
-- The `sales` branch's `platform` column becomes `NULLIF(channel, 'walk_in')`
-- instead of a hardcoded NULL — `channel`'s own CHECK constraint (249)
-- guarantees the only non-walk_in values are `'gofood'`/`'shopeefood'`, the
-- exact same domain `online_orders.platform` already used, so every existing
-- `platform IS NOT NULL` filter downstream keeps working with NO application
-- code changes for the matview-backed reads (`OverviewService`,
-- `OutletsService`, `SalesReportService.groupFromMatview`, `TrendService`).
--
-- `online_orders` stays in the UNION exactly as before — its write path is
-- retired (249), not its READ path, and it holds every pre-cutover GoFood/
-- ShopeeFood order that will NEVER exist as a `sales` row (that flow simply
-- didn't create one). Dropping this branch would leave a permanent cliff:
-- the online series would read correctly up to the cutover date and zero
-- from then on. Keeping it makes the series CONTINUOUS across the cutover —
-- exactly the "cutover, not a replacement" framing 249's own header uses.
--
-- WHY THE WHOLE UNION IS RE-AGGREGATED IN AN OUTER GROUP BY (not just two
-- `UNION ALL` branches, which is all 100's original had)
-- --------------------------------------------------------------------------
-- The two branches are no longer guaranteed disjoint on
-- `(location_id, sales_date, platform)`. Before this migration, `sales` only
-- ever produced `platform = NULL` rows and `online_orders` only ever
-- produced `platform IS NOT NULL` rows — disjoint by construction, so a
-- plain `UNION ALL` could never collide with `uq_mv_sales_daily`'s unique
-- index. Now the `sales` branch can ALSO produce a `platform = 'gofood'`
-- row for a given `(location_id, date)`, and if that SAME outlet had a
-- legacy `online_orders` row for GoFood on that SAME calendar date (fully
-- possible right at the cutover boundary, and exactly the scenario this
-- migration's own verification block and the backend's continuity test
-- construct on purpose), a bare `UNION ALL` would emit two rows for one key
-- and `CREATE UNIQUE INDEX uq_mv_sales_daily` would fail outright — not a
-- silent bug, a hard migration failure. Wrapping both branches in one outer
-- `SELECT ... GROUP BY location_id, sales_date, platform` with `SUM()` over
-- each branch's own pre-aggregated columns collapses any such overlap into
-- one correctly-summed row instead, with no double count (the two source
-- tables never describe the same underlying order) and no lost row.
--
-- NO APPLICATION CODE CHANGE REQUIRED FOR THIS HALF OF THE BUG
-- --------------------------------------------------------------------------
-- `OverviewService.revenueOnline`, `OutletsService.onlineNet`, and
-- `SalesReportService.groupFromMatview` all read `mv_sales_daily.platform`
-- via `FILTER (WHERE platform IS NOT NULL)` / a bare `platform` column with
-- no other reference to the retired `online_orders` write path — fixing the
-- view fixes all three transparently. The POS shift-close report
-- (`PosShiftService.buildReport` / `ShiftReportService.getShiftReport`) and
-- `SalesReportService.groupByMethod`'s online arm do NOT read this matview
-- (per-shift and per-payment-method grain is finer than the matview
-- carries) — those are fixed in the companion backend change, not here.

BEGIN;

DROP MATERIALIZED VIEW mv_sales_daily;

CREATE MATERIALIZED VIEW mv_sales_daily AS
  SELECT
    location_id,
    sales_date,
    platform,
    SUM(tx_count) AS tx_count,
    SUM(gross) AS gross,
    SUM(discounts) AS discounts,
    SUM(voided_amount) AS voided_amount
  FROM (
    -- POS branch (migration 051) — now channel-aware: `platform` carries the
    -- sale's `channel` (249) whenever it is NOT the walk-in default, so a
    -- GoFood/ShopeeFood sale rung up through the ordinary till counts as
    -- online here exactly like a legacy `online_orders` row did.
    SELECT
      location_id,
      (occurred_at AT TIME ZONE 'Asia/Makassar')::date AS sales_date,
      NULLIF(channel, 'walk_in')::varchar(20) AS platform,
      COUNT(*) FILTER (WHERE status = 'completed') AS tx_count,
      COALESCE(SUM(total) FILTER (WHERE status = 'completed'), 0) AS gross,
      COALESCE(SUM(discount), 0) AS discounts,
      COALESCE(SUM(total) FILTER (WHERE status IN ('voided', 'refunded')), 0) AS voided_amount
    FROM sales
    GROUP BY 1, 2, 3
    UNION ALL
    -- Retired write path (249), live read path — every pre-cutover GoFood/
    -- ShopeeFood order lives ONLY here; keeping this branch is what makes
    -- the online series continuous instead of cliff-then-flatline.
    SELECT
      location_id,
      order_date AS sales_date,
      platform,
      COUNT(*) FILTER (WHERE status = 'completed') AS tx_count,
      COALESCE(SUM(net_received) FILTER (WHERE status = 'completed'), 0) AS gross,
      COALESCE(SUM(discount_amount), 0) AS discounts,
      COALESCE(SUM(net_received) FILTER (WHERE status = 'cancelled'), 0) AS voided_amount
    FROM online_orders
    GROUP BY 1, 2, 3
  ) combined
  GROUP BY location_id, sales_date, platform;

CREATE UNIQUE INDEX uq_mv_sales_daily ON mv_sales_daily(location_id, sales_date, platform);

COMMENT ON MATERIALIZED VIEW mv_sales_daily IS
  'FR-DASH-01/02/03 daily rollup, grain (location_id, sales_date, platform). platform NULL = walk-in; platform IN (gofood, shopeefood) = online, sourced from sales.channel from migration 251 forward (NULLIF(channel,''walk_in'')) and from the now-dormant online_orders for everything before it (migration 249 retired that write path but left the table readable) — the two are UNIONed and re-aggregated so the online series is continuous across the cutover, never a source-swap cliff.';

-- Ownership/grants belong with the DDL role (`mimi`, per migration 236's
-- established pattern) — DROP + CREATE resets both, so both are re-asserted
-- explicitly rather than assumed to survive.
DO $$
BEGIN
  IF (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'mv_sales_daily'::regclass) <> 'mimi' THEN
    ALTER MATERIALIZED VIEW mv_sales_daily OWNER TO mimi;
  END IF;
END $$;

GRANT SELECT ON mv_sales_daily TO app_user;

-- `refresh_dashboard_matview` (219) allow-lists by NAME, unaffected by this
-- migration keeping the same name — re-stated here only so a reader doesn't
-- have to go check: no change needed to that function.

-- ── Verification: the rebuilt view must not come back empty when its
-- sources have data, and — the actual point of this migration — must be
-- able to hold BOTH a pre-cutover online_orders row and a post-cutover
-- sales.channel row for the SAME (location, date, platform) key without the
-- unique index rejecting it and without silently dropping one side's money.
-- ============================================================================
DO $$
DECLARE
  sales_n bigint;
  online_n bigint;
  mv_n bigint;
  test_location UUID;
  test_shift UUID;
  test_sale_id UUID := gen_random_uuid();
  test_online_id UUID := gen_random_uuid();
  test_date DATE := '2019-03-14'; -- far from any seeded/live date, matches this repo's other live-DB test convention
  mv_gross NUMERIC;
  mv_tx INTEGER;
BEGIN
  SELECT count(*) INTO sales_n FROM sales;
  SELECT count(*) INTO online_n FROM online_orders;
  SELECT count(*) INTO mv_n FROM mv_sales_daily;
  IF (sales_n > 0 OR online_n > 0) AND mv_n = 0 THEN
    RAISE EXCEPTION 'mv_sales_daily rebuilt empty (sales=%, online_orders=%) — the new SELECT body is broken', sales_n, online_n;
  END IF;

  -- Same-day collision proof: fabricate one online_orders row (pre-cutover
  -- shape) and one sales row with channel='gofood' (post-cutover shape) for
  -- the SAME location/date/platform, refresh, and confirm both contribute
  -- to ONE summed row rather than the unique index rejecting the refresh.
  SELECT id INTO test_location FROM locations WHERE type = 'outlet' LIMIT 1;
  IF test_location IS NOT NULL THEN
    INSERT INTO pos_shifts (id, shift_number, location_id, opened_by, opened_at, opening_cash, status, client_id)
      SELECT gen_random_uuid(), 'MIG251-TEST', test_location, u.id, test_date::timestamp AT TIME ZONE 'Asia/Makassar', 0, 'closed', gen_random_uuid()
        FROM users u WHERE u.is_active LIMIT 1
      RETURNING id INTO test_shift;

    INSERT INTO sales (id, receipt_number, client_id, location_id, shift_id, kasir_id, status, subtotal, discount, total, paid_amount, change_amount, occurred_at, channel)
      SELECT test_sale_id, 'MIG251-TEST', gen_random_uuid(), test_location, test_shift, opened_by, 'completed', 10000, 0, 10000, 10000, 0,
             test_date::timestamp AT TIME ZONE 'Asia/Makassar', 'gofood'
        FROM pos_shifts WHERE id = test_shift;

    INSERT INTO online_orders (id, client_id, location_id, platform, order_ref, order_date, gross_amount, net_received, status, recorded_by, shift_id)
      SELECT test_online_id, gen_random_uuid(), test_location, 'gofood', 'MIG251-TEST', test_date, 5000, 5000, 'completed', opened_by, test_shift
        FROM pos_shifts WHERE id = test_shift;

    PERFORM refresh_dashboard_matview('mv_sales_daily');

    SELECT gross, tx_count INTO mv_gross, mv_tx
      FROM mv_sales_daily WHERE location_id = test_location AND sales_date = test_date AND platform = 'gofood';

    IF mv_gross IS DISTINCT FROM 15000.00 THEN
      RAISE EXCEPTION 'mv_sales_daily continuity check failed: expected gross 15000.00 (10000 sales.channel + 5000 online_orders on the same day/platform), got %', mv_gross;
    END IF;
    IF mv_tx IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'mv_sales_daily continuity check failed: expected tx_count 2, got %', mv_tx;
    END IF;

    -- Clean up the fabricated rows — this block proves the view CAN merge
    -- both sources correctly, it is not meant to leave test data behind.
    DELETE FROM online_orders WHERE id = test_online_id;
    DELETE FROM sales WHERE id = test_sale_id;
    DELETE FROM pos_shifts WHERE id = test_shift;
    PERFORM refresh_dashboard_matview('mv_sales_daily');

    RAISE NOTICE 'mv_sales_daily continuity check passed: a same-day online_orders row and sales.channel row summed correctly (15000.00 / 2 tx) and the unique index held.';
  ELSE
    RAISE NOTICE 'mv_sales_daily continuity check skipped: no outlet location found (empty database).';
  END IF;
END $$;

COMMIT;
