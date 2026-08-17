-- Migration: 063_leave_requests
-- Block: 060-069 (HR & payroll)
-- Description: leave (F-HR-06; POUT-01/02/04; quotas in settings:
--              annual=12, marriage=3).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  type VARCHAR(20) NOT NULL CHECK (type IN ('annual','marriage','sick','permission','unpaid')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(4,1) NOT NULL,
  reason TEXT,
  attachment_id UUID REFERENCES attachments(id), -- surat dokter etc.
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approval_id UUID REFERENCES approvals(id),
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  rejection_reason TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON leave_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
