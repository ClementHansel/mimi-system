-- Migration: 012_products_recipes
-- Block: 010-019 (master data)
-- Description: menu products + recipes (BOM) — drives FR-POS-06 usage estimate.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'Umum', -- menu category: 'Ayam','Paket','Minuman','Tambahan'
  price NUMERIC(18,2) NOT NULL,                  -- POS price, IDR
  photo_attachment_id UUID REFERENCES attachments(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  yield_qty NUMERIC(14,3) NOT NULL DEFAULT 1,    -- portions produced per recipe execution
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE recipe_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),    -- per 1 product unit, in unit_id below
  unit_id UUID NOT NULL REFERENCES units(id),
  UNIQUE (recipe_id, item_id)
);

COMMIT;
