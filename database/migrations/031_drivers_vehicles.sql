-- Migration: 031_drivers_vehicles
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: drivers & vehicles (D-14, master data referenced by SJ).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID,                              -- FK added in block 060 (employees created later)
  user_id UUID UNIQUE REFERENCES users(id),      -- login for F13 driver surface (role 'driver')
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(30),
  license_number VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON drivers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number VARCHAR(20) UNIQUE NOT NULL,
  type VARCHAR(30) NOT NULL DEFAULT 'van',       -- 'van','truck','pickup','motorcycle'
  brand VARCHAR(100),
  model VARCHAR(100),
  has_freezer BOOLEAN NOT NULL DEFAULT false,    -- cold-chain capable (FR-LOG-02)
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON vehicles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
