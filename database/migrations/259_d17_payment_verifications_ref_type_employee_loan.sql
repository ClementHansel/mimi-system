-- Migration: 259_d17_payment_verifications_ref_type_employee_loan
-- Block: 090-099 (accounting)
-- Description: D-17 — `payment_verifications.ref_type` accepts 'employee_loan'.
--              CONTRACTS.md §6.3 names an employee loan disbursement as its own
--              payment reference, and `@mimi/shared` already carries the value
--              (`enums.ts`, alongside `petty_cash_topup` — closed as D-05). The
--              CHECK constraint from migration 094 never listed it, so payroll
--              books a loan disbursement as 'other': the row exists and
--              reconciles, but the queue cannot tell a loan from a
--              miscellaneous payment, and no report can filter on it.
-- Created at: 2026-08-28

BEGIN;

-- Widening only: every value previously accepted is still accepted, so no
-- existing row can be invalidated and the constraint needs no NOT VALID /
-- VALIDATE dance. Postgres has no "add a value to a CHECK" — the constraint is
-- replaced wholesale, which is why the full list is restated here rather than
-- appended to.
ALTER TABLE payment_verifications
  DROP CONSTRAINT payment_verifications_ref_type_check;

ALTER TABLE payment_verifications
  ADD CONSTRAINT payment_verifications_ref_type_check CHECK (ref_type IN (
    'purchase_order',
    'payroll_run',
    'petty_cash',
    'maintenance_job',
    'sale_payment',
    'online_order',
    'incentive',
    'thr',
    'employee_loan',
    'other'
  ));

COMMENT ON COLUMN payment_verifications.ref_type IS
  'What this payment settles. Mirrors CONTRACTS.md §6.3. ''employee_loan'' added '
  'by migration 259 (D-17); loans booked before that migration are recorded as '
  '''other'' and are NOT retro-classified here — doing so would need the loan id '
  'in ref_id, which the ''other'' rows do not carry.';

COMMIT;
