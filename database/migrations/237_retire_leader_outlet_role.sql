-- =============================================================================
-- Retire `leader_outlet` (owner decision, 2026-08-23).
--
-- An outlet shift is a supervisor, a cashier and two cooks. There is no
-- "Leader/Staff Outlet" in that model, and since the `koki` role arrived (234)
-- the role has had ZERO holders — it existed only as a slot the seed used to
-- fill because cooks had nowhere else to go.
--
-- ## Retired, not deleted — and this is the recommendation, not a shortcut
--
-- Deleting the role would mean dropping the `roles` row and stripping the value
-- from `RoleKey` and the RBAC matrix. That is the wrong call here for three
-- concrete reasons:
--
--   1. HISTORY REFERENCES IT. `approvals.requested_by_role`, `audit_log` and
--      sync-event payloads carry the literal string `leader_outlet` on rows that
--      already happened. Removing the role makes those rows unreadable — a
--      document would show an approver whose role the system can no longer name.
--      In an operation with fraud controls, silently un-naming a past actor is
--      worse than carrying a dead enum value.
--   2. `RBAC_ROLE_ORDER`'s positions ARE column indexes into all 150 matrix
--      rows. Dropping a column mid-array re-maps every role after it unless all
--      150 rows are rewritten in the same commit — a mechanical edit with a
--      silent, total failure mode, done for no functional gain.
--   3. 266 references across 68 files, most of them specs that use
--      `RoleKey.LEADER_OUTLET` to assert what an outlet-floor role may and may
--      not do. Those assertions are still true statements about the matrix.
--
-- So the identity is decommissioned instead: it cannot be assigned to anybody
-- from now on, it is gone from every surface where a human could pick it, and it
-- remains interpretable wherever history already mentions it. That is the
-- standard way to retire a role that has been in production.
--
-- The enforcement lives in TWO places on purpose, because the RBAC matrix is
-- code and this table is its offline cache: `roles.retired_at` here, checked by
-- `UsersService.assertCanGrantRole`, and `ROLE_SENIORITY` in the frontend, which
-- is what stops the picker offering it. The server check is the real one.
-- =============================================================================

BEGIN;

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS retired_at TIMESTAMPTZ;

COMMENT ON COLUMN roles.retired_at IS
  'When set, this role may no longer be assigned to any user. It stays in the table so historical rows that name it (approvals.requested_by_role, audit_log, sync payloads) remain interpretable.';

-- Refuse to retire a role somebody still holds. Retiring an occupied role would
-- leave those people in a state the system will not let anyone re-create, which
-- is a trap rather than a decommission.
DO $$
DECLARE
  holders bigint;
BEGIN
  SELECT count(*) INTO holders
    FROM users u
    JOIN roles r ON r.id = u.role_id
   WHERE r.key = 'leader_outlet' AND u.is_active;

  IF holders > 0 THEN
    RAISE EXCEPTION
      'cannot retire leader_outlet: % active user(s) still hold it — move them to koki, kasir or supervisor first',
      holders;
  END IF;
END $$;

UPDATE roles
   SET retired_at = NOW(),
       -- The label carries the retirement so a historical row renders honestly
       -- wherever it is shown, without the reader needing to know about a column.
       name = 'Leader/Staff Outlet (nonaktif)'
 WHERE key = 'leader_outlet'
   AND retired_at IS NULL;

-- Its grants go too. The RBAC matrix in `packages/shared/src/rbac.ts` is what
-- `PermissionsGuard` actually reads, so this is the cache catching up — but
-- leaving 44 permission rows attached to a retired role would misrepresent it
-- to anything reading the database directly (including the offline display
-- cache this table exists for).
DELETE FROM role_permissions
 WHERE role_id = (SELECT id FROM roles WHERE key = 'leader_outlet');

COMMIT;
