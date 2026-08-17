-- Migration: 032_shipment_types
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: shipment types as data (FR-LOG-02): seeded 'frozen' + 'dry'.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE shipment_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(20) UNIQUE NOT NULL,               -- 'frozen','dry'
  name VARCHAR(50) NOT NULL,                     -- 'Frozen','Barang Kering'
  requires_temperature_log BOOLEAN NOT NULL DEFAULT false,
  requires_seal BOOLEAN NOT NULL DEFAULT false,
  temp_min NUMERIC(4,1),
  temp_max NUMERIC(4,1),                         -- frozen seeded -25.0 .. -15.0; breach when outside
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO shipment_types (key, name, requires_temperature_log, requires_seal, temp_min, temp_max) VALUES
  ('frozen', 'Frozen', true, true, -25.0, -15.0),
  ('dry', 'Barang Kering', false, false, NULL, NULL)
ON CONFLICT (key) DO NOTHING;

COMMIT;
