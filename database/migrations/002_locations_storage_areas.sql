-- Migration: 002_locations_storage_areas
-- Block: 001-009 (core)
-- Description: locations (THE scoping dimension, D-05) + storage_areas (D-15).
-- Created at: 2026-08-16

BEGIN;

-- One row per gudang pusat / outlet. THE scoping dimension (D-05). No tenant_id.
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) UNIQUE NOT NULL,              -- used in doc numbers, e.g. 'GDG', 'BPP01'
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('warehouse','outlet')),
  city VARCHAR(100) NOT NULL,                    -- 4 Kalimantan cities; topology level 2
  address TEXT,
  phone VARCHAR(30),
  latitude NUMERIC(9,6),
  longitude NUMERIC(9,6),                        -- geofence centre (FR-HR-01)
  geofence_radius_m INTEGER NOT NULL DEFAULT 100,
  timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Makassar',
  is_active BOOLEAN NOT NULL DEFAULT true,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON locations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Typed storage areas inside a location (D-15). Stock lives per area.
CREATE TABLE storage_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('freezer','chiller','dry_store','display','kitchen_line')),
  temp_min NUMERIC(4,1),
  temp_max NUMERIC(4,1),                         -- expected range; breach alerts compare against this
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, code)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON storage_areas
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
