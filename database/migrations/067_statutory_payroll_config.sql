-- Migration: 067_statutory_payroll_config
-- Block: 060-069 (HR & payroll)
-- Description: Amendment 1 (D-18) — optional statutory payroll capability,
--              gated by settings 'payroll.statutory'. All rate tables are
--              EFFECTIVE-DATED (rates change annually; the client maintains
--              them via the §4.15 config endpoints). Nothing here executes
--              unless the flag is ON; the calculators live in
--              packages/shared.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE bpjs_configs (                      -- one row per programme per effective window
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program VARCHAR(20) NOT NULL CHECK (program IN ('kesehatan','jht','jkk','jkm','jp')),
  employer_pct NUMERIC(6,3) NOT NULL,            -- % of base, e.g. kesehatan 4.000, jht 3.700, jp 2.000
  employee_pct NUMERIC(6,3) NOT NULL DEFAULT 0,  -- kesehatan 1.000, jht 2.000, jp 1.000; jkk/jkm employee = 0
  salary_floor NUMERIC(18,2),                    -- min calculation base (e.g. UMK), NULL = none
  salary_cap NUMERIC(18,2),                       -- max calculation base (kesehatan/jp caps), NULL = none
  notes TEXT,                                    -- e.g. chosen JKK risk class rationale
  effective_from DATE NOT NULL,
  effective_to DATE,                             -- NULL = current
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (program, effective_from)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON bpjs_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pph21_ter_rates (                   -- TER (Tarif Efektif Rata-rata) monthly withholding brackets
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(1) NOT NULL CHECK (category IN ('A','B','C')),
  bracket_min NUMERIC(18,2) NOT NULL,            -- monthly gross lower bound (inclusive)
  bracket_max NUMERIC(18,2),                     -- upper bound (exclusive); NULL = open-ended top bracket
  rate_pct NUMERIC(6,3) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category, bracket_min, effective_from)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON pph21_ter_rates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE pph21_ptkp (                        -- PTKP by marital status + dependants; maps status -> TER category
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ptkp_code VARCHAR(10) NOT NULL,                -- 'TK/0'..'TK/3', 'K/0'..'K/3', 'K/I/0'..'K/I/3'
  annual_amount NUMERIC(18,2) NOT NULL,          -- e.g. TK/0 = 54,000,000.00
  ter_category VARCHAR(1) NOT NULL CHECK (ter_category IN ('A','B','C')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ptkp_code, effective_from)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON pph21_ptkp
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
