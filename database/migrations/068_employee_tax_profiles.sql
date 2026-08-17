-- Migration: 068_employee_tax_profiles
-- Block: 060-069 (HR & payroll)
-- Description: Amendment 1 (D-18) — per-employee tax/BPJS profile (setup
--              wizard step 3).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE employee_tax_profiles (             -- per-employee tax/BPJS profile (wizard step 3)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID UNIQUE NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  npwp VARCHAR(25),                              -- NULL = no NPWP (calculator applies the non-NPWP surcharge rule)
  ptkp_code VARCHAR(10) NOT NULL DEFAULT 'TK/0', -- validated against pph21_ptkp codes
  dependants_count SMALLINT NOT NULL DEFAULT 0 CHECK (dependants_count BETWEEN 0 AND 3),
  bpjs_enrollments JSONB NOT NULL DEFAULT '{}',  -- {"kesehatan":{"enrolledSince":"2026-01-01","endedAt":null},
                                                  --  "jht":{...},"jkk":{...},"jkm":{...},"jp":{...}} — absent = not enrolled
  bpjs_salary_base NUMERIC(18,2),                -- override base when it differs from employments.base_salary; NULL = use base
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Calculation notes (contract for the packages/shared calculators, W1-B):
--  * Rate row selection: the row whose [effective_from, effective_to] window contains the payroll period end date.
--  * Monthly PPh21 = TER rate (by employee's ter_category via ptkp_code) x monthly gross (statutory definition).
--  * DECEMBER RUN performs the annual true-up: Article-17 progressive tax on annualized income minus PTKP,
--    minus Jan-Nov TER withholdings — in scope of the calculator. Maintaining the annual rate/PTKP tables
--    is the CLIENT'S operational responsibility (Amendment 1).
--  * statutory lines appear ONLY on runs with statutory_mode = true.

CREATE TRIGGER set_updated_at BEFORE UPDATE ON employee_tax_profiles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
