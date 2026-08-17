-- Migration: 025_stock_reconciliations
-- Block: 020-029 (stock)
-- Description: reconciliation exceptions (D-16: divergence is an exception,
--              never an overwrite).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE stock_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  tier VARCHAR(10) NOT NULL CHECK (tier IN ('device','node','cloud')),
  expected_qty NUMERIC(14,3) NOT NULL,           -- Σ movements (recomputed)
  stored_qty NUMERIC(14,3) NOT NULL,             -- what the balance row said
  divergence NUMERIC(14,3) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON stock_reconciliations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
