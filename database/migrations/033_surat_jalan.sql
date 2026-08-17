-- Migration: 033_surat_jalan
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: Surat Jalan. One SJ = one vehicle run; frozen and dry NEVER
--              share an SJ (FR-LOG-02).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE surat_jalan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_number VARCHAR(30) UNIQUE NOT NULL,         -- 'SJ/YYYYMM/nnnn' — cloud-issued (warehouse creates online)
  origin_location_id UUID NOT NULL REFERENCES locations(id),   -- gudang pusat
  shipment_type_id UUID NOT NULL REFERENCES shipment_types(id),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','ready','loading','in_transit','completed','cancelled')),
  planned_date DATE NOT NULL,                    -- FR-LOG-03 flexible frequency
  dispatched_at TIMESTAMPTZ,                     -- stock leaves warehouse here (ledger transfer_out -> in-transit)
  completed_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON surat_jalan
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE replenishment_requests
  ADD CONSTRAINT fk_rr_sj FOREIGN KEY (sj_id) REFERENCES surat_jalan(id);

COMMIT;
