-- Migration: 041_purchase_orders
-- Block: 040-049 (purchasing: PR, PO, receiving, petty cash)
-- Description: purchase orders (FR-PO-01..04).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number VARCHAR(30) UNIQUE NOT NULL,         -- FR-PO-01
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  location_id UUID NOT NULL REFERENCES locations(id),   -- deliver-to (gudang, or outlet for direct)
  pr_id UUID REFERENCES purchase_requests(id),
  status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','pending_approval','approved','issued','partially_received','received','closed','cancelled')),
  order_date DATE NOT NULL,
  expected_date DATE,                            -- FR-PO-02 estimasi barang datang
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,        -- FR-PO-01 total nilai pembelian
  approval_id UUID REFERENCES approvals(id),
  payment_verification_id UUID,                  -- FK added in block 090 (fk_po_pv)
  created_by UUID NOT NULL REFERENCES users(id),
  cancel_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE po_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty_ordered NUMERIC(14,3) NOT NULL CHECK (qty_ordered > 0),
  unit_price NUMERIC(18,2) NOT NULL,             -- FR-PO-01 harga beli; writes supplier_price_history(source='po')
  line_total NUMERIC(18,2) NOT NULL,
  qty_received NUMERIC(14,3) NOT NULL DEFAULT 0, -- FR-PO-02/03 diterima vs dipesan
  UNIQUE (po_id, item_id)
);

COMMIT;
