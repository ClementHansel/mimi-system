-- Migration: 053_online_orders
-- Block: 050-059 (POS, offline-first origin data)
-- Description: manual GoFood/ShopeeFood records (FR-POS-05, FR-POS-07).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE online_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID UNIQUE NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('gofood','shopeefood')),
  order_ref VARCHAR(100) NOT NULL,               -- nomor order ID platform
  order_date DATE NOT NULL,                      -- tanggal transaksi
  gross_amount NUMERIC(18,2) NOT NULL,           -- nilai pesanan
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_received NUMERIC(18,2) NOT NULL,           -- pembayaran diterima (validated: gross - discount - fees)
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled')),
  settlement_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (settlement_status IN ('pending','settled')),
  items JSONB,                                   -- optional [{productId, qty}] -> enables usage posting (Appendix A-7)
  recorded_by UUID NOT NULL REFERENCES users(id),
  shift_id UUID REFERENCES pos_shifts(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, order_ref)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON online_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
