-- Migration: 260_d16_hr_tenure_tiers_setting
-- Block: 2xx (fixes)
-- Description: D-16 — PIN-05 tenure tiers get a settings home.
--
--              CONTRACTS.md §1.7/§2.6 describe the tenure-allowance FORMULA
--              (`tenureAllowance()`, @mimi/shared) but no column ever carried
--              the tier boundaries or amounts: `salary_components
--              .default_amount` is a single flat value, not a tier table. The
--              backend compensated with a private `DEFAULT_TENURE_TIERS`
--              constant inside `runs.service.ts`, whose own comment recorded
--              this as a contract gap awaiting a decision.
--
--              The consequence was not a wrong number — the constant is
--              principled — but that PIN-05 was implemented and NOT
--              configurable. Changing a long-service allowance required a code
--              change and a deploy, and the amounts a real payslip depended on
--              were invisible to the HR staff who are supposed to set them.
--
--              Modelled as a settings key rather than a new table: the tier
--              list is company-wide policy, read once per payroll run, and
--              never joined against. That is exactly what `settings` is for,
--              and it is how `hr.overtime` and `hr.deduction_rates` already
--              carry their own PIN-02/POUT-01 parameters.
--
--              The seeded value is byte-identical to the constant it replaces,
--              so this migration changes no payslip.
-- Created at: 2026-08-29

BEGIN;

-- Note this is the first settings value that is a JSON ARRAY rather than a
-- scalar or a flat object. `settings.value` is JSONB and holds it fine; the
-- structural check in `settings-value-validator.ts` gained an `array` arm in
-- the same change.
INSERT INTO settings (key, value, description) VALUES
  ('hr.tenure_tiers',
   '[{"minYears":5,"amount":"500000.00"},{"minYears":3,"amount":"300000.00"},{"minYears":1,"amount":"100000.00"}]',
   'PIN-05 long-service allowance tiers; highest matching minYears wins (D-16)')
ON CONFLICT (key) DO NOTHING;

COMMIT;
