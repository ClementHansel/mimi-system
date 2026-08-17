-- Migration: 014_indexes_rls_010
-- Block: 010-019 (master data)
-- Description: indexes + RLS for block 010-019. Per CONTRACTS.md §1.14:
--              items/categories/units/unit_conversions/products/recipes/
--              recipe_lines are NONE (API-gated only, PermissionsGuard).
--              suppliers gets the Amendment 3 (D-20) split; supplier_items
--              and supplier_price_history stay fully role-locked (FR-SUP-06).
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_item_categories_parent ON item_categories(parent_id);
CREATE INDEX idx_items_category ON items(category_id);
CREATE INDEX idx_items_base_unit ON items(base_unit_id);
CREATE INDEX idx_items_storage_type ON items(storage_type);
CREATE INDEX idx_items_barcode ON items(barcode) WHERE barcode IS NOT NULL;
CREATE INDEX idx_unit_conversions_item ON unit_conversions(item_id);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_recipe_lines_recipe ON recipe_lines(recipe_id);
CREATE INDEX idx_recipe_lines_item ON recipe_lines(item_id);
CREATE INDEX idx_supplier_items_supplier ON supplier_items(supplier_id);
CREATE INDEX idx_supplier_items_item ON supplier_items(item_id);
CREATE INDEX idx_supplier_price_history_supplier_item ON supplier_price_history(supplier_id, item_id, effective_date DESC);

-- =============================================================================
-- RLS — suppliers (Amendment 3 / D-20)
-- Central + kepala_gudang: full row, all columns (API layer still gates price
-- fields via supplier.price.read for kepala_gudang's own responses, but the
-- row and every column are DB-visible to these roles).
-- Supervisor/Leader: row visible ONLY when outlet_visible=true; the API must
-- serve them the name/contact projection alone (supplier.directory.read) —
-- column stripping of payment_terms_days/bank_*/pricing happens at the API
-- layer, not here (RLS filters rows, never columns).
-- =============================================================================

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE suppliers FORCE ROW LEVEL SECURITY;

CREATE POLICY suppliers_select ON suppliers FOR SELECT
  USING (
    current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang')
    OR (
      current_setting('app.role', true) IN ('supervisor','leader_outlet')
      AND outlet_visible = true
    )
  );
CREATE POLICY suppliers_insert ON suppliers FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));
CREATE POLICY suppliers_update ON suppliers FOR UPDATE
  USING (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));
CREATE POLICY suppliers_delete ON suppliers FOR DELETE
  USING (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));

-- =============================================================================
-- RLS — supplier_items / supplier_price_history: role-locked, FULL stop
-- (FR-SUP-06: price rows never reach outlet roles, not even row-visible).
-- =============================================================================

ALTER TABLE supplier_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_items FORCE ROW LEVEL SECURITY;

CREATE POLICY supplier_items_all ON supplier_items FOR ALL
  USING (current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang'))
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));

ALTER TABLE supplier_price_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE supplier_price_history FORCE ROW LEVEL SECURITY;

CREATE POLICY supplier_price_history_select ON supplier_price_history FOR SELECT
  USING (current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang'));
CREATE POLICY supplier_price_history_insert ON supplier_price_history FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','kepala_gudang'));

-- =============================================================================
-- NO RLS (§1.14 "NONE" group): item_categories, units, items, unit_conversions,
-- products, recipes, recipe_lines — API-gated (recipe/recipe_lines additionally
-- require recipe.read since a recipe is cost structure).
-- =============================================================================

COMMIT;
