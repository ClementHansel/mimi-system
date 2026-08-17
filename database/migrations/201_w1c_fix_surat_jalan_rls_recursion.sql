-- Migration: 201_w1c_fix_surat_jalan_rls_recursion
-- Fix block: 2xx. Bug found during RLS verification testing (role-switched
--             queries, not just reading the policy text): surat_jalan's
--             policy checks "any drop LOC" via a subquery on sj_drops, and
--             sj_drops' policy checks "origin LOC" via a subquery back on
--             surat_jalan. Postgres detects this as infinite recursion the
--             moment either table is queried by a non-owner role:
--               ERROR: infinite recursion detected in policy for relation "surat_jalan"
--             Fix: a single SECURITY DEFINER helper resolves the full set of
--             locations relevant to an SJ (its origin + every drop's
--             destination) in one bypass-RLS read, and both policies call it
--             instead of querying each other's RLS-protected table directly.
--             This does not weaken either policy — it computes the exact
--             same predicate, just without walking back through the other
--             table's own row-security check.
-- Created at: 2026-08-17

BEGIN;

CREATE FUNCTION app_sj_locations(p_sj_id UUID)
RETURNS UUID[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT ARRAY(
    SELECT origin_location_id FROM surat_jalan WHERE id = p_sj_id
    UNION
    SELECT location_id FROM sj_drops WHERE sj_id = p_sj_id
  );
$$;

DROP POLICY IF EXISTS surat_jalan_scope ON surat_jalan;
CREATE POLICY surat_jalan_scope ON surat_jalan FOR ALL
  USING (
    EXISTS (SELECT 1 FROM unnest(app_sj_locations(surat_jalan.id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  )
  WITH CHECK (
    app_has_location(origin_location_id)
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  );

DROP POLICY IF EXISTS sj_drops_scope ON sj_drops;
CREATE POLICY sj_drops_scope ON sj_drops FOR ALL
  USING (
    EXISTS (SELECT 1 FROM unnest(app_sj_locations(sj_drops.sj_id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  )
  WITH CHECK (
    app_has_location(location_id)
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND current_setting('app.user_id', true) IS NOT NULL
          AND dr.user_id = current_setting('app.user_id', true)::uuid
      )
    )
  );

COMMIT;
