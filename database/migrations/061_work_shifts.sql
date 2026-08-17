-- Migration: 061_work_shifts
-- Block: 060-069 (HR & payroll)
-- Description: shifts & roster (FR-HR-02).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE work_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),     -- NULL = global template
  name VARCHAR(50) NOT NULL,                     -- 'Pagi','Sore','Malam'
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,                        -- may wrap past midnight (end < start)
  break_minutes INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON work_shifts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE shift_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_shift_id UUID REFERENCES work_shifts(id), -- NULL = day off ('libur')
  location_id UUID NOT NULL REFERENCES locations(id),
  date DATE NOT NULL,
  assigned_by UUID NOT NULL REFERENCES users(id),      -- supervisor (FR-HR-02)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON shift_assignments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
