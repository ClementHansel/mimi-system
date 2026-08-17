-- Migration: 023_stock_opname
-- Block: 020-029 (stock)
-- Description: stock opname (FR-SO-01..04); countable per storage area (D-15).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE stock_opname (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opname_number VARCHAR(30) UNIQUE NOT NULL,     -- 'OPN/YYYYMM/nnnn' (cloud) or device-local
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID REFERENCES storage_areas(id),  -- NULL = whole location (lines carry area)
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','counting','submitted','approved','rejected','adjusted','cancelled')),
  counted_by UUID NOT NULL REFERENCES users(id), -- FR-SO-01: who
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- FR-SO-01: when
  submitted_at TIMESTAMPTZ,
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  notes TEXT,
  client_id UUID UNIQUE,                         -- offline idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON stock_opname
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE stock_opname_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opname_id UUID NOT NULL REFERENCES stock_opname(id) ON DELETE CASCADE,
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  system_qty NUMERIC(14,3) NOT NULL,             -- snapshot at submit time (FR-SO-02)
  counted_qty NUMERIC(14,3) NOT NULL,
  diff_qty NUMERIC(14,3) NOT NULL,               -- counted - system; engine recomputes, never trusts client
  variance_reason TEXT,                          -- REQUIRED when diff_qty <> 0 (FR-SO-02)
  UNIQUE (opname_id, storage_area_id, item_id)
);

COMMIT;
