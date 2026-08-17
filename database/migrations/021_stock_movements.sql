-- Migration: 021_stock_movements
-- Block: 020-029 (stock)
-- Description: the append-only movement ledger — source of truth for balances.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  movement_type VARCHAR(30) NOT NULL CHECK (movement_type IN (
    'opening_balance','purchase_in','transfer_in','transfer_out','usage_out',
    'waste_out','return_in','return_out','adjustment_in','adjustment_out')),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),    -- always positive; sign comes from the type (…_in / …_out)
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,    -- items.avg_cost at posting time; feeds §6 amounts
  ref_type VARCHAR(40) NOT NULL,                 -- 'sale','sj_drop','goods_receipt','po_receipt','waste_record',
                                                  -- 'return','stock_adjustment','area_transfer','seed'
  ref_id UUID,
  counterparty_location_id UUID REFERENCES locations(id),         -- transfers: the other side
  counterparty_storage_area_id UUID REFERENCES storage_areas(id), -- intra-location area moves
  actor_id UUID REFERENCES users(id),
  reason TEXT,
  sync_event_id UUID UNIQUE,                     -- idempotency: one movement set per applied sync event
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
