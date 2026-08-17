-- Migration: 081_returns
-- Block: 080-089 (waste & returns)
-- Description: returns, both directions (PRD 8.8.1 outlet->gudang, 8.8.2
--              gudang->supplier).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number VARCHAR(30) UNIQUE NOT NULL,     -- 'RET/YYYYMM/nnnn'
  direction VARCHAR(30) NOT NULL CHECK (direction IN ('outlet_to_warehouse','warehouse_to_supplier')),
  from_location_id UUID NOT NULL REFERENCES locations(id),
  to_location_id UUID REFERENCES locations(id),  -- NULL when direction = warehouse_to_supplier
  supplier_id UUID REFERENCES suppliers(id),     -- required when warehouse_to_supplier
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','submitted','approved','rejected','in_transit','received','completed','cancelled')),
  requested_by UUID NOT NULL REFERENCES users(id),     -- FR-WST-02
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  shipped_at TIMESTAMPTZ,                        -- bukti kirim = attachments kind='return_proof' (FR-WST-03)
  received_by UUID REFERENCES users(id),
  received_at TIMESTAMPTZ,                       -- bukti terima = attachments kind='receiving_photo' (FR-WST-03)
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (direction <> 'warehouse_to_supplier' OR supplier_id IS NOT NULL),
  CHECK (direction <> 'outlet_to_warehouse' OR to_location_id IS NOT NULL)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id), -- source area at from_location
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),    -- FR-WST-01 jumlah
  condition VARCHAR(20) NOT NULL CHECK (condition IN ('damaged','expired','wrong_item','quality','other')),
  reason TEXT NOT NULL,                          -- FR-WST-01 alasan
  qty_received NUMERIC(14,3),
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  UNIQUE (return_id, item_id)
);
-- Ship posts return_out at from_location; receive posts return_in at to_location (or AP credit for
-- supplier) — FR-WST-04, §6.

COMMIT;
