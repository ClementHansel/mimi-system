-- Migration: 030_replenishment_requests
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: replenishment requests (FR-LOG-06..13).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE replenishment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number VARCHAR(30) UNIQUE NOT NULL,    -- 'RR/YYYYMM/nnnn' or device-local
  location_id UUID NOT NULL REFERENCES locations(id),  -- requesting outlet
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','submitted','awaiting_approval','approved','rejected',
    'processing','shipped','received','completed')),          -- the 9 states of FR-LOG-11
  source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto_suggestion')), -- FR-LOG-08/09
  requested_by UUID NOT NULL REFERENCES users(id),             -- FR-LOG-05: who requested
  submitted_at TIMESTAMPTZ,
  needed_by DATE,                                              -- FR-LOG-03: flexible cadence is data, not config
  approval_id UUID REFERENCES approvals(id),
  sj_id UUID,                                                  -- fulfilment link; FK added in 033 (surat_jalan)
  rejection_reason TEXT,                                       -- FR-LOG-13 (also on approval_steps.reason)
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON replenishment_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE replenishment_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty_requested NUMERIC(14,3) NOT NULL CHECK (qty_requested > 0),
  qty_approved NUMERIC(14,3),                    -- set by approver; differs => amend_reason REQUIRED (FR-LOG-13)
  qty_shipped NUMERIC(14,3),
  qty_received NUMERIC(14,3),
  amend_reason TEXT,
  UNIQUE (request_id, item_id)
);
-- FR-LOG-12 history of qty changes: audit_log rows (interceptor) on every line mutation.

COMMIT;
