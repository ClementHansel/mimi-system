-- Migration: 060_employees
-- Block: 060-069 (HR & payroll)
-- Description: employees & employment history. Resolves two forward
--              references left dangling by earlier blocks: drivers.employee_id
--              (block 031) and cash_variance_proposals.employee_id
--              (block 054, Amendment 2 retro-FK).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number VARCHAR(30) UNIQUE NOT NULL,
  user_id UUID UNIQUE REFERENCES users(id),      -- nullable: not every employee gets a login
  name VARCHAR(255) NOT NULL,
  nik VARCHAR(30),                               -- KTP number
  phone VARCHAR(30),
  email VARCHAR(255),
  address TEXT,
  birth_date DATE,
  join_date DATE NOT NULL,                       -- feeds tunjangan masa kerja (PIN-05)
  employment_status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (employment_status IN
    ('active','probation','resigned','terminated')),
  position VARCHAR(100) NOT NULL,                -- feeds tunjangan jabatan (PIN-06)
  location_id UUID NOT NULL REFERENCES locations(id),  -- home location
  bank_name VARCHAR(100),
  bank_account_number VARCHAR(50),
  bank_account_name VARCHAR(255),
  photo_attachment_id UUID REFERENCES attachments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE drivers ADD CONSTRAINT fk_drivers_employee
  FOREIGN KEY (employee_id) REFERENCES employees(id);
ALTER TABLE cash_variance_proposals ADD CONSTRAINT fk_cvp_employee
  FOREIGN KEY (employee_id) REFERENCES employees(id);          -- Amendment 2 retro-FK

CREATE TABLE employments (                       -- position/salary history; current row has end_date NULL
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  position VARCHAR(100) NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  base_salary NUMERIC(18,2) NOT NULL,            -- PIN-01
  start_date DATE NOT NULL,
  end_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON employments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
