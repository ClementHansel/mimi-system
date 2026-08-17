-- Migration: 001_extensions_and_functions
-- Block: 001-009 (core: identity, RBAC, audit, kernel)
-- Description: Extensions + the shared trigger function used by every table
--              with an updated_at column (D-10). Also the RLS helper
--              functions referenced by every block's policies (D-06); they
--              are defined here, ahead of any table, so later blocks can
--              reference them freely.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- EXTENSIONS
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";   -- gen_random_uuid(), digest() for sha256 checks

-- =============================================================================
-- updated_at TRIGGER FUNCTION (D-10: every table with updated_at gets this)
-- =============================================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- RLS SESSION-VARIABLE HELPERS (D-06)
-- Session vars are set per-request by RlsContextGuard (backend, apps/backend):
--   app.user_id       - current user's UUID (text)
--   app.role          - current user's role key (text)
--   app.location_ids  - CSV of UUIDs the user is granted (from user_locations)
-- All three use current_setting(name, true) so they are NULL (not an error)
-- when unset (e.g. migration/superuser sessions, which bypass RLS anyway as
-- table owner).
-- =============================================================================

-- Central roles see every location without an explicit user_locations grant.
CREATE OR REPLACE FUNCTION app_is_central()
RETURNS BOOLEAN AS $$
  SELECT current_setting('app.role', true) IN ('owner', 'manager', 'finance', 'hr_admin');
$$ LANGUAGE sql STABLE;

-- True when the caller is central, OR the given location is in their granted set.
CREATE OR REPLACE FUNCTION app_has_location(loc UUID)
RETURNS BOOLEAN AS $$
  SELECT
    loc IS NOT NULL
    AND (
      app_is_central()
      OR loc::text = ANY(
        string_to_array(NULLIF(current_setting('app.location_ids', true), ''), ',')
      )
    );
$$ LANGUAGE sql STABLE;

-- True when the row belongs to the calling user (app.user_id).
CREATE OR REPLACE FUNCTION app_is_self(owner_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT
    owner_user_id IS NOT NULL
    AND current_setting('app.user_id', true) IS NOT NULL
    AND owner_user_id = current_setting('app.user_id', true)::uuid;
$$ LANGUAGE sql STABLE;

COMMIT;
