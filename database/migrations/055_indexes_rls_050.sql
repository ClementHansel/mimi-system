-- Migration: 055_indexes_rls_050
-- Block: 050-059 (POS, offline-first origin data)
-- Description: indexes + RLS for block 050-059.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_pos_shifts_location ON pos_shifts(location_id);
CREATE INDEX idx_pos_shifts_device ON pos_shifts(device_id);
CREATE INDEX idx_pos_shifts_opened_by ON pos_shifts(opened_by);
CREATE INDEX idx_pos_shifts_status ON pos_shifts(status);

CREATE INDEX idx_sales_location ON sales(location_id);
CREATE INDEX idx_sales_shift ON sales(shift_id);
CREATE INDEX idx_sales_kasir ON sales(kasir_id);
CREATE INDEX idx_sales_status ON sales(status);
CREATE INDEX idx_sales_occurred_at ON sales(occurred_at DESC);
CREATE INDEX idx_sale_lines_sale ON sale_lines(sale_id);
CREATE INDEX idx_sale_lines_product ON sale_lines(product_id);
CREATE INDEX idx_sale_payments_sale ON sale_payments(sale_id);
CREATE INDEX idx_sale_payments_status ON sale_payments(payment_status);

CREATE INDEX idx_void_refunds_sale ON void_refunds(sale_id);
CREATE INDEX idx_void_refunds_status ON void_refunds(status);

CREATE INDEX idx_online_orders_location ON online_orders(location_id);
CREATE INDEX idx_online_orders_platform ON online_orders(platform);
CREATE INDEX idx_online_orders_order_date ON online_orders(order_date);
CREATE INDEX idx_online_orders_settlement ON online_orders(settlement_status);

CREATE INDEX idx_cash_variance_proposals_location ON cash_variance_proposals(location_id);
CREATE INDEX idx_cash_variance_proposals_status ON cash_variance_proposals(status);
CREATE INDEX idx_cash_variance_proposals_kasir ON cash_variance_proposals(kasir_user_id);

-- =============================================================================
-- RLS — LOC group: pos_shifts, sales, void_refunds, online_orders,
-- cash_variance_proposals
-- =============================================================================

ALTER TABLE pos_shifts ENABLE ROW LEVEL SECURITY;
ALTER TABLE pos_shifts FORCE ROW LEVEL SECURITY;
CREATE POLICY pos_shifts_loc ON pos_shifts FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_loc ON sales FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE void_refunds ENABLE ROW LEVEL SECURITY;
ALTER TABLE void_refunds FORCE ROW LEVEL SECURITY;
CREATE POLICY void_refunds_loc ON void_refunds FOR ALL
  USING (
    EXISTS (SELECT 1 FROM sales s WHERE s.id = void_refunds.sale_id AND app_has_location(s.location_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM sales s WHERE s.id = void_refunds.sale_id AND app_has_location(s.location_id))
  );

ALTER TABLE online_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE online_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY online_orders_loc ON online_orders FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

ALTER TABLE cash_variance_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_variance_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY cash_variance_proposals_loc ON cash_variance_proposals FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

-- =============================================================================
-- RLS — PARENT group: sale_lines, sale_payments (via sales.location_id)
-- =============================================================================

ALTER TABLE sale_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY sale_lines_parent ON sale_lines FOR ALL
  USING (
    EXISTS (SELECT 1 FROM sales s WHERE s.id = sale_lines.sale_id AND app_has_location(s.location_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM sales s WHERE s.id = sale_lines.sale_id AND app_has_location(s.location_id))
  );

ALTER TABLE sale_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE sale_payments FORCE ROW LEVEL SECURITY;
CREATE POLICY sale_payments_parent ON sale_payments FOR ALL
  USING (
    EXISTS (SELECT 1 FROM sales s WHERE s.id = sale_payments.sale_id AND app_has_location(s.location_id))
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM sales s WHERE s.id = sale_payments.sale_id AND app_has_location(s.location_id))
  );

COMMIT;
