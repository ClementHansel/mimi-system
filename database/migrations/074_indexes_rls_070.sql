-- Migration: 074_indexes_rls_070
-- Block: 070-079 (assets & maintenance, PMS)
-- Description: indexes + RLS for block 070-079. Per §1.14, only `assets` is
--              RLS-enabled (LOC); maintenance_schedules/jobs/service_history
--              are NONE (API-gated).
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_assets_location ON assets(location_id);
CREATE INDEX idx_assets_vehicle ON assets(vehicle_id);
CREATE INDEX idx_assets_assigned_to ON assets(assigned_to);
CREATE INDEX idx_assets_status ON assets(status);

CREATE INDEX idx_maintenance_schedules_asset ON maintenance_schedules(asset_id);
CREATE INDEX idx_maintenance_schedules_next_due ON maintenance_schedules(next_due_at);

CREATE INDEX idx_maintenance_jobs_asset ON maintenance_jobs(asset_id);
CREATE INDEX idx_maintenance_jobs_schedule ON maintenance_jobs(schedule_id);
CREATE INDEX idx_maintenance_jobs_status ON maintenance_jobs(status);
CREATE INDEX idx_maintenance_jobs_assigned_to ON maintenance_jobs(assigned_to);

CREATE INDEX idx_service_history_asset ON service_history(asset_id);
CREATE INDEX idx_service_history_job ON service_history(job_id);

-- =============================================================================
-- RLS — assets: LOC
-- =============================================================================

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
CREATE POLICY assets_loc ON assets FOR ALL
  USING (app_has_location(location_id)) WITH CHECK (app_has_location(location_id));

COMMIT;
