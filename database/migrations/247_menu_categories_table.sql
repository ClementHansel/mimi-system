-- Migration: 247_menu_categories_table
-- Block: 230-239 (master data amendments)
-- Description: promotes the POS menu category from free text on
--              `products.category` to a managed `product_categories` row.
-- Created at: 2026-08-24
--
-- WHY: `products.category` was a bare VARCHAR(100) (migration 012) with no
-- table behind it — `GET /api/products/categories` was a `SELECT DISTINCT`
-- over it. That made four things impossible that the till and the back office
-- both need: renaming a category (every product had to be re-edited),
-- reordering the POS chip row (`ProductGrid` sorted alphabetically because
-- alphabetical was the only order available), retiring a seasonal category
-- without deleting its products, and preventing a fourth spelling of "Minuman"
-- from appearing the moment someone typed one.
--
-- The wire field stays `category` (a string) so the precached POS catalog,
-- the sync payload, and `@mimi/shared`'s `Product` keep their shape — it is
-- now sourced from a join on `product_categories.name` instead of a
-- denormalised copy, so there is exactly one place a rename has to land.

BEGIN;

CREATE TABLE product_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,             -- 'Ayam','Paket','Minuman','Tambahan'
  sort_order INTEGER NOT NULL DEFAULT 0,         -- drives the POS category chip row order
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON product_categories
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Backfill one row per distinct value already in use, including values on
-- INACTIVE products — dropping the text column would otherwise orphan them
-- and a deactivated seasonal product could never be reactivated into its own
-- category again. Alphabetical seeds `sort_order` because alphabetical is the
-- order the till already displayed; someone can reorder afterwards.
INSERT INTO product_categories (name, sort_order)
SELECT category, (ROW_NUMBER() OVER (ORDER BY category) - 1) * 10
  FROM (SELECT DISTINCT category FROM products) AS existing
ON CONFLICT (name) DO NOTHING;

-- 'Umum' is `products.category`'s column default and therefore the fallback a
-- product lands in when no category is chosen; guarantee the row exists even
-- on an empty `products` table (a fresh migrate-then-seed ordering).
INSERT INTO product_categories (name, sort_order)
VALUES ('Umum', 9000)
ON CONFLICT (name) DO NOTHING;

ALTER TABLE products ADD COLUMN category_id UUID REFERENCES product_categories(id);

UPDATE products p
   SET category_id = pc.id
  FROM product_categories pc
 WHERE pc.name = p.category;

ALTER TABLE products ALTER COLUMN category_id SET NOT NULL;

-- The old free-text column and its index go away in the same transaction as
-- the backfill: leaving both would leave two sources of truth for the same
-- fact, which is the exact bug this migration exists to remove.
DROP INDEX IF EXISTS idx_products_category;
ALTER TABLE products DROP COLUMN category;

CREATE INDEX idx_products_category_id ON products(category_id);
CREATE INDEX idx_product_categories_sort ON product_categories(sort_order, name);

GRANT SELECT, INSERT, UPDATE, DELETE ON product_categories TO app_user;

COMMIT;
