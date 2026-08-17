-- Migration: 093_posting_rules
-- Block: 090-099 (accounting)
-- Description: declarative posting rules (D-04), seeded from CONTRACTS.md
--              §6.2 (16 PRD journal event types) and §6.3 (system
--              extensions, including the Amendment 1 X1s statutory legs).
--              Editable only by Finance/Owner (accounting.coa.manage-like
--              gate at the API layer).
--
-- NOTE for W4-03 (accounting/posting-engine owner): a handful of source
-- events need MORE than one Dr/Cr pair to balance (payroll accrual splits
-- gross across net-pay + loan + SO-shortfall legs; online sales split
-- gross/net/fees across three accounts; void reversal unwinds both revenue
-- and HPP). The schema's (event_type, rule_seq) shape only carries one pair
-- per row by design ("one event may emit several Dr/Cr pairs" per the block
-- 090 DDL comment) — these are seeded as multiple rows under the same
-- event_type; the engine is responsible for combining them into one balanced
-- journal_entry. Treat the `condition` + `amount_source` values below as a
-- faithful starting point, not a finished spec — refine amount_source
-- selectors as needed once the domain-event payload shapes are final.
--
-- Two rows (`petty_cash_topup`, `employee_loan_disbursement`) use event_type
-- strings that are NOT in the CONTRACTS.md §2.8 JournalEventType /
-- JournalSystemEventType enums (the contract describes them only in prose,
-- "Petty-cash float top-up ... and loan disbursement ... post from their PV
-- paid events under X-family rules"). packages/shared should add matching
-- enum members for type-checking parity.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE posting_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,               -- JournalEventType (§2)
  rule_seq INTEGER NOT NULL,                     -- one event may emit several Dr/Cr pairs
  condition JSONB,                               -- e.g. {"method":"cash"} | {"direction":"shortage"} | NULL = always
  debit_account_code VARCHAR(10) NOT NULL,
  credit_account_code VARCHAR(10) NOT NULL,
  amount_source VARCHAR(100) NOT NULL,           -- named selector resolved by the engine (§6.2 column)
  description_template TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_type, rule_seq)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON posting_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO posting_rules (event_type, rule_seq, condition, debit_account_code, credit_account_code, amount_source, description_template) VALUES
  -- JGUD-01..07
  ('gudang_purchase', 1, NULL, '1100', '2000', 'po_receipt_value', 'Penerimaan barang dari supplier'),
  ('gudang_goods_in', 1, NULL, '1100', '1120', 'return_receipt_value', 'Retur outlet diterima gudang'),
  ('gudang_goods_out_to_outlet', 1, NULL, '1120', '1100', 'sj_dispatch_value', 'Barang keluar ke outlet via Surat Jalan'),
  ('gudang_return_to_supplier', 1, NULL, '2000', '1100', 'return_to_supplier_value', 'Retur barang ke supplier'),
  ('gudang_waste', 1, NULL, '5100', '1100', 'waste_value', 'Waste/kerusakan barang gudang'),
  ('gudang_stock_adjustment', 1, '{"direction":"shortage"}', '6400', '1100', 'adjustment_value', 'Penyesuaian stok gudang (kurang)'),
  ('gudang_stock_adjustment', 2, '{"direction":"overage"}', '1100', '4100', 'adjustment_value', 'Penyesuaian stok gudang (lebih)'),
  ('gudang_stock_revaluation', 1, '{"direction":"up"}', '1100', '5090', 'revaluation_value', 'Revaluasi stok gudang (naik)'),
  ('gudang_stock_revaluation', 2, '{"direction":"down"}', '5090', '1100', 'revaluation_value', 'Revaluasi stok gudang (turun)'),
  -- JOUT-01..09
  ('outlet_goods_in_from_warehouse', 1, NULL, '1110', '1120', 'sj_received_value', 'Barang diterima outlet dari Surat Jalan'),
  ('outlet_goods_in_from_warehouse', 2, '{"discrepancy":true}', '6400', '1120', 'sj_discrepancy_value', 'Selisih kekurangan barang dalam perjalanan'),
  ('outlet_ingredient_usage', 1, NULL, '5000', '1110', 'daily_usage_value', 'Pemakaian bahan baku harian outlet'),
  ('outlet_sales', 1, '{"method":"cash"}', '1000', '4000', 'daily_sales_by_method', 'Penjualan tunai harian'),
  ('outlet_sales', 2, '{"method":"qris"}', '1031', '4000', 'daily_sales_by_method', 'Penjualan QRIS harian'),
  ('outlet_sales', 3, '{"method":"bank_transfer"}', '1032', '4000', 'daily_sales_by_method', 'Penjualan transfer bank harian'),
  ('outlet_sales', 4, '{"platform":"any"}', '1030', '4000', 'daily_online_net', 'Penjualan online (net diterima) harian'),
  ('outlet_sales', 5, '{"platform":"any"}', '6300', '4000', 'daily_online_fees_discount', 'Komisi platform + diskon penjualan online harian'),
  ('outlet_waste', 1, NULL, '5100', '1110', 'waste_value', 'Waste/kerusakan barang outlet'),
  ('outlet_return_to_warehouse', 1, NULL, '1120', '1110', 'return_ship_value', 'Retur outlet ke gudang (kirim)'),
  ('outlet_stock_adjustment', 1, '{"direction":"shortage","attributable":false}', '6400', '1110', 'adjustment_value', 'Penyesuaian stok outlet (kurang, non-atribusi)'),
  ('outlet_stock_adjustment', 2, '{"direction":"shortage","attributable":true}', '1210', '1110', 'adjustment_value', 'Penyesuaian stok outlet (kurang, atribusi karyawan)'),
  ('outlet_stock_adjustment', 3, '{"direction":"overage"}', '1110', '4100', 'adjustment_value', 'Penyesuaian stok outlet (lebih)'),
  ('outlet_direct_purchase', 1, '{"source":"petty_cash"}', '1110', '1010', 'stockable_line_amount', 'Pembelian langsung outlet (petty cash)'),
  ('outlet_direct_purchase', 2, '{"source":"po"}', '1110', '2000', 'stockable_line_amount', 'Pembelian langsung outlet (PO)'),
  ('outlet_petty_cash', 1, NULL, '6100', '1010', 'nonstockable_line_amount', 'Beban operasional outlet (petty cash)'),
  ('outlet_operating_expense', 1, '{"paidVia":"bank_transfer"}', '6100', '1020', 'pv_amount', 'Beban operasional outlet (transfer bank)'),
  ('outlet_operating_expense', 2, '{"paidVia":"cash"}', '6100', '1000', 'pv_amount', 'Beban operasional outlet (tunai)'),
  -- X1 / X1s payroll accrual (see header note: multi-leg, engine-combined)
  ('payroll_accrual', 1, '{"componentType":"earning"}', '6000', '2100', 'sum_earning_amount', 'Akrual gaji - komponen pendapatan'),
  ('payroll_accrual', 2, '{"componentType":"deduction","source":"loan"}', '2100', '1210', 'sum_loan_deduction', 'Akrual gaji - potongan cicilan kasbon'),
  ('payroll_accrual', 3, '{"componentType":"deduction","source":"so_shortfall"}', '2100', '1220', 'sum_so_shortfall_deduction', 'Akrual gaji - potongan selisih stok (piutang klaim)'),
  ('payroll_accrual', 4, '{"statutoryMode":true,"componentType":"employer_cost"}', '6010', '2110', 'sum_employer_cost_amount', 'Akrual BPJS perusahaan (Amendment 1)'),
  ('payroll_accrual', 5, '{"statutoryMode":true,"componentType":"deduction","program":"bpjs"}', '2100', '2110', 'sum_bpjs_employee_deduction', 'Akrual potongan BPJS karyawan (Amendment 1)'),
  ('payroll_accrual', 6, '{"statutoryMode":true,"componentType":"deduction","program":"pph21"}', '2100', '2120', 'sum_pph21_deduction', 'Akrual potongan PPh21 (Amendment 1)'),
  -- X2..X7
  ('payroll_payment', 1, NULL, '2100', '1020', 'total_net', 'Pembayaran gaji'),
  ('qris_settlement', 1, NULL, '1020', '1031', 'settled_amount', 'Settlement QRIS'),
  ('transfer_verified', 1, NULL, '1020', '1032', 'payment_amount', 'Verifikasi transfer bank'),
  ('platform_settlement', 1, NULL, '1020', '1030', 'payout_amount', 'Settlement platform online'),
  ('sale_void_reversal', 1, '{"method":"cash"}', '4000', '1000', 'void_amount', 'Reversal penjualan tunai (void/refund)'),
  ('sale_void_reversal', 2, '{"method":"qris"}', '4000', '1031', 'void_amount', 'Reversal penjualan QRIS (void/refund)'),
  ('sale_void_reversal', 3, '{"method":"bank_transfer"}', '4000', '1032', 'void_amount', 'Reversal penjualan transfer (void/refund)'),
  ('sale_void_reversal', 4, NULL, '1110', '5000', 'void_usage_reversal', 'Reversal HPP - bahan baku kembali ke outlet'),
  ('offline_auth_rejected', 1, '{"documentType":"void_refund"}', '1220', '4000', 'document_amount', 'Klaim karyawan - void/refund offline ditolak (piutang)'),
  ('offline_auth_rejected', 2, '{"documentType":"waste"}', '1220', '5100', 'document_amount', 'Klaim karyawan - waste offline ditolak (piutang, reversal beban)'),
  -- Petty-cash float top-up / loan disbursement (prose-only in §6.3; see header note)
  ('petty_cash_topup', 1, NULL, '1010', '1020', 'topup_amount', 'Isi ulang kas kecil'),
  ('employee_loan_disbursement', 1, NULL, '1210', '1020', 'loan_principal', 'Pencairan pinjaman karyawan (kasbon)')
ON CONFLICT (event_type, rule_seq) DO NOTHING;

COMMIT;
