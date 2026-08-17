-- Migration: 214_w1c_fix_sj_drops_with_check_regression
-- Fix block: 2xx. Self-caught regression in 213, found while verifying it
--             live rather than trusting the diff: 213's rewrite of
--             `sj_drops_scope` restored a direct-column USING arm to fix
--             the INSERT...RETURNING snapshot bug, but in doing so it
--             dropped the "origin location" arm from WITH CHECK entirely —
--             the original (037) WITH CHECK was
--               app_has_location(location_id)
--               OR EXISTS (SELECT 1 FROM surat_jalan sj WHERE sj.id = sj_drops.sj_id
--                          AND app_has_location(sj.origin_location_id))
--               OR (driver clause)
--             and 213 shipped it as just
--               app_has_location(location_id) OR (driver clause)
--             which means a warehouse actor (kepala_gudang) populating
--             drops for OUTLET locations they have no direct
--             `user_locations` grant for — the entire point of a Kepala
--             Gudang building a multi-drop Surat Jalan — failed WITH CHECK
--             outright, with or without RETURNING. Caught by testing a
--             plain `INSERT` (no RETURNING) at an outlet location during
--             213's own verification: it failed too, proving the bug was
--             never about RETURNING for this table's WITH CHECK side.
--
-- Fix: restore the missing arm, via a DIRECT subquery into `surat_jalan`
-- (not through `app_sj_locations()`), exactly as originally written in 037.
-- This does not reopen the recursion 201 fixed: the cycle only existed
-- because BOTH tables queried each other directly under live RLS;
-- `surat_jalan_scope`'s USING clause now reaches into `sj_drops` solely
-- through the SECURITY DEFINER `app_sj_locations()` (213), which bypasses
-- `sj_drops`'s RLS entirely — so `surat_jalan_scope`'s own evaluation never
-- re-enters `sj_drops_scope`, and a direct subquery in the OTHER direction
-- (this fix) cannot loop back. One broken link is enough to prevent the
-- cycle regardless of which side still queries directly.
-- Created at: 2026-08-17

BEGIN;

DROP POLICY IF EXISTS sj_drops_scope ON sj_drops;
CREATE POLICY sj_drops_scope ON sj_drops FOR ALL
  USING (
    app_has_location(location_id)
    OR EXISTS (SELECT 1 FROM unnest(app_sj_locations(sj_drops.sj_id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  )
  WITH CHECK (
    app_has_location(location_id)
    OR EXISTS (SELECT 1 FROM surat_jalan sj WHERE sj.id = sj_drops.sj_id AND app_has_location(sj.origin_location_id))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM surat_jalan sj
        JOIN drivers dr ON dr.id = sj.driver_id
        WHERE sj.id = sj_drops.sj_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  );

COMMIT;
