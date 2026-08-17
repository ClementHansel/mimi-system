-- Migration: 212_w1c_user_display_lookup
-- Fix block: 2xx. Confirmed live bug (found independently by two Wave 3
--             agents plus the coordinator): users_select (009) is
--               (current_setting('app.role') IN ('owner','manager',
--                'hr_admin','finance')) OR app_is_self(id)
--             'supervisor' and 'kepala_gudang' are NOT in that
--             central-role list. Any query anywhere in the codebase that
--             does `... JOIN users u ON u.id = <some_user_fk> ...` while
--             running as one of those two roles silently DROPS every row
--             whose referenced user isn't the caller themselves (INNER
--             JOIN, not a null row) -- users_select filters it out before
--             the join predicate is even evaluated. This already broke
--             kernel/approvals' "my pending approvals" inbox: every
--             scoped Supervisor/Kepala Gudang approver saw an EMPTY
--             inbox for approvals awaiting THEIR decision, because the
--             query joins users to resolve display info for the
--             requester/other approvers and the row vanished. That is
--             the entire fraud-control approval workflow (APR-01..08)
--             silently broken for exactly the two field-role approvers
--             the workflow depends on. At least one other Wave 3 module
--             hit the identical shape independently.
--
-- CHOICE MADE, AND WHY: a narrow, auditable SECURITY DEFINER lookup
-- function, NOT a widening of users_select itself -- following the exact
-- pattern already used twice in this codebase for this identical class of
-- problem (201_w1c_fix_surat_jalan_rls_recursion's app_sj_locations,
-- 206_w1c_offline_credential_verification_lookup's
-- app_offline_credential_for_verification). Reasoning:
--   - The base table's RLS is UNCHANGED: users_select still lists only
--     owner/manager/hr_admin/finance plus app_is_self(id) -- no
--     supervisor/kepala_gudang arm, no app_is_central() arm, byte-identical
--     to before this migration (verified live below).
--   - Widening users_select to add every non-central role that happens to
--     need a display-name join would turn a table holding email, phone,
--     password_hash, pin_hash, and last_login_at into one every runtime
--     role can read in full for every other user in the system -- a much
--     larger blast radius than what any consumer actually needs, which is
--     just "what is this user's display name and role".
--   - Instead, app_user_display(uuid[]) is SECURITY DEFINER (bypasses RLS
--     internally) and returns ONLY id, name, role_key for the requested
--     ids -- never email, phone, pin_hash, password_hash, or
--     last_login_at. It takes an array so the "my pending approvals" join
--     (and any other batch display-lookup) can resolve a whole result set
--     in one call instead of one function call per row.
--
-- WHAT IS READABLE BY WHOM AFTER THIS MIGRATION:
--   - The BASE TABLE's RLS is UNCHANGED: a supervisor/kepala_gudang
--     session querying `users` directly still sees only its own row (via
--     app_is_self) -- confirmed live below via pg_policy.
--   - The NEW function `app_user_display(uuid[])` bypasses RLS internally
--     and returns id/name/role_key for ANY requested user id, regardless
--     of the calling session's app.role or app.user_id. It is the display-
--     name equivalent of 206's narrowed cross-user lookup: enough to
--     render "who is this", nothing that touches credentials or contact
--     info.
--   - EXECUTE is granted only to app_user (the sole runtime role), same
--     boundary as 201 and 206. Consumer: kernel/approvals' "my pending
--     approvals" inbox query (the concrete break reported), and
--     potentially other Wave 3 modules that hit the identical
--     users_select gap when joining users from a non-central-role
--     session.
-- Created at: 2026-08-17

BEGIN;

CREATE FUNCTION app_user_display(p_user_ids UUID[])
RETURNS TABLE (id UUID, name VARCHAR(255), role_key VARCHAR(30))
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT u.id, u.name, r.key AS role_key
  FROM users u
  JOIN roles r ON r.id = u.role_id
  WHERE u.id = ANY(p_user_ids);
$$;

REVOKE ALL ON FUNCTION app_user_display(UUID[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_user_display(UUID[]) TO app_user;

COMMIT;
