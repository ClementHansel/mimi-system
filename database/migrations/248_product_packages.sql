-- Migration: 248_product_packages
-- Block: 230-239 (master data amendments)
-- Description: packages (bundles) — a sellable that is composed of other
--              products, priced independently of its members.
-- Created at: 2026-08-24
--
-- WHY A PACKAGE IS A `products` ROW AND NOT ITS OWN TABLE
-- ------------------------------------------------------
-- A "Paket" was already sold as an ordinary product whose recipe listed raw
-- items directly, which meant repricing a bundle or swapping what is inside it
-- meant re-authoring a BOM. This gives the bundle real structure — it lists
-- MEMBER PRODUCTS — while keeping it a `products` row, because
-- `sale_lines.product_id` is a NOT NULL FK to `products` (migration 051) and
-- void/refund, GL posting, receipt rendering, the sync projector and the
-- offline runtime all key off it. A package therefore sells as ONE sale line
-- at the package price: no member price allocation, no rounding remainder to
-- park, no grouping column on `sale_lines`, and no changes to any of those
-- five consumers. Price, photo, menu category, sort order and `is_active`
-- come along for free because they are the same columns every product has.
--
-- No RLS on either new object (CONTRACTS.md §1.14 NONE for products/recipes/
-- categories — API-gated by `PermissionsGuard` only), matching migration 014.
--
-- The one thing this shape does NOT give you is per-member revenue
-- attribution in reporting — a package's revenue lands against the package,
-- not split across its members. Recorded here so the trade-off is findable.
--
-- STOCK (FR-POS-06): a package carries no recipe of its own. Selling one
-- explodes through each member's recipe, scaled by member qty × qty sold —
-- see `modules/pos/recipe-usage.util.ts`.

BEGIN;

ALTER TABLE products
  ADD COLUMN kind VARCHAR(20) NOT NULL DEFAULT 'product'
    CHECK (kind IN ('product', 'package'));

CREATE TABLE product_package_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  -- RESTRICT, not CASCADE: silently emptying a package because one member was
  -- hard-deleted would leave a sellable that consumes no stock at all.
  member_product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (package_product_id, member_product_id),
  CHECK (package_product_id <> member_product_id)
);

CREATE INDEX idx_product_package_lines_package ON product_package_lines(package_product_id, sort_order);
CREATE INDEX idx_product_package_lines_member ON product_package_lines(member_product_id);

-- =============================================================================
-- INTEGRITY: the three ways this could silently mis-post stock
-- =============================================================================
-- A CHECK constraint cannot see another row, so the kind invariants live in
-- triggers. Each one guards a case that would corrupt the FR-POS-06 usage
-- estimate rather than merely being untidy:
--   1. a package inside a package  -> unbounded explosion recursion
--   2. lines hung off a non-package -> lines that nothing ever explodes
--   3. a package that also has a recipe -> ingredients counted TWICE per sale

CREATE OR REPLACE FUNCTION enforce_package_line_kinds() RETURNS TRIGGER AS $$
DECLARE
  parent_kind TEXT;
  member_kind TEXT;
BEGIN
  SELECT kind INTO parent_kind FROM products WHERE id = NEW.package_product_id;
  IF parent_kind IS DISTINCT FROM 'package' THEN
    RAISE EXCEPTION 'product % is kind=% — package lines may only hang off kind=package',
      NEW.package_product_id, COALESCE(parent_kind, 'missing');
  END IF;

  SELECT kind INTO member_kind FROM products WHERE id = NEW.member_product_id;
  IF member_kind IS DISTINCT FROM 'product' THEN
    RAISE EXCEPTION 'product % is kind=% — a package member must be kind=product (packages do not nest)',
      NEW.member_product_id, COALESCE(member_kind, 'missing');
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER product_package_lines_kind_guard
  BEFORE INSERT OR UPDATE ON product_package_lines
  FOR EACH ROW EXECUTE FUNCTION enforce_package_line_kinds();

-- Guards the same three invariants from the `products` side: flipping `kind`
-- after the fact could otherwise strand existing rows on the wrong side of them.
CREATE OR REPLACE FUNCTION enforce_product_kind_transition() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.kind = OLD.kind THEN
    RETURN NEW;
  END IF;

  IF NEW.kind = 'product' AND EXISTS (
    SELECT 1 FROM product_package_lines WHERE package_product_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'product % still has package lines — clear them before changing kind to product', NEW.id;
  END IF;

  IF NEW.kind = 'package' AND EXISTS (
    SELECT 1 FROM product_package_lines WHERE member_product_id = NEW.id
  ) THEN
    RAISE EXCEPTION 'product % is a member of a package — packages do not nest', NEW.id;
  END IF;

  IF NEW.kind = 'package' AND EXISTS (
    SELECT 1 FROM recipes WHERE product_id = NEW.id AND is_active
  ) THEN
    RAISE EXCEPTION 'product % has an active recipe — a package explodes through its members, so a recipe would double-count ingredients', NEW.id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_kind_transition_guard
  BEFORE UPDATE OF kind ON products
  FOR EACH ROW EXECUTE FUNCTION enforce_product_kind_transition();

-- And from the `recipes` side (invariant 3 again — a recipe added to an
-- existing package is the same double-count reached from the other direction).
CREATE OR REPLACE FUNCTION enforce_recipe_not_on_package() RETURNS TRIGGER AS $$
DECLARE
  target_kind TEXT;
BEGIN
  IF NEW.is_active IS NOT TRUE THEN
    RETURN NEW;
  END IF;
  SELECT kind INTO target_kind FROM products WHERE id = NEW.product_id;
  IF target_kind = 'package' THEN
    RAISE EXCEPTION 'product % is a package — it explodes through its members, so it must not carry a recipe', NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recipes_not_on_package_guard
  BEFORE INSERT OR UPDATE ON recipes
  FOR EACH ROW EXECUTE FUNCTION enforce_recipe_not_on_package();

GRANT SELECT, INSERT, UPDATE, DELETE ON product_package_lines TO app_user;

COMMIT;
