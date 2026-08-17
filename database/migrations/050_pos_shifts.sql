-- Migration: 050_pos_shifts
-- Block: 050-059 (POS, offline-first origin data)
-- Description: cashier shifts (FR-POS-02). Offline-born: device-local
--              numbers, client_id idempotency.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE pos_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_number VARCHAR(40) UNIQUE NOT NULL,      -- '<locationCode>-<deviceCode>-S<localSeq>'
  location_id UUID NOT NULL REFERENCES locations(id),
  device_id UUID,                                -- FK added in block 110 (fk_shift_device)
  opened_by UUID NOT NULL REFERENCES users(id),  -- kasir (unique login, FR-POS-02)
  opened_at TIMESTAMPTZ NOT NULL,
  opening_cash NUMERIC(18,2) NOT NULL DEFAULT 0,
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closing_cash_counted NUMERIC(18,2),
  expected_cash NUMERIC(18,2),                   -- opening + sum(cash sales) - sum(cash refunds)
  cash_variance NUMERIC(18,2),                   -- counted - expected
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  sales_count INTEGER NOT NULL DEFAULT 0,
  gross_sales NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  client_id UUID UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON pos_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
