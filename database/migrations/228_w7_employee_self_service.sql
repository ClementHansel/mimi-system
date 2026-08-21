-- =============================================================================
-- W7 — the Employee interface's own data.
--
-- Owner's ruling (2026-08-21): `/me` became its own interface — "the interface
-- that employee will see to see their own personal data, loan req, leave req,
-- absency, contracts and everything about themself".
--
-- Attendance and leave already worked for everyone (`hr.attendance.check` and
-- `hr.leave.request` are universal in `rbac.ts`), and so did payslips
-- (`payroll.slip.read.own`). Two things did not:
--
--  1. PERSONAL DATA. `GET /hr/employees/:id` is gated `hr.employee.read` — an
--     office permission — so a Kasir could not read their OWN employee record:
--     name, NIK, position, join date, bank account. RLS was never the blocker
--     (migration 069's `employees_scope` already carries `app_is_self(user_id)`);
--     the API had no self-scoped route. Hence `hr.employee.read.own`.
--
--  2. LOANS (kasbon). Reading and requesting were both office-only. Requesting
--     your own kasbon is the whole point of the feature for the person taking
--     it out, so `payroll.loan.read.own` + `payroll.loan.request.own`.
--
-- Contracts are deliberately NOT part of this migration: there is no contracts
-- table anywhere in the schema, so "see my contract" is a new domain object
-- (schema + HR management + employee view), not a permission gap. Flagged
-- rather than faked with an empty tab.
--
-- `permissions`/`role_permissions` are the offline-display cache seeded in 009
-- from a literal matrix; the authority is `packages/shared/src/rbac.ts`, which
-- gains the same three keys in this commit. Same hand-sync rule migration 226
-- documents for the chat keys.
-- =============================================================================

BEGIN;

INSERT INTO permissions (key) VALUES
  ('hr.employee.read.own'),
  ('payroll.loan.read.own'),
  ('payroll.loan.request.own')
ON CONFLICT (key) DO NOTHING;

-- Every role, driver and kasir included: a person with no location scope still
-- has a self, and these keys grant access to nothing but that self.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key IN ('hr.employee.read.own', 'payroll.loan.read.own', 'payroll.loan.request.own')
ON CONFLICT DO NOTHING;

-- ---------------------------------------------------------------------------
-- RLS: an employee may RAISE their own kasbon request.
--
-- `employee_loans_scope` (069) reads self rows already, but its WITH CHECK is
-- office-only, so any INSERT by the borrower failed. Rather than widen that
-- policy — its WITH CHECK also governs UPDATE, and widening it would let an
-- employee rewrite an ACTIVE loan back to `pending` with `outstanding` reset,
-- i.e. erase their own debt — this adds ONE narrow INSERT-only policy.
-- Permissive policies OR together, so the office path is untouched.
--
-- INSERT: only a row that is a genuine, undecided request for yourself.
-- `outstanding = principal` is what the service writes for a new loan; a row
-- that arrives claiming anything else is not a fresh request.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS employee_loans_self_request ON employee_loans;
CREATE POLICY employee_loans_self_request ON employee_loans FOR INSERT
  WITH CHECK (
    EXISTS (SELECT 1 FROM employees e WHERE e.id = employee_loans.employee_id AND app_is_self(e.user_id))
    AND status = 'pending'
    AND approved_by IS NULL
    AND disbursed_at IS NULL
    AND outstanding = principal
  );

-- NO self UPDATE policy, deliberately.
--
-- The obvious companion to the INSERT above is "let the borrower amend their own
-- pending request", and it is a trap. Postgres ORs the USING clauses of all
-- permissive policies together and, separately, ORs their WITH CHECK clauses —
-- they are not paired per policy. `employee_loans_scope` (069) already carries a
-- self clause in its USING, so ANY self-UPDATE policy's WITH CHECK combines with
-- it: an employee could take their own ACTIVE loan, set `status='pending'` and
-- `outstanding=principal`, and pass — erasing their own debt. An integration
-- test caught exactly that during this change.
--
-- So the borrower gets INSERT only. `LoansService.create` was restructured to
-- submit the approval BEFORE the insert and write `approval_id` in the same
-- statement, so no UPDATE is needed on the self path at all. Amending a pending
-- request goes through the office, like every other change to the row.

COMMIT;
