-- Migration: 271_anomaly_panel
-- Block: 2xx (fixes / gaps)
-- Description: the dashboard "Anomali" panel — default thresholds and the
--              table that remembers which anomalies a person has already looked at.
--
--              WHY THIS EXISTS. Importing the client's real April 2026 data
--              surfaced a class of problem their spreadsheets never flagged: one
--              outlet-day of Rp 507M against a ~Rp 17M norm, 1,394 "Sayap" sold on
--              a day it is normally ~0, tea leaves costed 48x what was actually
--              used, an outlet whose stock variance exceeded its closing stock
--              value. The panel catches that class automatically; this migration
--              is its only schema surface.
--
--              NUMBERING. 270 is held by the concurrent `grabfood` channel
--              branch, so this takes 271 (the next free number after it).
--
--              1. `settings` row `anomaly.thresholds` — the per-detector
--                 parameters. `settings` has no RLS and is read through the
--                 existing key/value path (migration 007); the reader in
--                 `modules/dashboard/anomalies/anomaly-thresholds.ts` merges this
--                 row over the in-code defaults and falls back to them for any
--                 missing or out-of-range value, so a hand-edited row can never
--                 stop the panel from loading. The defaults are seeded rather
--                 than left implicit so the owner can see (and the settings
--                 screen can list) what the system is using today.
--
--              2. `anomaly_reviews` — "this finding was looked at". A reviewed
--                 anomaly is hidden by default. Keyed (detector, fingerprint),
--                 where the fingerprint is the detector's stable identity for the
--                 finding (e.g. `<outlet-uuid>:<date>`), so re-running the same
--                 window finds the same fingerprint and keeps it hidden, while a
--                 genuinely new anomaly never matches a previous review.
--
--                 RLS: location-scoped, like every other table that carries a
--                 `location_id` (`app_has_location`). A finding with no outlet
--                 (a company-level ledger account) has `location_id IS NULL`,
--                 which `app_has_location` treats as "not yours" for everyone but
--                 a central role — exactly the visibility the underlying journal
--                 lines have. Writes are further limited to owner/manager/
--                 superadmin, the roles that can open the panel at all.
--
--                 NOT tenant-keyed on purpose: every fingerprint that matters
--                 embeds an outlet uuid (and `locations` carries the tenant), and
--                 the one global shape (`gl:<account-code>`) is gated to central
--                 roles by the policy above. If a second tenant ever shares an
--                 instance (docs/MULTI-TENANCY.md), add `tenant_id` and widen the
--                 unique key then.
--
-- Created at: 2026-10-01

BEGIN;

INSERT INTO settings (key, value, description) VALUES
  ('anomaly.thresholds',
   '{
      "sales_day_outlier":   {"hi": 3, "lo": 0.3, "baselineDays": 28, "minHistoryDays": 5},
      "product_qty_outlier": {"multiple": 5, "minQty": 50},
      "usage_variance":      {"variancePct": 25, "minValue": 500000, "periodPctOfSales": 5},
      "price_deviation":     {"sharePct": 10, "minLines": 3},
      "payroll_outlier":     {"netBelowBasePct": 25, "deductionsAboveGrossPct": 50},
      "gl_sanity":           {"cashGrowthDays": 7, "minAbsBalance": 100000},
      "settlement_gap":      {"gapPct": 20, "minGapAmount": 100000}
    }',
   'Dashboard Anomali panel: per-detector thresholds. Missing or out-of-range values fall back to the in-code defaults.')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE anomaly_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  detector VARCHAR(40) NOT NULL,
  -- The detector's stable identity for one finding, e.g. '<outlet>:<YYYY-MM-DD>'.
  fingerprint TEXT NOT NULL,
  -- NULL for a finding that belongs to no outlet (a company-level ledger account).
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  reviewed_by UUID NOT NULL REFERENCES users(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  note TEXT,
  UNIQUE (detector, fingerprint)
);

CREATE INDEX idx_anomaly_reviews_location ON anomaly_reviews(location_id);

COMMENT ON TABLE anomaly_reviews IS
  'A person marked this dashboard anomaly as reviewed. Hidden by default; keyed by the detector''s stable fingerprint so the same finding stays hidden when the window is re-run.';

ALTER TABLE anomaly_reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomaly_reviews FORCE ROW LEVEL SECURITY;

CREATE POLICY anomaly_reviews_select ON anomaly_reviews FOR SELECT
  USING (app_has_location(location_id) OR (location_id IS NULL AND app_is_central()));

CREATE POLICY anomaly_reviews_insert ON anomaly_reviews FOR INSERT
  WITH CHECK (
    current_setting('app.role', true) = ANY (ARRAY['owner', 'manager', 'superadmin'])
    AND (app_has_location(location_id) OR (location_id IS NULL AND app_is_central()))
  );

CREATE POLICY anomaly_reviews_update ON anomaly_reviews FOR UPDATE
  USING (
    current_setting('app.role', true) = ANY (ARRAY['owner', 'manager', 'superadmin'])
    AND (app_has_location(location_id) OR (location_id IS NULL AND app_is_central()))
  );

CREATE POLICY anomaly_reviews_delete ON anomaly_reviews FOR DELETE
  USING (
    current_setting('app.role', true) = ANY (ARRAY['owner', 'manager', 'superadmin'])
    AND (app_has_location(location_id) OR (location_id IS NULL AND app_is_central()))
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON anomaly_reviews TO app_user;

COMMIT;
