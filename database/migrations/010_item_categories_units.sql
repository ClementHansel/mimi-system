-- Migration: 010_item_categories_units
-- Block: 010-019 (master data: items, products/recipes, suppliers)
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE item_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,             -- 'Ayam Mentah','Bumbu','Sembako','Kemasan','Minuman'
  parent_id UUID REFERENCES item_categories(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON item_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) UNIQUE NOT NULL,              -- 'kg','gr','ltr','ml','pcs','box','pack','ekor'
  name VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
