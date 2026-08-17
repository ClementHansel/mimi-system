-- Migration: 022_min_stock_rules
-- Block: 020-029 (stock)
-- Description: min-stock rules (FR-LOG-06, FR-LOG-17) — outlet AND warehouse
--              rules in one table. Low-stock detection: balance summed
--              across areas per (location,item) vs min_qty.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE min_stock_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  min_qty NUMERIC(14,3) NOT NULL CHECK (min_qty >= 0),
  reorder_qty NUMERIC(14,3),                     -- default suggested replenishment qty (FR-LOG-08/19 fallback)
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, item_id)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON min_stock_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
