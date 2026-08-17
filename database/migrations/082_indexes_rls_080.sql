-- Migration: 082_indexes_rls_080
-- Block: 080-089 (waste & returns)
-- Description: indexes + RLS for block 080-089.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_waste_records_location ON waste_records(location_id);
CREATE INDEX idx_waste_records_storage_area ON waste_records(storage_area_id);
CREATE INDEX idx_waste_records_item ON waste_records(item_id);
CREATE INDEX idx_waste_records_status ON waste_records(status);
CREATE INDEX idx_waste_records_batch ON waste_records(batch_id);

CREATE INDEX idx_returns_from_location ON returns(from_location_id);
CREATE INDEX idx_returns_to_location ON returns(to_location_id);
CREATE INDEX idx_returns_supplier ON returns(supplier_id);
CREATE INDEX idx_returns_status ON returns(status);
CREATE INDEX idx_return_lines_return ON return_lines(return_id);
CREATE INDEX idx_return_lines_item ON return_lines(item_id);

-- =============================================================================
-- RLS — waste_records: LOC ; returns: LOC (via from_location_id) ; return_lines: PARENT
-- =============================================================================

ALTER TABLE waste_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE waste_records FORCE ROW LEVEL SECURITY;
CREATE POLICY waste_records_loc ON waste_records FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns FORCE ROW LEVEL SECURITY;
CREATE POLICY returns_loc ON returns FOR ALL
  USING (app_has_location(from_location_id)) WITH CHECK (app_has_location(from_location_id));

ALTER TABLE return_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY return_lines_parent ON return_lines FOR ALL
  USING (
    EXISTS (SELECT 1 FROM returns r WHERE r.id = return_lines.return_id AND app_has_location(r.from_location_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM returns r WHERE r.id = return_lines.return_id AND app_has_location(r.from_location_id))
  );

COMMIT;
