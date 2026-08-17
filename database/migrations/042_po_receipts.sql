-- Migration: 042_po_receipts
-- Block: 040-049 (purchasing: PR, PO, receiving, petty cash)
-- Description: PO receiving (FR-PO-02..04).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE po_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number VARCHAR(30) UNIQUE NOT NULL,
  po_id UUID NOT NULL REFERENCES purchase_orders(id),
  received_by UUID NOT NULL REFERENCES users(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Bukti receiving (FR-PO-04): attachments(entity_type='po_receipt', kind='receiving_photo'), required to verify.

CREATE TRIGGER set_updated_at BEFORE UPDATE ON po_receipts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE po_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_receipt_id UUID NOT NULL REFERENCES po_receipts(id) ON DELETE CASCADE,
  po_line_id UUID NOT NULL REFERENCES po_lines(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id), -- putaway area (D-15)
  qty_received NUMERIC(14,3) NOT NULL CHECK (qty_received >= 0),
  condition_notes TEXT,                          -- FR-PO-03 discrepancy note
  UNIQUE (po_receipt_id, po_line_id, storage_area_id)
);
-- Verifying a po_receipt posts purchase_in via ledger, updates po_lines.qty_received,
-- items.avg_cost/last_purchase_cost, supplier_price_history, and emits GUDANG_PURCHASE (§6).

COMMIT;
