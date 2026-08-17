-- Migration: 043_petty_cash
-- Block: 040-049 (purchasing: PR, PO, receiving, petty cash)
-- Description: petty cash (PRD 8.6.1).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE petty_cash (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_number VARCHAR(30) UNIQUE NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  purchased_by UUID NOT NULL REFERENCES users(id),      -- siapa yang membeli
  purchase_date DATE NOT NULL,
  store_name VARCHAR(255) NOT NULL,              -- nama supplier/toko
  total_amount NUMERIC(18,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  verified_by UUID REFERENCES users(id),         -- siapa yang verifikasi
  verified_at TIMESTAMPTZ,
  rejection_reason TEXT,
  payment_verification_id UUID,                  -- FK added in block 090 (fk_pc_pv; FR-ACCT-04 petty cash)
  notes TEXT,
  client_id UUID UNIQUE,                         -- outlet offline idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Wajib foto: attachments kind='payment_proof' (bukti pembayaran) AND kind='petty_cash_photo' (foto barang),
-- both required to verify.

CREATE TRIGGER set_updated_at BEFORE UPDATE ON petty_cash
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE petty_cash_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  petty_cash_id UUID NOT NULL REFERENCES petty_cash(id) ON DELETE CASCADE,
  description VARCHAR(255) NOT NULL,             -- barang yang dibeli
  item_id UUID REFERENCES items(id),             -- set when the purchase is stockable -> posts purchase_in on verify
  storage_area_id UUID REFERENCES storage_areas(id),
  qty NUMERIC(14,3),
  amount NUMERIC(18,2) NOT NULL,
  expense_category VARCHAR(50) NOT NULL DEFAULT 'operasional'  -- posting rules map category -> COA account (§6)
);

COMMIT;
