-- Migration: 203_w1c_app_login_role
-- Fix block: 2xx. SECURITY-CRITICAL. W2-A found (and the coordinator
--             reproduced) that RLS was being bypassed entirely in the
--             running app: DATABASE_URL connects as 'mimi', which is a
--             superuser with BYPASSRLS, so FORCE ROW LEVEL SECURITY on every
--             policy does nothing — Postgres exempts superusers from RLS
--             unconditionally, FORCE or not. app_user and its policies were
--             correct all along; the gap is that app_user is NOLOGIN and
--             nothing ever switched to it, so every request just ran as the
--             superuser.
--
-- Fix: a dedicated LOGIN role for the runtime connection, distinct from the
-- migration/admin role ('mimi'). It is NOT a superuser, does NOT bypass RLS,
-- owns no tables, and holds NO direct table/schema grants of its own — it
-- exists solely to (a) authenticate the connection and (b) be a member of
-- app_user so the backend's `SET LOCAL ROLE app_user` (W1-D, request-guard
-- phase 0) succeeds. All table privileges continue to come from app_user —
-- this keeps exactly one place in the database where data access is
-- defined, per the coordinator's directive.
--
-- ROLE NAME: mimi_app
-- DEV-DEFAULT PASSWORD: 'mimi_app_secret' — set directly below, following
--   this repo's existing convention for every other dev-default secret
--   (docker-compose.yml's `${POSTGRES_PASSWORD:-mimi_secret}`,
--   `${REDIS_PASSWORD:-mimi_redis_secret}`, `${MINIO_ROOT_PASSWORD:-mimi_minio_secret}`).
--   Suggested env var for W1-A's compose/.env wiring: MIMI_APP_PASSWORD
--   (default mimi_app_secret), i.e. DATABASE_URL should become
--   `postgres://mimi_app:${MIMI_APP_PASSWORD:-mimi_app_secret}@postgres:5432/${POSTGRES_DB:-mimi}`.
--   Rotating this password in a real deployment is an `ALTER ROLE mimi_app
--   WITH PASSWORD '<new-secret>';` run directly against the database by
--   whoever owns that environment's secrets — the same way you would rotate
--   any other Postgres role's password, and NOT via a further migration
--   file (migrations are checked-in and should never carry a live secret
--   that gets rotated).
-- Created at: 2026-08-17

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'mimi_app') THEN
    CREATE ROLE mimi_app LOGIN PASSWORD 'mimi_app_secret';
  END IF;
END $$;

-- Belt-and-braces: whether the role above was just created or already
-- existed (e.g. a re-run), pin down every attribute that matters for RLS to
-- actually apply. This is the line that fixes the bug — without it, a role
-- created with an inherited superuser default, or hand-created differently
-- by someone else, would silently reopen the same hole.
ALTER ROLE mimi_app
  NOSUPERUSER
  NOCREATEDB
  NOCREATEROLE
  NOBYPASSRLS
  NOREPLICATION
  CONNECTION LIMIT -1;

-- Membership in app_user is what makes `SET LOCAL ROLE app_user` succeed;
-- NOINHERIT on the membership (the default) is deliberate — mimi_app must
-- NOT automatically inherit app_user's table privileges just by being a
-- member, it must explicitly SET ROLE first. This means a connection that
-- forgets phase 0 (SET LOCAL ROLE app_user) can authenticate but cannot
-- read or write a single application table: mimi_app itself is granted
-- nothing directly below, by design.
GRANT app_user TO mimi_app;

-- The only privilege mimi_app needs on its own: permission to open a
-- connection to this database. No SCHEMA USAGE, no table grants — those
-- live solely on app_user (GRANT USAGE ON SCHEMA public / GRANT SELECT,
-- INSERT, UPDATE, DELETE ON ALL TABLES ... in migration 009), which is
-- reached only via SET LOCAL ROLE, never by direct grant to mimi_app.
DO $$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO mimi_app', current_database());
END $$;

COMMIT;
