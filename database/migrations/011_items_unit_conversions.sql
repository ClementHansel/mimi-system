-- Migration: 011_items_unit_conversions
-- Block: 010-019 (master data)
-- Description: items (stockable ingredients & goods; menu products are
--              separate, see 012) + unit conversion factors.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category_id UUID REFERENCES item_categories(id),
  base_unit_id UUID NOT NULL REFERENCES units(id),
  storage_type VARCHAR(20) NOT NULL DEFAULT 'dry' CHECK (storage_type IN ('frozen','chilled','dry')),
    -- drives frozen/dry shipment split (FR-LOG-02) and valid storage-area types
  is_sellable BOOLEAN NOT NULL DEFAULT false,    -- true = can appear on a 1:1 product (e.g. bottled drink)
  shelf_life_days INTEGER,
  temp_min NUMERIC(4,1),
  temp_max NUMERIC(4,1),                         -- item-level cold-chain bounds (frozen chicken: -25..-15)
  avg_cost NUMERIC(18,2) NOT NULL DEFAULT 0,     -- moving average, recomputed by cloud on PO receipt; feeds GL amounts
  last_purchase_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  barcode VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE unit_conversions (                  -- item-specific overrides generic (item_id NULL = generic)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  from_unit_id UUID NOT NULL REFERENCES units(id),
  to_unit_id UUID NOT NULL REFERENCES units(id),
  factor NUMERIC(14,6) NOT NULL CHECK (factor > 0),   -- qty_to = qty_from * factor
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, from_unit_id, to_unit_id)
);

COMMIT;
