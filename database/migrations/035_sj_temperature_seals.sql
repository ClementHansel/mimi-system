-- Migration: 035_sj_temperature_seals
-- Block: 030-039 (replenishment + Surat Jalan logistics, D-14)
-- Description: cold chain — temperature at load and at EVERY drop; seals.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE sj_temperature_logs (               -- append-only
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_id UUID REFERENCES sj_drops(id) ON DELETE CASCADE,     -- NULL = measured at load (warehouse)
  stage VARCHAR(10) NOT NULL CHECK (stage IN ('load','depart','arrive')),
  temp_c NUMERIC(4,1) NOT NULL,
  is_breach BOOLEAN NOT NULL DEFAULT false,      -- computed vs shipment_types.temp_min/max at insert
  logged_by UUID REFERENCES users(id),
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  client_id UUID UNIQUE
);
-- is_breach=true => NotificationService 'cold_chain_breach' to KGD + Manager + Owner.

CREATE TABLE sj_seals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_id UUID REFERENCES sj_drops(id) ON DELETE CASCADE,     -- NULL = applied at load
  seal_number VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'applied' CHECK (status IN
    ('applied','verified_intact','broken','replaced')),
  checked_by UUID REFERENCES users(id),
  checked_at TIMESTAMPTZ,
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
