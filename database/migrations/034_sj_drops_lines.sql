-- Migration: 034_sj_drops_lines
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: multi-drop route — per-drop timestamps, signature, photo,
--              discrepancy.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE sj_drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_seq INTEGER NOT NULL,                     -- route order
  location_id UUID NOT NULL REFERENCES locations(id),         -- destination outlet
  replenishment_request_id UUID REFERENCES replenishment_requests(id),
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','en_route','arrived','completed','completed_discrepancy','failed')),
  departed_at TIMESTAMPTZ,                       -- per-drop departure (D-14)
  arrived_at TIMESTAMPTZ,                        -- per-drop arrival
  received_by UUID REFERENCES users(id),         -- outlet staff (FR-LOG-14)
  received_at TIMESTAMPTZ,
  signature_attachment_id UUID REFERENCES attachments(id),    -- receiving signature (D-14)
  discrepancy_notes TEXT,
  failure_reason TEXT,                           -- REQUIRED when status='failed'
  client_id UUID UNIQUE,                         -- driver/outlet offline idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sj_id, drop_seq)
);
-- Receiving photo (FR-LOG-15, wajib): attachments(entity_type='sj_drop', entity_id=drop.id,
-- kind='receiving_photo') — enforced at receive.

CREATE TRIGGER set_updated_at BEFORE UPDATE ON sj_drops
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sj_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_id UUID NOT NULL REFERENCES sj_drops(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  qty_received NUMERIC(14,3),                    -- set at receiving; NULL until then
  received_storage_area_id UUID REFERENCES storage_areas(id), -- putaway area chosen at receiving (D-15)
  discrepancy_reason TEXT,                       -- REQUIRED when qty_received <> qty
  request_line_id UUID REFERENCES replenishment_request_lines(id),
  UNIQUE (drop_id, item_id)
);
-- SJ receiving is the sj_drops.received sync event (SYNC-PROTOCOL §3.3 group 4): it updates sj_drops,
-- sj_lines.qty_received + received_storage_area_id, and posts transfer_in movements directly. It does NOT
-- create a goods_receipts row — goods_receipts is reserved for the flows in 036.

COMMIT;
