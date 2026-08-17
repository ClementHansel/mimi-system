-- Migration: 024_stock_adjustments
-- Block: 020-029 (stock)
-- Description: adjustments — the approved output of an opname, or manual
--              w/ approval (FR-SO-03/04).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_number VARCHAR(30) UNIQUE NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  qty_delta NUMERIC(14,3) NOT NULL,              -- signed; posts adjustment_in/out via ledger
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'opname' CHECK (source IN ('opname','manual','reconciliation')),
  opname_id UUID REFERENCES stock_opname(id),
  created_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),         -- FR-SO-04: who adjusted
  applied_at TIMESTAMPTZ,                        -- when ledger posting happened
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON stock_adjustments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
