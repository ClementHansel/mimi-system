-- Migration: 044_indexes_rls_040
-- Block: 040-049 (purchasing: PR, PO, receiving, petty cash)
-- Description: indexes + RLS for block 040-049.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_purchase_requests_location ON purchase_requests(location_id);
CREATE INDEX idx_purchase_requests_status ON purchase_requests(status);
CREATE INDEX idx_purchase_request_lines_item ON purchase_request_lines(item_id);
CREATE INDEX idx_purchase_request_lines_supplier ON purchase_request_lines(suggested_supplier_id);

CREATE INDEX idx_purchase_orders_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_location ON purchase_orders(location_id);
CREATE INDEX idx_purchase_orders_pr ON purchase_orders(pr_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_po_lines_po ON po_lines(po_id);
CREATE INDEX idx_po_lines_item ON po_lines(item_id);

CREATE INDEX idx_po_receipts_po ON po_receipts(po_id);
CREATE INDEX idx_po_receipt_lines_receipt ON po_receipt_lines(po_receipt_id);
CREATE INDEX idx_po_receipt_lines_po_line ON po_receipt_lines(po_line_id);
CREATE INDEX idx_po_receipt_lines_storage_area ON po_receipt_lines(storage_area_id);

CREATE INDEX idx_petty_cash_location ON petty_cash(location_id);
CREATE INDEX idx_petty_cash_status ON petty_cash(status);
CREATE INDEX idx_petty_cash_lines_petty_cash ON petty_cash_lines(petty_cash_id);
CREATE INDEX idx_petty_cash_lines_item ON petty_cash_lines(item_id);

-- =============================================================================
-- RLS — purchase_requests / purchase_orders / po_receipts:
-- LOC AND ROLE(owner,manager,finance,kepala_gudang,supervisor)
-- =============================================================================

ALTER TABLE purchase_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_requests FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_requests_loc_role ON purchase_requests FOR ALL
  USING (
    app_has_location(location_id)
    AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
  )
  WITH CHECK (
    app_has_location(location_id)
    AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
  );

ALTER TABLE purchase_request_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_request_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_request_lines_parent ON purchase_request_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM purchase_requests r
      WHERE r.id = purchase_request_lines.pr_id
        AND app_has_location(r.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM purchase_requests r
      WHERE r.id = purchase_request_lines.pr_id
        AND app_has_location(r.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  );

ALTER TABLE purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchase_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY purchase_orders_loc_role ON purchase_orders FOR ALL
  USING (
    app_has_location(location_id)
    AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
  )
  WITH CHECK (
    app_has_location(location_id)
    AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
  );

ALTER TABLE po_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY po_lines_parent ON po_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM purchase_orders o
      WHERE o.id = po_lines.po_id
        AND app_has_location(o.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM purchase_orders o
      WHERE o.id = po_lines.po_id
        AND app_has_location(o.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  );

ALTER TABLE po_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY po_receipts_loc_role ON po_receipts FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM purchase_orders o
      WHERE o.id = po_receipts.po_id
        AND app_has_location(o.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM purchase_orders o
      WHERE o.id = po_receipts.po_id
        AND app_has_location(o.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  );

ALTER TABLE po_receipt_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE po_receipt_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY po_receipt_lines_parent ON po_receipt_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM po_receipts pr
      JOIN purchase_orders o ON o.id = pr.po_id
      WHERE pr.id = po_receipt_lines.po_receipt_id
        AND app_has_location(o.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM po_receipts pr
      JOIN purchase_orders o ON o.id = pr.po_id
      WHERE pr.id = po_receipt_lines.po_receipt_id
        AND app_has_location(o.location_id)
        AND current_setting('app.role', true) IN ('owner','manager','finance','kepala_gudang','supervisor')
    )
  );

-- =============================================================================
-- RLS — petty_cash: LOC ; petty_cash_lines: PARENT
-- =============================================================================

ALTER TABLE petty_cash ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash FORCE ROW LEVEL SECURITY;
CREATE POLICY petty_cash_loc ON petty_cash FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE petty_cash_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE petty_cash_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY petty_cash_lines_parent ON petty_cash_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM petty_cash pc
      WHERE pc.id = petty_cash_lines.petty_cash_id AND app_has_location(pc.location_id)
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM petty_cash pc
      WHERE pc.id = petty_cash_lines.petty_cash_id AND app_has_location(pc.location_id)
    )
  );

COMMIT;
