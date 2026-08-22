-- =============================================================================
-- W7 — employment contracts (kontrak kerja).
--
-- Owner's ruling (2026-08-21): the `employee` interface exists so a person can
-- see "their own personal data, loan req, leave req, absency, contracts and
-- everything about themself". Every item on that list existed in some form
-- except contracts, which had no table anywhere in the schema — flagged in
-- migration 228 rather than faked with an empty tab. This is that table.
--
-- WHY NOT `employments`. That table (060) is the position/salary HISTORY that
-- payroll reads: one row per posting, `base_salary` per row, current row has
-- `end_date NULL`. A contract is a different object with a different lifetime:
-- it is the signed agreement, it has a number people quote, a type that carries
-- legal meaning, and a scanned copy. One PKWT can span two positions, and a
-- promotion (a new `employments` row) does not create a new contract. Modelling
-- either as the other would corrupt payroll history or lose the paper trail.
--
-- INDONESIAN LABOUR SHAPE (the reason `contract_type` is not free text):
--   pkwt        — fixed term. MUST have an end_date; expiry is the whole point.
--   pkwtt       — permanent. MUST NOT have an end_date.
--   probation   — masa percobaan, capped at 3 months by law; end_date required.
--   internship  — magang/PKL; end_date required.
-- The CHECK constraints encode exactly that, so a permanent contract cannot be
-- given an expiry date and a fixed-term one cannot be left open-ended — the two
-- mistakes that make an expiry report lie.
--
-- `status` is derived-but-stored on purpose: `active`/`expired` could be
-- computed from dates, but `terminated` (resignation, dismissal) cannot, and a
-- report that mixes a computed state with a recorded one is unreadable. The
-- expiry sweep is a query, not a trigger — nothing here silently rewrites a
-- row behind an HR admin's back.
-- =============================================================================

BEGIN;

CREATE TABLE employment_contracts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_number VARCHAR(40) UNIQUE NOT NULL,        -- 'KONTRAK/YYYYMM/nnnn'
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  contract_type VARCHAR(20) NOT NULL CHECK (contract_type IN
    ('pkwt', 'pkwtt', 'probation', 'internship')),
  position VARCHAR(100) NOT NULL,                     -- as written on the contract
  location_id UUID REFERENCES locations(id),          -- posting; NULL = company-wide
  base_salary NUMERIC(18,2),                          -- as AGREED here; payroll still reads `employments`
  start_date DATE NOT NULL,
  end_date DATE,                                      -- NULL only for pkwtt
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN
    ('draft', 'active', 'expired', 'terminated')),
  signed_at DATE,                                     -- when the paper was actually signed
  -- The scan. `attachments` already stores every uploaded file with its own
  -- RLS; a contract without one is legal but incomplete, so this is nullable
  -- and surfaced in the UI rather than enforced here.
  document_attachment_id UUID REFERENCES attachments(id),
  termination_reason TEXT,
  notes TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- A fixed-term contract without an end date cannot expire, and a permanent
  -- one with an end date is a fixed-term contract mislabelled. Both would make
  -- "which contracts expire next month" wrong, which is the one question this
  -- table has to answer reliably.
  CONSTRAINT contract_term_matches_type CHECK (
    (contract_type = 'pkwtt' AND end_date IS NULL)
    OR (contract_type <> 'pkwtt' AND end_date IS NOT NULL)
  ),
  CONSTRAINT contract_ends_after_start CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT contract_terminated_has_reason CHECK (
    status <> 'terminated' OR termination_reason IS NOT NULL
  )
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON employment_contracts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- "Show me this employee's contracts, newest first" (both the HR list and the
-- employee's own tab) and "what expires soon" (the only proactive question).
CREATE INDEX idx_contracts_employee ON employment_contracts (employee_id, start_date DESC);
CREATE INDEX idx_contracts_expiring ON employment_contracts (end_date)
  WHERE status = 'active' AND end_date IS NOT NULL;

-- ---------------------------------------------------------------------------
-- RLS — mirrors `employees_scope` (069) exactly, deliberately: a contract is as
-- sensitive as the employee record it belongs to, and any looser rule here
-- would be a way around that one. Central HR roles see all; a supervisor sees
-- their own location's people; everyone else sees THEIR OWN contracts only.
--
-- Writes are office-only: there is no self path. An employee reads their
-- contract; they do not author it.
-- ---------------------------------------------------------------------------
ALTER TABLE employment_contracts ENABLE ROW LEVEL SECURITY;

CREATE POLICY employment_contracts_scope ON employment_contracts FOR ALL
  USING (
    current_setting('app.role', true) IN ('owner', 'manager', 'finance', 'hr_admin')
    OR EXISTS (
      SELECT 1 FROM employees e
       WHERE e.id = employment_contracts.employee_id
         AND (
           app_is_self(e.user_id)
           OR (current_setting('app.role', true) = 'supervisor' AND app_has_location(e.location_id))
         )
    )
  )
  WITH CHECK (current_setting('app.role', true) IN ('owner', 'manager', 'finance', 'hr_admin'));

GRANT SELECT, INSERT, UPDATE, DELETE ON employment_contracts TO mimi_app;

-- ---------------------------------------------------------------------------
-- Permission keys (offline-display cache; authority is `packages/shared/rbac.ts`).
-- `hr.contract.read.own` is universal — your own contract is not privileged to
-- you. Reading anyone's, and writing any, is not.
-- ---------------------------------------------------------------------------
INSERT INTO permissions (key) VALUES
  ('hr.contract.read'),
  ('hr.contract.manage'),
  ('hr.contract.read.own')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'hr.contract.read.own'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'hr.contract.read'
   AND r.key IN ('owner', 'manager', 'finance', 'hr_admin', 'supervisor', 'superadmin')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'hr.contract.manage'
   AND r.key IN ('owner', 'hr_admin', 'superadmin')
ON CONFLICT DO NOTHING;

COMMIT;
