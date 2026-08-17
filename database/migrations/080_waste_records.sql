-- Migration: 080_waste_records
-- Block: 080-089 (waste & returns)
-- Description: waste (PRD 8.8; FR-WST-01..04). One row per wasted item;
--              batch_id groups a single waste event reported together.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE waste_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  waste_number VARCHAR(30) UNIQUE NOT NULL,
  batch_id UUID NOT NULL,                        -- groups items reported together in the UI
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,    -- avg_cost at approval; feeds §6 GUDANG/OUTLET_WASTE
  reason VARCHAR(30) NOT NULL CHECK (reason IN
    ('expired','damaged','lost','contaminated','cold_chain_breach','production_error','other')),
  reason_detail TEXT,                            -- FR-WST-01 alasan + kondisi
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reported_by UUID NOT NULL REFERENCES users(id),      -- FR-WST-02 siapa mengajukan
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),               -- FR-WST-02 siapa menyetujui
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Wajib foto (FR-WST-01): attachments(entity_type='waste_record', kind='waste_photo') required to submit.
-- Approval posts waste_out via ledger (FR-WST-04) + journal (§6).

CREATE TRIGGER set_updated_at BEFORE UPDATE ON waste_records
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
