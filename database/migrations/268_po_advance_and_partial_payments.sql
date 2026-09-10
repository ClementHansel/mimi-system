-- Migration: 268_po_advance_and_partial_payments
-- Block: 090-099 subject (accounting), numbered at the tail per the
--        sequential-migration convention.
-- Description: lets a purchase order be paid BEFORE the goods arrive (uang
--              muka / DP) and in MORE THAN ONE instalment.
-- Created at: 2026-09-10
--
-- ## Why this exists
--
-- Suppliers here routinely refuse to process an order until a down payment
-- lands, and settle the rest in instalments. The schema had no room for
-- either:
--
--   * A PO's voucher was only ever born inside `PurchaseOrderService.receive`
--     (`if (!header.payment_verification_id)`), so nothing was payable until
--     the goods were already in the warehouse. "Pay first, then it ships" was
--     unrepresentable.
--   * `purchase_orders.payment_verification_id` is a single column, and that
--     same guard made it write-once. One PO could have exactly one payment.
--   * `supplier_payment` (migration 267) always posts Dr 2000 Hutang Supplier
--     / Cr cash. Paying before receipt debits a payable that JGUD-01 has not
--     credited yet, driving 2000 to a debit balance and misstating the
--     supplier-payable report for as long as the goods are in transit. There
--     was no advance-to-supplier asset account to hold it instead.
--
-- ## What changes
--
-- `payment_verifications` already carries `ref_type='purchase_order'` +
-- `ref_id = <po.id>`, so MANY vouchers per PO were always representable at the
-- row level — only the FK column and the write-once guard stood in the way.
-- This migration therefore adds no join table. It demotes
-- `purchase_orders.payment_verification_id` to "the first voucher opened for
-- this PO" (kept for the existing RLS/read paths) and makes the aggregate over
-- `ref_id` the real answer to "how much of this PO is paid".
--
--   1. `1130 Uang Muka Pembelian` — the asset that holds a down payment
--      between paying it and receiving the goods it was paid for.
--   2. `payment_verifications.is_advance` — marks a voucher raised before the
--      payable exists. It drives BOTH the journal (1130, not 2000) and the
--      approval chain (owner, always).
--   3. `po_advance` as an approval document type, step 1 = owner with NO
--      `min_amount`. Owner-decided 2026-09-10: money leaving before goods
--      arrive is approved by the Owner at ANY amount, unlike an ordinary
--      `payment_verification` which only escalates at Rp 20.000.000.
--   4. Posting rules for the two new legs (see the account trail below).
--
-- ## The account trail, end to end
--
--   DP dibayar      Dr 1130 Uang Muka      / Cr 1020|1000  (supplier_advance_payment)
--   Barang datang   Dr 1100 Persediaan     / Cr 2000       (gudang_purchase, unchanged)
--   DP diperhitungkan  Dr 2000 Hutang      / Cr 1130       (supplier_advance_offset)
--   Sisa dilunasi   Dr 2000 Hutang         / Cr 1020|1000  (supplier_payment, unchanged)
--
-- Fully prepaid and fully received nets 2000 and 1130 back to zero, leaving
-- exactly the inventory debit and the cash credit. The offset leg is posted by
-- `PurchaseOrderService.receive` for `min(nilai penerimaan, sisa uang muka)`,
-- so a partial receipt only consumes the part of the DP it has earned.
--
-- ## Not backfilled
--
-- `is_advance` defaults false, which is correct for every existing row: they
-- were all raised at receipt, after the payable existed. No historical journal
-- is rewritten here, consistent with migration 267's standing position.

BEGIN;

-- 1 ─────────────────────────────────────────────────────────────────────────
INSERT INTO chart_of_accounts (code, name, type, normal_balance, is_system, is_postable) VALUES
  ('1130', 'Uang Muka Pembelian', 'asset', 'debit', true, true)
ON CONFLICT (code) DO NOTHING;

-- 2 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE payment_verifications
  ADD COLUMN IF NOT EXISTS is_advance BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN payment_verifications.is_advance IS
  'True when this voucher was raised BEFORE the obligation it settles was accrued '
  '(uang muka / DP to a supplier). Routes the payment journal to 1130 Uang Muka '
  'Pembelian instead of 2000 Hutang Supplier, and routes the approval chain to '
  'the ''po_advance'' document type (owner at any amount). Only meaningful for '
  'ref_type = ''purchase_order'' today.';

-- An advance is only coherent against a document to advance AGAINST.
ALTER TABLE payment_verifications
  ADD CONSTRAINT chk_pv_advance_needs_ref
  CHECK (NOT is_advance OR (ref_type = 'purchase_order' AND ref_id IS NOT NULL));

-- 2b ────────────────────────────────────────────────────────────────────────
-- How much of the down payments already made has been reclassified into the
-- payable by SUPPLIER_ADVANCE_OFFSET. Needed because the offset is posted per
-- RECEIPT: without a running total, a second partial receipt cannot tell how
-- much of the DP the first one already consumed, and would offset it twice.
-- Derived data with no other source of truth (journal lines are not queried
-- back by the purchasing module), so it lives on the row.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS advance_applied NUMERIC(18,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN purchase_orders.advance_applied IS
  'Running total of paid uang muka already offset against this PO''s payable by '
  'SUPPLIER_ADVANCE_OFFSET at receipt (migration 268). Never exceeds the sum of '
  'paid is_advance vouchers for this PO.';

-- 3 ─────────────────────────────────────────────────────────────────────────
ALTER TABLE approval_chain_steps
  DROP CONSTRAINT chk_approval_chain_steps_document_type;

ALTER TABLE approval_chain_steps
  ADD CONSTRAINT chk_approval_chain_steps_document_type CHECK (document_type IN (
    'replenishment_request', 'void_refund', 'purchase_request', 'purchase_order',
    'stock_opname', 'return', 'waste', 'payroll_run', 'payment_verification',
    'leave_request', 'employee_loan', 'cash_variance_proposal', 'po_advance'
  ));

-- `min_amount` NULL = every advance, however small. Deliberate, not an
-- oversight: see the header.
INSERT INTO approval_chain_steps (document_type, step_no, approver_role, min_amount, max_amount) VALUES
  ('po_advance', 1, 'owner', NULL, NULL)
ON CONFLICT (document_type, step_no) DO NOTHING;

-- 4 ─────────────────────────────────────────────────────────────────────────
INSERT INTO posting_rules (event_type, rule_seq, condition, debit_account_code, credit_account_code, amount_source, description_template) VALUES
  ('supplier_advance_payment', 1, '{"paidVia":"bank_transfer"}', '1130', '1020', 'pv_amount', 'Uang muka pembelian ke supplier (transfer bank)'),
  ('supplier_advance_payment', 2, '{"paidVia":"cash"}',          '1130', '1000', 'pv_amount', 'Uang muka pembelian ke supplier (tunai)'),
  ('supplier_advance_payment', 3, '{"paidVia":"qris"}',          '1130', '1020', 'pv_amount', 'Uang muka pembelian ke supplier (QRIS)'),
  -- No `paidVia` split: this leg moves no cash. It reclassifies an advance
  -- already paid into the payable the receipt just created.
  ('supplier_advance_offset',  1, NULL,                          '2000', '1130', 'po_advance_applied', 'Perhitungan uang muka atas penerimaan barang')
ON CONFLICT (event_type, rule_seq) DO NOTHING;

COMMIT;
