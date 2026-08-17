-- Migration: 072_maintenance_jobs
-- Block: 070-079 (assets & maintenance, PMS)
-- Description: jobs — execution of a schedule, or corrective.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE maintenance_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number VARCHAR(30) UNIQUE NOT NULL,
  asset_id UUID NOT NULL REFERENCES assets(id),
  schedule_id UUID REFERENCES maintenance_schedules(id),
  type VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (type IN ('scheduled','corrective')),
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN
    ('scheduled','due','in_progress','done','verified','skipped')),
  due_date DATE,
  assigned_to UUID REFERENCES employees(id),
  completed_by UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  cost NUMERIC(18,2),
  verified_by UUID REFERENCES users(id),         -- Supervisor/Manager verifikasi (PRD 14.5)
  verified_at TIMESTAMPTZ,
  payment_verification_id UUID,                  -- FK added in block 090 (fk_mj_pv; FR-ACCT-04 biaya maintenance)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Wajib bukti servis (FR-PMS-04): attachments(kind='service_proof') required for status='done'.

CREATE TRIGGER set_updated_at BEFORE UPDATE ON maintenance_jobs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
