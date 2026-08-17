-- Migration: 036_goods_receipts
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: goods receipts — outlet-side inbound receiving OUTSIDE the SJ
--              and PO flows (supplier-direct-to-outlet deliveries, PRD 8.6.1;
--              and blind receipts of unmatched deliveries).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE goods_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number VARCHAR(30) UNIQUE NOT NULL,    -- 'GR/YYYYMM/nnnn' or device-local
  receipt_type VARCHAR(20) NOT NULL CHECK (receipt_type IN ('supplier_direct','unmatched_delivery')),
  location_id UUID NOT NULL REFERENCES locations(id),         -- receiving location
  ref_id UUID,                                   -- optional link (e.g. suspected sj_drops.id for unmatched)
  received_by UUID NOT NULL REFERENCES users(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft','confirmed')),
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON goods_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE goods_receipt_lines (               -- WHERE the goods were put away (D-15)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  qty_expected NUMERIC(14,3) NOT NULL,
  qty_received NUMERIC(14,3) NOT NULL,
  discrepancy_reason TEXT,                       -- REQUIRED when qty_received <> qty_expected
  UNIQUE (receipt_id, item_id, storage_area_id)
);
-- Confirming a goods_receipt posts transfer_in (per area) via StockLedgerService (FR-LOG-16).

COMMIT;
