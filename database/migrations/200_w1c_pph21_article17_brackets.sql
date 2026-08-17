-- Migration: 200_w1c_pph21_article17_brackets
-- Fix block: 2xx (post-authoring addition to block 060-069, D-18 statutory
--             payroll). Coordinator-directed: the December Article-17
--             true-up (CONTRACTS.md §4.15, in-scope per employee_tax_profiles
--             comment in migration 068) had no rate table of its own —
--             without one the progressive brackets would end up hardcoded in
--             the packages/shared calculator, defeating D-18's premise that
--             every statutory rate is effective-dated and client-maintained.
--             Same shape as its siblings pph21_ter_rates / pph21_ptkp (067):
--             bracket min/max, rate, effective_from/to, UNIQUE on the
--             effective-date key. Unlike TER rates, Article 17 is a single
--             national progressive schedule — no TER-category dimension.
-- Created at: 2026-08-17

BEGIN;

CREATE TABLE pph21_article17_brackets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bracket_min NUMERIC(18,2) NOT NULL,            -- annual net (PKP) lower bound (inclusive)
  bracket_max NUMERIC(18,2),                     -- upper bound (exclusive); NULL = open-ended top bracket
  rate_pct NUMERIC(6,3) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,                             -- NULL = current
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bracket_min, effective_from)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON pph21_article17_brackets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE INDEX idx_pph21_article17_brackets_effective ON pph21_article17_brackets(effective_from DESC);

-- Seed the current (2026) national Article-17 schedule so the December
-- true-up calculator has real rows to read out of the box.
INSERT INTO pph21_article17_brackets (bracket_min, bracket_max, rate_pct, effective_from) VALUES
  (0.00,           60000000.00,  5.000, '2022-01-01'),
  (60000000.00,    250000000.00, 15.000, '2022-01-01'),
  (250000000.00,   500000000.00, 25.000, '2022-01-01'),
  (500000000.00,   5000000000.00, 30.000, '2022-01-01'),
  (5000000000.00,  NULL,         35.000, '2022-01-01')
ON CONFLICT (bracket_min, effective_from) DO NOTHING;

-- No RLS (§1.14 "NONE" group, consistent with its siblings pph21_ter_rates /
-- pph21_ptkp / bpjs_configs): statutory config, API-gated via
-- payroll.statutory.read / payroll.statutory.config.

COMMIT;
