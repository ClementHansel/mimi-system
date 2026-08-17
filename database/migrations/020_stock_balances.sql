-- Migration: 020_stock_balances
-- Block: 020-029 (stock)
-- Description: the derived balance table (D-15, D-16, D-07). NO synthetic id
--              — the composite key IS the identity. Written ONLY by
--              StockLedgerService.post(tx, movements); never synced (D-16).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE stock_balances (
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty_on_hand NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, storage_area_id, item_id)
);
-- INVARIANT (property-tested by W2-A): qty_on_hand === sum of signed stock_movements for the same key.

COMMIT;
