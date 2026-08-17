-- Migration: 040_purchase_requests
-- Block: 040-049 (purchasing: PR, PO, receiving, petty cash)
-- Description: purchase requests (PRD 8.6.2 "Request Pembelian").
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE purchase_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_number VARCHAR(30) UNIQUE NOT NULL,         -- 'PR/YYYYMM/nnnn'
  location_id UUID NOT NULL REFERENCES locations(id),   -- warehouse; or outlet for direct purchase
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','submitted','approved','rejected','converted','cancelled')),
  requested_by UUID NOT NULL REFERENCES users(id),
  needed_by DATE,
  approval_id UUID REFERENCES approvals(id),
  rejection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON purchase_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE purchase_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  est_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  suggested_supplier_id UUID REFERENCES suppliers(id),
  UNIQUE (pr_id, item_id)
);

COMMIT;
