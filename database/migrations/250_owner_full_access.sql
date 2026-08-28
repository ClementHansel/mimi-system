-- Migration: 250_owner_full_access
-- Block: 001-009 lineage (identity/RBAC, migrations 003 + 009 + 222).
-- Description: records owner's remaining 24 grants in the role_permissions
--              offline-display cache, so it matches the code matrix now that
--              owner holds every permission key.
-- Created at: 2026-08-27
--
-- WHY. Owner ruling (2026-08-27): "owner and superadmin can do all". It was
-- asked in the narrow case — the shift roster was read-only for owner, because
-- `hr.shift.manage` was one of 24 keys the owner column did not hold — and
-- answered in the general one.
--
-- ENFORCEMENT LIVES IN CODE, NOT HERE, exactly as migration 222 spelled out:
-- `AuthService` computes a user's permissions with `permissionsForRole()` from
-- `@mimi/shared`'s matrix (`packages/shared/src/rbac.ts`), where the owner
-- column is now `true` on all 150 rows. `permissions` / `role_permissions` in
-- this database are the pull-only offline-display cache (SYNC-PROTOCOL §3.2
-- class M, "a cache for offline display, not the enforcement path"). Granting
-- here alone would grant nothing at runtime; omitting it would leave an offline
-- device rendering an owner's menu as if they still held 126 of 150 keys.
--
-- WHAT IT COSTS. The 24 rows were the separation of duties — the account that
-- RAISES a document could not verify, post or pay it. An owner can now submit
-- a stock count and approve it, verify a payment they requested, calculate and
-- approve a payroll run, and post the journal for all of it, in one session.
-- The same trade migration 222 made for five `*.create` keys, now applied to
-- the whole column, at the owner's explicit instruction. `audit_log` and the
-- approval engine's `requested_by`/`approver` rows stay the record of who did
-- what; for this one role they are the only remaining control on those paths.
-- No other role's grants change, and no RLS policy is touched: owner is already
-- central in `app_is_central()` (009, extended by 222).
--
-- Derived from `permissions` with a CROSS JOIN rather than transcribed — the
-- same shape 222 used for superadmin, so this cannot drift from the real key
-- list the way a hand-written list would, and it stays correct for keys added
-- to `permissions` before this migration runs on a given environment.

BEGIN;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

COMMIT;
