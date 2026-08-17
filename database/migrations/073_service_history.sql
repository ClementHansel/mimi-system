-- Migration: 073_service_history
-- Block: 070-079 (assets & maintenance, PMS)
-- Description: service history (FR-PMS-04 riwayat servis + kondisi per unit).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE service_history (                   -- append-only
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  job_id UUID REFERENCES maintenance_jobs(id),
  service_date DATE NOT NULL,
  description TEXT NOT NULL,
  vendor VARCHAR(255),
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  condition_after VARCHAR(10) NOT NULL CHECK (condition_after IN ('good','fair','poor','broken')),
  odometer_km INTEGER,                           -- vehicles
  recorded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
