-- Migration: 090_chart_of_accounts
-- Block: 090-099 (accounting: COA, journal, posting rules, payment verification, D-04)
-- Description: chart of accounts, seeded per CONTRACTS.md §6.1 (is_system=true;
--              codes are contract). Includes the Amendment 1 (D-18) statutory
--              accounts: 2110 Hutang BPJS, 2120 Hutang PPh21, 6010 Beban BPJS.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(150) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  normal_balance VARCHAR(6) NOT NULL CHECK (normal_balance IN ('debit','credit')),
  parent_id UUID REFERENCES chart_of_accounts(id),
  is_postable BOOLEAN NOT NULL DEFAULT true,     -- header accounts: false
  is_system BOOLEAN NOT NULL DEFAULT false,      -- referenced by posting_rules => cannot deactivate
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO chart_of_accounts (code, name, type, normal_balance, is_system, is_postable) VALUES
  ('1000', 'Kas Outlet', 'asset', 'debit', true, true),
  ('1010', 'Kas Kecil (Petty Cash)', 'asset', 'debit', true, true),
  ('1020', 'Bank', 'asset', 'debit', true, true),
  ('1030', 'Piutang Platform Online', 'asset', 'debit', true, true),
  ('1031', 'Piutang QRIS', 'asset', 'debit', true, true),
  ('1032', 'Piutang Transfer', 'asset', 'debit', true, true),
  ('1100', 'Persediaan Gudang', 'asset', 'debit', true, true),
  ('1110', 'Persediaan Outlet', 'asset', 'debit', true, true),
  ('1120', 'Persediaan Dalam Perjalanan', 'asset', 'debit', true, true),
  ('1210', 'Piutang Karyawan (Kasbon)', 'asset', 'debit', true, true),
  ('1220', 'Piutang Klaim Karyawan', 'asset', 'debit', true, true),
  ('1500', 'Aset Tetap', 'asset', 'debit', true, true),
  ('2000', 'Hutang Supplier', 'liability', 'credit', true, true),
  ('2100', 'Hutang Gaji', 'liability', 'credit', true, true),
  ('2110', 'Hutang BPJS', 'liability', 'credit', true, true),
  ('2120', 'Hutang PPh21', 'liability', 'credit', true, true),
  ('2200', 'Hutang Lainnya', 'liability', 'credit', true, true),
  ('3000', 'Modal', 'equity', 'credit', true, true),
  ('3100', 'Laba Ditahan', 'equity', 'credit', true, true),
  ('4000', 'Pendapatan Penjualan', 'revenue', 'credit', true, true),
  ('4100', 'Pendapatan Lainnya', 'revenue', 'credit', true, true),
  ('5000', 'Beban Pokok Penjualan (HPP)', 'expense', 'debit', true, true),
  ('5090', 'Penyesuaian Nilai Persediaan', 'expense', 'debit', true, true),
  ('5100', 'Beban Waste/Rusak/Expired', 'expense', 'debit', true, true),
  ('6000', 'Beban Gaji', 'expense', 'debit', true, true),
  ('6010', 'Beban BPJS (Perusahaan)', 'expense', 'debit', true, true),
  ('6100', 'Beban Operasional Outlet', 'expense', 'debit', true, true),
  ('6200', 'Beban Maintenance', 'expense', 'debit', true, true),
  ('6300', 'Beban Komisi Platform', 'expense', 'debit', true, true),
  ('6400', 'Beban Selisih Stok', 'expense', 'debit', true, true)
ON CONFLICT (code) DO NOTHING;

COMMIT;
