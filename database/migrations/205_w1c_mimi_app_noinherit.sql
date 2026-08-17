-- Migration: 205_w1c_mimi_app_noinherit
-- Fix block: 2xx. Found by W1-A, confirmed by the coordinator: migration
--             203's header claimed the app_user membership was NOINHERIT
--             ("mimi_app must NOT automatically inherit app_user's table
--             privileges just by being a member... by design") but the
--             migration never actually set it. `GRANT app_user TO mimi_app;`
--             with no WITH INHERIT clause takes its default from mimi_app's
--             rolinherit attribute AT GRANT TIME — mimi_app was created via
--             plain `CREATE ROLE ... LOGIN PASSWORD ...`, which defaults to
--             INHERIT, so the membership silently came out inherit=true.
--
-- Consequence (not an active data leak — RLS + FORCE still applied, so a
-- bare mimi_app connection with no SET ROLE saw 0 rows, not real data; the
-- policies were doing their job). The actual problem is the FAILURE MODE:
-- with inherit=true, code that forgets `SET LOCAL ROLE app_user` silently
-- gets "0 rows", which reads as "no data" rather than "you are holding this
-- wrong". With inherit=false, the identical mistake becomes a hard
-- permission error at the first query — the same principle already applied
-- to the DATABASE_URL / DATABASE_MIGRATION_URL split (make the lazy failure
-- the loud one), now applied to the membership itself.
--
-- Two statements, deliberately both, because they fix two different things:
--   1. ALTER ROLE ... NOINHERIT changes mimi_app's rolinherit attribute, the
--      DEFAULT used for any *future* membership grants it receives. This is
--      what makes the role's own documented posture ("never inherits
--      anything automatically") actually true going forward.
--   2. On PG16, a role's rolinherit attribute is only the DEFAULT taken at
--      GRANT time — changing it does NOT retroactively touch memberships
--      already recorded in pg_auth_members. The existing app_user grant
--      (created in 203 before this fix) needs its own inherit_option
--      flipped directly, which is exactly what re-granting with an explicit
--      WITH INHERIT FALSE does; PG16 updates the existing membership row
--      in place rather than erroring or duplicating it.
-- Created at: 2026-08-18

BEGIN;

ALTER ROLE mimi_app NOINHERIT;

GRANT app_user TO mimi_app WITH INHERIT FALSE;

COMMIT;
