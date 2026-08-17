-- Migration: 026_indexes_rls_020
-- Block: 020-029 (stock)
-- Description: indexes + RLS for block 020-029.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_stock_balances_item ON stock_balances(item_id);

CREATE INDEX idx_stock_movements_loc_item_time ON stock_movements(location_id, item_id, occurred_at DESC);
CREATE INDEX idx_stock_movements_storage_area ON stock_movements(storage_area_id);
CREATE INDEX idx_stock_movements_ref ON stock_movements(ref_type, ref_id);
CREATE INDEX idx_stock_movements_counterparty_loc ON stock_movements(counterparty_location_id);
CREATE INDEX idx_stock_movements_type ON stock_movements(movement_type);

CREATE INDEX idx_min_stock_rules_item ON min_stock_rules(item_id);

CREATE INDEX idx_stock_opname_location ON stock_opname(location_id);
CREATE INDEX idx_stock_opname_status ON stock_opname(status);
CREATE INDEX idx_stock_opname_storage_area ON stock_opname(storage_area_id);
CREATE INDEX idx_stock_opname_lines_opname ON stock_opname_lines(opname_id);
CREATE INDEX idx_stock_opname_lines_item ON stock_opname_lines(item_id);

CREATE INDEX idx_stock_adjustments_location ON stock_adjustments(location_id);
CREATE INDEX idx_stock_adjustments_item ON stock_adjustments(item_id);
CREATE INDEX idx_stock_adjustments_opname ON stock_adjustments(opname_id);

CREATE INDEX idx_stock_reconciliations_location ON stock_reconciliations(location_id);
CREATE INDEX idx_stock_reconciliations_status ON stock_reconciliations(status);
CREATE INDEX idx_stock_reconciliations_item ON stock_reconciliations(item_id);

-- =============================================================================
-- RLS — LOC group
-- =============================================================================

ALTER TABLE stock_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_balances FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_balances_loc ON stock_balances FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE stock_movements ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_movements FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_movements_loc ON stock_movements FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE min_stock_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE min_stock_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY min_stock_rules_loc ON min_stock_rules FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE stock_opname ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_opname FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_opname_loc ON stock_opname FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE stock_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_adjustments FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_adjustments_loc ON stock_adjustments FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE stock_reconciliations ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_reconciliations FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_reconciliations_loc ON stock_reconciliations FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

-- =============================================================================
-- RLS — PARENT group
-- =============================================================================

ALTER TABLE stock_opname_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_opname_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY stock_opname_lines_parent ON stock_opname_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM stock_opname o
      WHERE o.id = stock_opname_lines.opname_id AND app_has_location(o.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM stock_opname o
      WHERE o.id = stock_opname_lines.opname_id AND app_has_location(o.location_id)
    )
  );

COMMIT;
