-- Migration: 051_sales
-- Block: 050-059 (POS, offline-first origin data)
-- Description: sales + lines + payments (append-only aggregates; void is a
--              separate document, see 052).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number VARCHAR(40) UNIQUE NOT NULL,    -- device-local, printed on the nota (FR-POS-01)
  client_id UUID UNIQUE NOT NULL,                -- sync idempotency key
  location_id UUID NOT NULL REFERENCES locations(id),
  shift_id UUID NOT NULL REFERENCES pos_shifts(id),
  kasir_id UUID NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','refunded')),
  subtotal NUMERIC(18,2) NOT NULL,
  discount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL,
  paid_amount NUMERIC(18,2) NOT NULL,
  change_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  offline_created BOOLEAN NOT NULL DEFAULT false,
  occurred_at TIMESTAMPTZ NOT NULL,              -- client clock (advisory; ordering by client_seq per SYNC-PROTOCOL)
  synced_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sale_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(18,2) NOT NULL,             -- price at sale time (products.price snapshot)
  discount NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
-- Applying a sale posts usage_out per recipe explosion (kitchen_line area) via ledger -> FR-POS-06 estimates.

CREATE TABLE sale_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL CHECK (method IN ('cash','qris','bank_transfer')),  -- FR-POS-04
  amount NUMERIC(18,2) NOT NULL,
  reference VARCHAR(100),
  payment_status VARCHAR(20) NOT NULL CHECK (payment_status IN ('pending','verified','paid')),
    -- cash -> 'paid' at once; qris -> 'verified' (settles later); bank_transfer -> 'pending' until
    -- Finance verifies (NFR-09, FR-ACCT-03)
  proof_attachment_id UUID REFERENCES attachments(id),
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ
);

COMMIT;
