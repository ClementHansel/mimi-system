-- Migration: 062_attendance
-- Block: 060-069 (HR & payroll)
-- Description: attendance (FR-HR-01: GPS geofence 100m + selfie; FR-HR-03
--              inputs).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  date DATE NOT NULL,
  shift_assignment_id UUID REFERENCES shift_assignments(id),
  check_in_at TIMESTAMPTZ,
  check_in_lat NUMERIC(9,6),
  check_in_lng NUMERIC(9,6),
  check_in_distance_m INTEGER,                   -- computed vs location geofence
  check_in_selfie_attachment_id UUID REFERENCES attachments(id),  -- wajib (FR-HR-01)
  check_in_device_id UUID,                       -- FK added in block 110 (fk_att_device)
  check_out_at TIMESTAMPTZ,
  check_out_lat NUMERIC(9,6),
  check_out_lng NUMERIC(9,6),
  check_out_distance_m INTEGER,
  check_out_selfie_attachment_id UUID REFERENCES attachments(id),
  status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (status IN
    ('present','late','absent','sick','permission','leave','holiday','off')),
  late_minutes INTEGER NOT NULL DEFAULT 0,       -- POUT-07
  overtime_minutes INTEGER NOT NULL DEFAULT 0,   -- PIN-02 (beyond shift end; policy in settings)
  work_minutes INTEGER,
  geofence_ok BOOLEAN NOT NULL DEFAULT true,
  corrected_by UUID REFERENCES users(id),        -- HR manual correction
  correction_reason TEXT,                        -- REQUIRED when corrected (FR-AUDIT-02)
  client_id UUID UNIQUE,                         -- offline check-in idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON attendance
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
