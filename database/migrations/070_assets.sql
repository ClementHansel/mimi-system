-- Migration: 070_assets
-- Block: 070-079 (assets & maintenance, PMS)
-- Description: asset inventory (FR-PMS-01).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_number VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(20) NOT NULL CHECK (category IN
    ('machine','vehicle','equipment','electronics','furniture','other')),
  location_id UUID NOT NULL REFERENCES locations(id),
  serial_number VARCHAR(100),
  brand VARCHAR(100),
  model VARCHAR(100),
  purchase_date DATE,
  purchase_price NUMERIC(18,2),
  vehicle_id UUID REFERENCES vehicles(id),       -- link when the asset is a registered delivery vehicle
  condition VARCHAR(10) NOT NULL DEFAULT 'good' CHECK (condition IN ('good','fair','poor','broken')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','in_maintenance','retired','lost')),
  assigned_to UUID REFERENCES employees(id),     -- PIC maintenance (data-level, not a role — Appendix A-3)
  photo_attachment_id UUID REFERENCES attachments(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
