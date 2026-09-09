-- Migration: 267_pv_paid_posting_rules
-- Block: 090-099 subject (accounting posting rules; numbered at the tail per
--        the sequential-migration convention, not renumbered into 093)
-- Description: the posting rules a `payment_verifications` row needs when it
--              reaches `paid`. Before this, five of the ten `ref_type` values
--              posted NOTHING to the general ledger on payment.
-- Created at: 2026-09-09
--
-- ## Why this exists
--
-- A client asked why "Penerima", "Lokasi" and "Dibayar" stayed blank on a
-- payment voucher they had just marked paid, and was told "seharusnya abis itu
-- system akan log di ledger". It does not. `PaymentVerificationsService
-- .publishPaymentJournal` dispatched on `ref_type` and let five of the ten
-- values fall into a `default:` that returns without publishing anything, on
-- the stated grounds that "the ORIGINATING module already posts" the entry.
-- That is true for exactly one of them (`petty_cash`'s expense leg, JOUT-07/08)
-- and false for the rest:
--
--   * `purchase_order` — JGUD-01 credits 2000 Hutang Supplier at receipt.
--     NOTHING in §6.2/§6.3 ever debits it back except JGUD-04 (retur ke
--     supplier). So paying a supplier never cleared the payable and never
--     recorded the bank outflow: `Hutang Supplier` grew monotonically and cash
--     was overstated by every supplier payment ever made.
--   * `maintenance_job` — `jobs.service.ts` posts no journal at completion at
--     all, only the PV (FR-ACCT-04). 6200 Beban Maintenance is seeded in
--     migration 090 and was referenced by NO posting rule, so maintenance
--     cost never reached the P&L in any form.
--   * `incentive` / `thr` — employee compensation outside a payroll run, so no
--     X1 accrual against 2100 exists to settle. Never posted either.
--   * `employee_loan` — migration 259 added this `ref_type`, and
--     `loans.service.ts` writes it, but the dispatch switch never had a case
--     for it. The `employee_loan_disbursement` rule seeded in 093 was
--     therefore unreachable: it was keyed off a `#kind:` marker in `notes`
--     that NO production code has ever written.
--   * `petty_cash` — the expense leg does post at verify (JOUT-07/08, Cr 1010
--     Kas Kecil), but that DRAWS DOWN the float. Paying the PV is what
--     restores it (Dr 1010 / Cr 1020) — the `petty_cash_topup` rule, also
--     seeded in 093 and also unreachable behind the same dead marker. Kas
--     Kecil therefore drifted down forever and was never replenished in the
--     books.
--
-- Three rules are genuinely new (below). The other two already existed in 093
-- and needed only the code-side wiring, which lands with this migration.
--
-- ## Not backfilled
--
-- This seeds rules; it posts nothing historical. Existing `paid` PVs stay
-- unposted — deliberately, per `gl-coverage.service.ts`'s standing position
-- that backfilling production is the owner's decision, not a migration's. A
-- `payment_verification` probe is added to that report in the same change so
-- the size of the hole is now measurable before anyone decides.

BEGIN;

INSERT INTO posting_rules (event_type, rule_seq, condition, debit_account_code, credit_account_code, amount_source, description_template) VALUES
  -- Supplier payment: settles the JGUD-01 payable. Split by `paid_via` exactly
  -- like JOUT-09's two rows, the existing precedent for a cash-vs-bank credit.
  ('supplier_payment', 1, '{"paidVia":"bank_transfer"}', '2000', '1020', 'pv_amount', 'Pembayaran hutang supplier (transfer bank)'),
  ('supplier_payment', 2, '{"paidVia":"cash"}', '2000', '1000', 'pv_amount', 'Pembayaran hutang supplier (tunai)'),
  ('supplier_payment', 3, '{"paidVia":"qris"}', '2000', '1020', 'pv_amount', 'Pembayaran hutang supplier (QRIS)'),
  -- Maintenance: expense recognized at payment (no accrual leg exists).
  ('maintenance_payment', 1, '{"paidVia":"bank_transfer"}', '6200', '1020', 'pv_amount', 'Pembayaran maintenance (transfer bank)'),
  ('maintenance_payment', 2, '{"paidVia":"cash"}', '6200', '1000', 'pv_amount', 'Pembayaran maintenance (tunai)'),
  ('maintenance_payment', 3, '{"paidVia":"qris"}', '6200', '1020', 'pv_amount', 'Pembayaran maintenance (QRIS)'),
  -- Incentive / THR: compensation outside a payroll run, so 6000 direct.
  ('employee_compensation_payment', 1, '{"paidVia":"bank_transfer"}', '6000', '1020', 'pv_amount', 'Pembayaran insentif/THR (transfer bank)'),
  ('employee_compensation_payment', 2, '{"paidVia":"cash"}', '6000', '1000', 'pv_amount', 'Pembayaran insentif/THR (tunai)'),
  ('employee_compensation_payment', 3, '{"paidVia":"qris"}', '6000', '1020', 'pv_amount', 'Pembayaran insentif/THR (QRIS)')
ON CONFLICT (event_type, rule_seq) DO NOTHING;

COMMIT;
