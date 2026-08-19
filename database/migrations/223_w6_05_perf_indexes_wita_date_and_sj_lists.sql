-- =============================================================================
-- W6-05 — indexes for the two filter shapes the app actually issues.
--
-- Found by the perf pass, confirmed by reading the queries rather than guessing:
-- in both cases an index existed on the right COLUMN but could not serve the
-- right EXPRESSION or column ORDER, so the planner fell back to a seq scan or a
-- bitmap-AND of two single-column indexes.
--
-- Plain CREATE INDEX, not CONCURRENTLY: `migrate.ts` sends each file to
-- `client.query(sql)` as ONE multi-statement simple query, which Postgres runs
-- in an implicit transaction — and CONCURRENTLY cannot run inside one. (The
-- runner itself issues no BEGIN; the transaction is Postgres's, not its.) These tables are small
-- today. If a table here ever grows past a few million rows, this file is the
-- precedent to NOT follow — build it concurrently, outside the runner.
-- =============================================================================

-- ── 1. The WITA business-day filter (NFR-10) ────────────────────────────────
-- Three list endpoints filter on the business DATE, not the instant:
--     (occurred_at AT TIME ZONE 'Asia/Makassar')::date = $n::date
-- but the only indexes were on the bare timestamptz column, which that
-- expression cannot use — every "today's sales" read was a seq scan.
--
-- Safe as an index expression because both halves are IMMUTABLE: the column is
-- TIMESTAMPTZ and the zone is a literal, so `timezone(text, timestamptz)`
-- returns a plain timestamp with no dependency on the session TimeZone. This
-- would NOT be immutable if the column were `timestamp without time zone`.
CREATE INDEX idx_sales_wita_date ON sales (((occurred_at AT TIME ZONE 'Asia/Makassar')::date));
CREATE INDEX idx_pos_shifts_wita_date ON pos_shifts (((opened_at AT TIME ZONE 'Asia/Makassar')::date));
CREATE INDEX idx_void_refunds_wita_date ON void_refunds (((occurred_at AT TIME ZONE 'Asia/Makassar')::date));

-- ── 2. Surat jalan list ordering ────────────────────────────────────────────
-- `SuratJalanService.list` always ends `ORDER BY sj.planned_date DESC,
-- sj.created_at DESC` and optionally filters on status and/or planned_date.
-- With only single-column indexes the planner had to sort every time.
CREATE INDEX idx_surat_jalan_planned_created ON surat_jalan (planned_date DESC, created_at DESC);
CREATE INDEX idx_surat_jalan_status_planned ON surat_jalan (status, planned_date DESC, created_at DESC);

-- The driver's own list (`myJobs`) filters driver_id [+ planned_date] and
-- orders by planned_date — one index instead of a filter-then-sort.
CREATE INDEX idx_surat_jalan_driver_planned ON surat_jalan (driver_id, planned_date);

-- Now redundant: each is a strict leading prefix of a composite created above,
-- so it can only ever be chosen where the composite also works, while still
-- costing every INSERT/UPDATE.
DROP INDEX IF EXISTS idx_surat_jalan_planned_date;
DROP INDEX IF EXISTS idx_surat_jalan_driver;
