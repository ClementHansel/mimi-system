-- Migration: 071_maintenance_schedules
-- Block: 070-079 (assets & maintenance, PMS)
-- Description: recurring schedules (FR-PMS-02) + reminder (FR-PMS-03).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE maintenance_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,                    -- 'Service AC', 'Ganti Oli'
  interval_type VARCHAR(10) NOT NULL CHECK (interval_type IN ('days','months')),
  interval_value INTEGER NOT NULL CHECK (interval_value > 0),   -- AC = months:3
  last_done_at DATE,
  next_due_at DATE NOT NULL,
  reminder_days_before INTEGER NOT NULL DEFAULT 7,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Daily job: schedules due within reminder window => notification 'maintenance_due' + auto-create
-- maintenance_job(status='due').

CREATE TRIGGER set_updated_at BEFORE UPDATE ON maintenance_schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
