-- =============================================================================
-- The reporting rollups have never refreshed. The mechanism to refresh them has
-- existed since migration 219 — nothing ever called it.
--
-- `MatviewRefreshService` issues `REFRESH MATERIALIZED VIEW CONCURRENTLY`
-- directly, as `app_user`, every five minutes. Every single tick has failed with
--
--     must be owner of materialized view mv_sales_daily
--
-- caught by a per-view try/catch and logged. So the only symptom was one line in
-- a container log while the revenue, top-products, staff-KPI and delivery-recap
-- dashboards quietly froze at whatever the last migration happened to build.
-- Migration 219 diagnosed exactly this, wrote `refresh_dashboard_matview()` — a
-- SECURITY DEFINER function owned by `mimi`, allow-listed to the four views,
-- with EXECUTE granted to `app_user` — and the service was never pointed at it.
-- The fix is a one-line change in the service (this migration's companion), and
-- this file exists to make the database side provably correct and to record what
-- was learned the hard way.
--
-- ## The wrong turn, written down because it is genuinely counter-intuitive
--
-- The obvious fix is `ALTER MATERIALIZED VIEW ... OWNER TO app_user`, and it
-- makes things WORSE in a way that looks like success. A refresh re-runs the
-- view's defining query under the RLS of the view's OWNER — not of the role
-- executing the refresh. Hand the views to `app_user` and:
--
--   * `app_user` may now refresh them, so the errors stop;
--   * but the refresh runs with `app_user`'s RLS and no `app.*` session context,
--     which satisfies no policy, so it writes an EMPTY rollup;
--   * and every dashboard then reports a confident, precise ZERO.
--
-- Worse still, it breaks refreshes from OTHER paths. `mimi` is a superuser and
-- bypasses RLS for its own queries, but a refresh is checked against the OWNER,
-- so `mimi` refreshing an `app_user`-owned view ALSO produces an empty result.
-- That is how `dashboard-rbac.integration.spec.ts` caught it: expected
-- 54901167.00, got 0, from a helper that refreshes as the superuser.
--
-- The SECURITY DEFINER function avoids all of it: the views stay owned by
-- `mimi`, so the refresh runs with the DDL role's visibility and needs no
-- session context, and the runtime role gains exactly one capability — refresh
-- these four views — instead of ownership, which also carries DROP and ALTER.
-- =============================================================================

BEGIN;

-- Ownership belongs with the DDL role. Asserted rather than assumed, so a
-- database where someone already "fixed" this by transferring ownership is
-- brought back in line instead of silently keeping an empty-rollup refresh.
DO $$
DECLARE
  mv record;
BEGIN
  FOR mv IN
    SELECT c.oid::regclass AS name, pg_get_userbyid(c.relowner) AS owner
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'm' AND n.nspname = 'public'
  LOOP
    IF mv.owner <> 'mimi' THEN
      EXECUTE format('ALTER MATERIALIZED VIEW %s OWNER TO mimi', mv.name);
      RAISE NOTICE 'returned ownership of % to mimi (was %)', mv.name, mv.owner;
    END IF;
  END LOOP;
END $$;

-- Re-stated because ownership changes rewrite the ACL: the app reads these
-- through `app_user`, and 219's EXECUTE grant is what lets it refresh them.
DO $$
DECLARE
  mv record;
BEGIN
  FOR mv IN
    SELECT c.oid::regclass AS name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'm' AND n.nspname = 'public'
  LOOP
    EXECUTE format('GRANT SELECT ON %s TO app_user', mv.name);
  END LOOP;
END $$;

GRANT EXECUTE ON FUNCTION refresh_dashboard_matview(TEXT) TO app_user;

-- Prove the whole path, as the runtime role, and prove it produces ROWS.
--
-- "It did not raise" is not the assertion that matters here — the failure this
-- migration exists to prevent is a refresh that succeeds and writes nothing. So
-- the check runs as `app_user`, through the function the service now calls, and
-- fails the migration if the rollup comes back empty while the source table has
-- data.
DO $$
DECLARE
  before_n bigint;
  after_n bigint;
  source_n bigint;
BEGIN
  SELECT count(*) INTO source_n FROM sales;
  SELECT count(*) INTO before_n FROM mv_sales_daily;

  SET LOCAL ROLE app_user;
  PERFORM refresh_dashboard_matview('mv_sales_daily');
  RESET ROLE;

  SELECT count(*) INTO after_n FROM mv_sales_daily;

  IF source_n > 0 AND after_n = 0 THEN
    RAISE EXCEPTION
      'refresh_dashboard_matview() ran as app_user but left mv_sales_daily empty (source has % rows, rollup had % before) — the refresh is running under the wrong visibility',
      source_n, before_n;
  END IF;
END $$;

COMMIT;
