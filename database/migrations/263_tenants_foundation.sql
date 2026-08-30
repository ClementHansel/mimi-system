-- Migration: 263_tenants_foundation
-- Block: 2xx (fixes / gaps)
-- Description: Step 1 of docs/MULTI-TENANCY.md — the tenant boundary itself.
--
--              Owner decision 2026-08-30: one shared instance serving many
--              client businesses. Until now this schema was single-tenant by
--              explicit design (migration 002: "THE scoping dimension (D-05).
--              No tenant_id"), so this migration introduces the dimension that
--              did not exist rather than adjusting one that did.
--
--              SCOPE IS DELIBERATELY NARROW. Only `locations` and `users` get
--              `tenant_id` here — the two roots every other table reaches
--              through. The remaining 73 unscoped tables, and the 23 unique
--              constraints that collide across tenants, are step 2. Shipping
--              the boundary and the plumbing first means the change can be
--              verified while the system still has exactly one tenant and
--              behaves identically to before.
--
--              WHAT THIS ALREADY CLOSES. Two policies were company-blind in a
--              way that is harmless with one tenant and a data leak with two:
--                * `locations_select USING (true)` — every authenticated user
--                  could see every location, i.e. every client's outlet list.
--                * `users_select` — owner/manager/hr_admin/finance could see
--                  every user row, i.e. every client's staff.
--
-- Created at: 2026-08-30

BEGIN;

-- ── The tenant ───────────────────────────────────────────────────────────────
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(30) NOT NULL UNIQUE,               -- 'mimi' — short, used in ops and logs
  name VARCHAR(120) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE tenants IS
  'One row per client business. The OUTERMOST scoping dimension: tenant first, '
  'then location (docs/MULTI-TENANCY.md §3). Never user-selectable — a request''s '
  'tenant is resolved from the authenticated user''s own row, never from input.';

-- The existing deployment is one tenant. Everything below backfills to it, so
-- this migration is behaviour-preserving: same data, same visibility, one
-- tenant. That is what makes step 1 verifiable before step 2 touches 73 tables.
INSERT INTO tenants (code, name) VALUES ('mimi', 'Mimi Chicken');

-- ── The column, on the two roots ─────────────────────────────────────────────
-- Nullable first, backfilled, then NOT NULL. A DEFAULT is deliberately NOT
-- left in place afterwards: with more than one tenant, "the default tenant" is
-- never a correct answer, and a forgotten insert must fail loudly rather than
-- silently land a row in the wrong company.
ALTER TABLE locations ADD COLUMN tenant_id UUID REFERENCES tenants(id);
ALTER TABLE users     ADD COLUMN tenant_id UUID REFERENCES tenants(id);

UPDATE locations SET tenant_id = (SELECT id FROM tenants WHERE code = 'mimi');
UPDATE users     SET tenant_id = (SELECT id FROM tenants WHERE code = 'mimi');

ALTER TABLE locations ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE users     ALTER COLUMN tenant_id SET NOT NULL;

-- Every tenant-scoped read filters on this column, so it is an index, not a
-- nicety. Composite with the existing natural key so the re-keyed uniqueness
-- in step 2 has an index to lean on too.
CREATE INDEX locations_tenant_idx ON locations (tenant_id);
CREATE INDEX users_tenant_idx     ON users (tenant_id);

-- ── Resolving the caller's tenant ────────────────────────────────────────────
-- SECURITY DEFINER, and this is the one place that is justified.
--
-- `RlsContextGuard` must read the caller's tenant BEFORE it can set
-- `app.tenant_id`, but the policies below need `app.tenant_id` to allow a read
-- of `users`. That is a genuine bootstrap cycle, and the same reason the chat
-- helpers (migration 0xx) are SECURITY DEFINER. Scope is one column of one row
-- addressed by primary key, so it cannot be turned into a general read.
--
-- `SET search_path = public` is not optional on a SECURITY DEFINER function and
-- every other one in this schema pins it: without it, a caller who can create
-- objects in a schema earlier on their own search_path can shadow `users` and
-- have this function — running as the owner — read their table instead.
CREATE OR REPLACE FUNCTION app_tenant_of_user(uid UUID) RETURNS UUID AS $$
  SELECT tenant_id FROM users WHERE id = uid;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;

COMMENT ON FUNCTION app_tenant_of_user(UUID) IS
  'Bootstrap ONLY: lets RlsContextGuard resolve app.tenant_id before the tenant '
  'policies it enables can be satisfied. Not for use inside policies.';

-- ── Background work, which has no user to derive a tenant from ───────────────
-- `withSystemContext` (common/database/system-context.ts) opens RLS sessions
-- for cron sweeps, sync ingest and event handlers. There is no acting user
-- there, so there is no tenant either — and a background job that silently
-- picks one tenant out of several is a data-corruption bug, not a scoping one.
--
-- This is the BRIDGE, and it is deliberately loud rather than convenient: it
-- returns the tenant while exactly one exists, and raises the moment a second
-- appears. Step 2 must make background work iterate tenants explicitly; until
-- it does, this fails the job instead of running it against an arbitrary
-- company. A silent `LIMIT 1` here would be the single easiest way to corrupt
-- one client's ledger with another's events.
CREATE OR REPLACE FUNCTION app_the_only_tenant() RETURNS UUID AS $$
DECLARE
  n INTEGER;
  t UUID;
BEGIN
  -- Two statements rather than `min(id)`: there is no `min(uuid)` aggregate in
  -- Postgres. The count is what decides; the fetch only runs meaningfully when
  -- that count is exactly 1.
  SELECT count(*) INTO n FROM tenants;
  SELECT id INTO t FROM tenants LIMIT 1;
  IF n <> 1 THEN
    RAISE EXCEPTION
      'app_the_only_tenant(): % tenants exist. Background work must choose a tenant explicitly (docs/MULTI-TENANCY.md step 2).', n;
  END IF;
  RETURN t;
END;
$$ LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public;

COMMENT ON FUNCTION app_the_only_tenant() IS
  'Transitional: the tenant for background work while exactly one tenant exists. '
  'Raises on 0 or 2+ so the ambiguity surfaces as a failed job rather than a '
  'cross-tenant write. Remove when background work becomes tenant-aware.';

-- ── The gate ─────────────────────────────────────────────────────────────────
-- PURE: reads a session variable and compares. No table access, so no RLS
-- recursion is possible and no SECURITY DEFINER is needed — the same property
-- that makes `app_has_location`/`app_is_central` safe to call from 70 policies.
-- An earlier draft of docs/MULTI-TENANCY.md proposed looking the tenant up
-- from `locations` inside `app_has_location`; that would have put a correlated
-- subquery on the hot path of every row check AND made a policy on `locations`
-- call a function that reads `locations`.
--
-- FAILS CLOSED. `current_setting(..., true)` yields NULL when the variable was
-- never set, and `row_tenant = NULL` is NULL, which is not TRUE — so a request
-- that never went through RlsContextGuard sees nothing at all. The COALESCE
-- makes that explicit rather than incidental. The inverse default would turn a
-- forgotten set_config into a silent cross-tenant read, which is precisely the
-- failure mode this whole migration exists to prevent.
CREATE OR REPLACE FUNCTION app_in_tenant(row_tenant UUID) RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    row_tenant IS NOT NULL
    AND row_tenant::text = NULLIF(current_setting('app.tenant_id', true), ''),
    false
  );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION app_in_tenant(UUID) IS
  'TRUE when the row belongs to the caller''s tenant. Fails closed on an unset '
  'app.tenant_id. Pure — never reads a table.';

-- ── Policies ─────────────────────────────────────────────────────────────────
-- `locations_select` was `USING (true)`: with one tenant that is correct (an
-- outlet list is not secret within a company, and the app relies on it for
-- pickers and labels). With two it hands every client the other's outlets.
DROP POLICY IF EXISTS locations_select ON locations;
CREATE POLICY locations_select ON locations FOR SELECT
  USING (app_in_tenant(tenant_id));

DROP POLICY IF EXISTS locations_update ON locations;
CREATE POLICY locations_update ON locations FOR UPDATE
  USING (
    app_in_tenant(tenant_id)
    AND current_setting('app.role', true) = ANY (ARRAY['owner', 'manager'])
  );

DROP POLICY IF EXISTS locations_delete ON locations;
CREATE POLICY locations_delete ON locations FOR DELETE
  USING (
    app_in_tenant(tenant_id)
    AND current_setting('app.role', true) = ANY (ARRAY['owner', 'manager'])
  );

-- `app_is_self(id)` stays OUTSIDE the tenant gate, on purpose and not by
-- oversight: a user is definitionally inside their own tenant, so the check is
-- redundant there — and keeping it outside is what lets `RlsContextGuard` read
-- its own row on the request that has not yet resolved `app.tenant_id`.
-- Every OTHER path through these policies is tenant-gated.
DROP POLICY IF EXISTS users_select ON users;
CREATE POLICY users_select ON users FOR SELECT
  USING (
    app_is_self(id)
    OR (
      app_in_tenant(tenant_id)
      AND current_setting('app.role', true)
            = ANY (ARRAY['owner', 'manager', 'hr_admin', 'finance'])
    )
  );

DROP POLICY IF EXISTS users_update ON users;
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    app_is_self(id)
    OR (
      app_in_tenant(tenant_id)
      AND current_setting('app.role', true) = ANY (ARRAY['owner', 'manager'])
    )
  );

DROP POLICY IF EXISTS users_delete ON users;
CREATE POLICY users_delete ON users FOR DELETE
  USING (
    app_in_tenant(tenant_id)
    AND current_setting('app.role', true) = ANY (ARRAY['owner', 'manager'])
  );

COMMIT;
