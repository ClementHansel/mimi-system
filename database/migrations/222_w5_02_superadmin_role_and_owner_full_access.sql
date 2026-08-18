-- Migration: 222_w5_02_superadmin_role_and_owner_full_access
-- Block: 001-009 lineage (identity/RBAC, migrations 003 + 009).
-- Description: adds the 10th role `superadmin`, makes it central for RLS, and
--              records owner's five new grants in the role_permissions cache.
-- Created at: 2026-08-18
--
-- WHY. Owner request (2026-08-18): "owner and superadmin accounts should see
-- every interface; every other account is redirected to its own interface."
-- Two gaps had to close for that to be true.
--
-- 1. THERE WAS NO SUPERADMIN. Nine roles existed and `owner` was the top of
--    them. This adds a tenth, deliberately distinct from `owner` so that "the
--    account that can see everything" and "the business owner's login" need
--    not be the same credential.
--
--    Enforcement lives in code, NOT here: `AuthService` computes a user's
--    permissions with `permissionsForRole()` from `@mimi/shared`'s matrix
--    (`rbac.ts`), where superadmin is `true` on all 138 rows. `permissions` /
--    `role_permissions` in this database are the pull-only offline-display
--    cache (SYNC-PROTOCOL §3.2 class M, "a cache for offline display, not the
--    enforcement path"), so the rows inserted below exist to keep that cache
--    honest — granting them here alone would grant nothing at runtime, and
--    omitting them would leave an offline device rendering a superadmin's menu
--    as if they held nothing.
--
-- 2. RLS WOULD HAVE MADE THE NEW ROLE BLIND. This is the part that is easy to
--    miss and impossible to notice from the API surface: `app_is_central()`
--    (009) hardcodes ('owner','manager','finance','hr_admin'), and
--    `app_has_location()` falls back to it for every location-scoped table. A
--    superadmin holding all 138 permissions would therefore have passed every
--    `@RequirePermission` check and still read almost NOTHING — each query
--    returning an empty set rather than an error, which reads as "the system
--    has no data" instead of "this role cannot see it". Adding the role to
--    `app_is_central()` is what makes the grants real.
--
--    `app_is_central()` is replaced with CREATE OR REPLACE rather than edited
--    in 009 (README: applied migrations are never edited). The body is
--    otherwise byte-identical to 009's — only the role list grows.
--
-- 3. OWNER'S FIVE NEW GRANTS. Owner previously held none of
--    replenishment.create / opname.create / waste.create / pettycash.create /
--    delivery.drop.execute, which is precisely why `/outlet` and `/driver`
--    were absent from the owner's menu. The owner accepted the trade-off when
--    it was put to them: these are CREATE rights, so an owner can now raise a
--    document and approve it in the same session, which the approval chains
--    were written assuming could not happen. That is a deliberate policy
--    choice, recorded here so it is not later mistaken for an oversight.
--
-- NOT DONE HERE: no superadmin USER is created by this migration. Accounts are
-- seeded (`database/seed.ts`) or created through the admin UI — minting a
-- privileged login from a migration would put a credential in version control
-- and create it silently on every environment this runs against.

BEGIN;

-- ── 1. The role itself ─────────────────────────────────────────────────────
INSERT INTO roles (key, name, is_system) VALUES
  ('superadmin', 'Super Admin', true)
ON CONFLICT (key) DO NOTHING;

-- ── 2. RLS: treat superadmin as central, exactly like owner ────────────────
CREATE OR REPLACE FUNCTION app_is_central()
RETURNS BOOLEAN AS $$
  SELECT current_setting('app.role', true) IN ('owner', 'manager', 'finance', 'hr_admin', 'superadmin');
$$ LANGUAGE sql STABLE;

-- ── 3. Offline-display cache: superadmin holds every permission ────────────
-- Derived from `permissions` rather than transcribed, so this cannot drift
-- from the real key list the way a hand-written matrix would.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.key = 'superadmin'
ON CONFLICT DO NOTHING;

-- ── 4. Offline-display cache: owner's five new grants ──────────────────────
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.key = 'owner'
   AND p.key IN (
     'replenishment.create',
     'opname.create',
     'waste.create',
     'pettycash.create',
     'delivery.drop.execute'
   )
ON CONFLICT DO NOTHING;

COMMIT;
