-- =============================================================================
-- B-15 permission keys.
--
-- `permissions` / `role_permissions` are seeded once in 009 from a literal
-- matrix; the authoritative matrix is `packages/shared/src/rbac.ts`, and these
-- rows are the offline-display cache kept in step by hand for keys added after
-- 009 (same note as 226).
--
-- `approval.code.issue` — may ask the server to mint a one-time approval code.
-- It goes to every role that approves anything, and it is deliberately COARSE:
-- holding the key only gets you as far as the service, which then checks that
-- this specific user is an eligible approver for THIS document's current step
-- (`eligibleActorsForAction`, §5.2) and holds its location. Two gates, because
-- a permission key cannot express "eligible for this step of this document"
-- and the state machine should not be re-stated in a grant table.
--
-- `auth.lockout.clear` — may unlock a caller who burned their attempts. Also
-- coarse on purpose: the RANK comparison (Q6 — the clearer must outrank the
-- locked user) is enforced in the service against `ROLE_RANK`, so a supervisor
-- can free a kasir but not another supervisor.
-- =============================================================================

BEGIN;

INSERT INTO permissions (key) VALUES
  ('approval.code.issue'),
  ('auth.lockout.clear')
ON CONFLICT (key) DO NOTHING;

-- Every approving role. Kasir, driver and leader_outlet are excluded: none of
-- them is a named approver on any chain, so the key would be dead weight that
-- reads like an authorization.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'approval.code.issue'
   AND r.key IN ('owner', 'manager', 'finance', 'kepala_gudang', 'supervisor', 'hr_admin', 'superadmin')
ON CONFLICT DO NOTHING;

-- Supervisor is included because the common case is a locked KASIR at the till
-- and the supervisor is the person actually standing there. The rank rule stops
-- that from becoming "supervisors unlock each other".
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'auth.lockout.clear'
   AND r.key IN ('owner', 'manager', 'supervisor', 'hr_admin', 'kepala_gudang', 'superadmin')
ON CONFLICT DO NOTHING;

COMMIT;
