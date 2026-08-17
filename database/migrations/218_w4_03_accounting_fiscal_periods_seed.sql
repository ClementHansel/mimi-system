-- Migration: 218_w4_03_accounting_fiscal_periods_seed
-- Renumbered from 216 on 2026-08-17: three migrations independently landed
-- on 216 in the same session. 216_w1c_fix_surat_jalan_with_check_asymmetry
-- (a production-blocking RLS fix already referenced by number elsewhere)
-- kept 216; this one and the approvals fix moved to 217/218.
-- Block: 090-099 (accounting) — post-G1 fix, W4-03 (senior-be)
-- Description: `fiscal_periods` (migration 091) seeded empty, unlike
--              `chart_of_accounts`/`posting_rules` (090/093, both seeded by
--              W1-C). `JournalService.postManual`/`postSystemEntry` auto-
--              open the calendar-month period for whatever `entry_date` they
--              see (`findOrCreateForDate`), so this is NOT required for the
--              engine to function — but G1 demo data (this migration's
--              sibling change to `database/seed.ts`) needs real
--              `fiscal_periods` rows to reference, and Finance's
--              `GET /api/accounting/periods` should not show an empty list
--              on a freshly-seeded database. Seeds the trailing 3 months
--              through the current demo month (Asia/Makassar, D-11) as
--              'open' — never 'closed'/'locked' (those states only ever
--              reached by an explicit `POST .../periods/:id/close`, never by
--              seed data pretending a close decision was made).
-- Created at: 2026-08-17

BEGIN;

INSERT INTO fiscal_periods (period_code, start_date, end_date, status)
SELECT
  to_char(gs, 'YYYY-MM') AS period_code,
  date_trunc('month', gs)::date AS start_date,
  (date_trunc('month', gs) + INTERVAL '1 month' - INTERVAL '1 day')::date AS end_date,
  'open' AS status
FROM generate_series(
  date_trunc('month', NOW() AT TIME ZONE 'Asia/Makassar') - INTERVAL '2 months',
  date_trunc('month', NOW() AT TIME ZONE 'Asia/Makassar'),
  INTERVAL '1 month'
) AS gs
ON CONFLICT (period_code) DO NOTHING;

COMMIT;
