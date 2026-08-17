-- Migration: 100_reporting_matviews
-- Block: 100-109 (reporting rollups)
-- Description: the 4 materialized views named in CONTRACTS.md §1.11. Per the
--              contract, "exact SELECT bodies are W1-C's to finalize; the
--              grains and column names above are contract for M18/M19" — the
--              bodies below are this agent's implementation of that contract.
--              Refreshed CONCURRENTLY every 5 min by a backend scheduler
--              (M18/M19 read-only consumers); each gets the unique index
--              CONCURRENTLY refresh requires.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- mv_sales_daily — FR-DASH-01/02/03: per location per day, POS + online
-- unioned on the same grain (platform NULL for POS rows).
-- =============================================================================

CREATE MATERIALIZED VIEW mv_sales_daily AS
  SELECT
    location_id,
    (occurred_at AT TIME ZONE 'Asia/Makassar')::date AS sales_date,
    NULL::varchar(20) AS platform,
    COUNT(*) FILTER (WHERE status = 'completed') AS tx_count,
    COALESCE(SUM(total) FILTER (WHERE status = 'completed'), 0) AS gross,
    COALESCE(SUM(discount), 0) AS discounts,
    COALESCE(SUM(total) FILTER (WHERE status IN ('voided', 'refunded')), 0) AS voided_amount
  FROM sales
  GROUP BY 1, 2
UNION ALL
  SELECT
    location_id,
    order_date AS sales_date,
    platform,
    COUNT(*) FILTER (WHERE status = 'completed') AS tx_count,
    COALESCE(SUM(net_received) FILTER (WHERE status = 'completed'), 0) AS gross,
    COALESCE(SUM(discount_amount), 0) AS discounts,
    COALESCE(SUM(net_received) FILTER (WHERE status = 'cancelled'), 0) AS voided_amount
  FROM online_orders
  GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX uq_mv_sales_daily ON mv_sales_daily(location_id, sales_date, platform);

-- =============================================================================
-- mv_item_usage_daily — FR-POS-06 usage estimate + FR-LOG-08/19 patterns
-- =============================================================================

CREATE MATERIALIZED VIEW mv_item_usage_daily AS
  SELECT
    location_id,
    item_id,
    (occurred_at AT TIME ZONE 'Asia/Makassar')::date AS usage_date,
    SUM(qty) AS qty_used
  FROM stock_movements
  WHERE movement_type = 'usage_out'
  GROUP BY 1, 2, 3;

CREATE UNIQUE INDEX uq_mv_item_usage_daily ON mv_item_usage_daily(location_id, item_id, usage_date);

-- =============================================================================
-- mv_employee_kpi_daily — FR-DASH-03 performa kasir + kehadiran, one row per
-- employee per attendance date (NULL date = employee with no attendance yet).
-- =============================================================================

CREATE MATERIALIZED VIEW mv_employee_kpi_daily AS
  SELECT
    e.id AS employee_id,
    e.location_id,
    a.date AS kpi_date,
    a.status AS attendance_status,
    COALESCE(a.late_minutes, 0) AS late_minutes,
    COALESCE(a.overtime_minutes, 0) AS overtime_minutes,
    COUNT(s.id) AS sales_count,
    COALESCE(SUM(s.total) FILTER (WHERE s.status = 'completed'), 0) AS sales_amount
  FROM employees e
  LEFT JOIN attendance a ON a.employee_id = e.id
  LEFT JOIN sales s
    ON s.kasir_id = e.user_id
   AND (s.occurred_at AT TIME ZONE 'Asia/Makassar')::date = a.date
  GROUP BY e.id, e.location_id, a.date, a.status, a.late_minutes, a.overtime_minutes;

CREATE UNIQUE INDEX uq_mv_employee_kpi_daily ON mv_employee_kpi_daily(employee_id, kpi_date);

-- =============================================================================
-- mv_delivery_recap_daily — FR-LOG-04 rekap harian tim logistik: per planned
-- date x destination city x shipment type x item, so the API layer (M19) can
-- fold this up into the byCity/items nested shape without re-scanning SJ
-- tables. sj_count/drop_count/outlet_count are counted DISTINCT so the
-- per-item fan-out (one row per item on the drop) does not inflate them.
-- =============================================================================

CREATE MATERIALIZED VIEW mv_delivery_recap_daily AS
  SELECT
    sj.planned_date,
    l.city,
    st.key AS shipment_type,
    sl.item_id,
    i.name AS item_name,
    COUNT(DISTINCT sj.id) AS sj_count,
    COUNT(DISTINCT d.id) AS drop_count,
    COUNT(DISTINCT d.location_id) AS outlet_count,
    COALESCE(SUM(sl.qty), 0) AS qty
  FROM surat_jalan sj
  JOIN shipment_types st ON st.id = sj.shipment_type_id
  JOIN sj_drops d ON d.sj_id = sj.id
  JOIN locations l ON l.id = d.location_id
  LEFT JOIN sj_lines sl ON sl.sj_id = sj.id AND sl.drop_id = d.id
  LEFT JOIN items i ON i.id = sl.item_id
  GROUP BY sj.planned_date, l.city, st.key, sl.item_id, i.name;

CREATE UNIQUE INDEX uq_mv_delivery_recap_daily
  ON mv_delivery_recap_daily(planned_date, city, shipment_type, item_id);

COMMIT;
