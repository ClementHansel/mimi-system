-- Migration: 211_w1c_fix_sj_returning_rls_violation
-- Fix block: 2xx. Subtle bug reproduced in isolation by W3-07: `INSERT ...
--             RETURNING` on `surat_jalan` or `sj_drops` raised "new row
--             violates row-level security policy", even though every
--             predicate independently evaluated true for the row in
--             question.
--
-- ROOT CAUSE: for INSERT/UPDATE with a RETURNING clause, Postgres re-checks
-- the row against the table's SELECT-context USING policy (not just
-- WITH CHECK) to decide whether it may be returned — a failure there
-- raises the same RLS-violation error, it does not just omit the row.
-- `surat_jalan_scope` and `sj_drops_scope`'s USING clauses (201's
-- recursion fix) both resolve visibility ENTIRELY through
-- `app_sj_locations(id)`, a SECURITY DEFINER function that issues its own,
-- separate `SELECT ... FROM surat_jalan` / `SELECT ... FROM sj_drops`
-- query. For a row inserted earlier in the SAME command, that separate
-- query's snapshot does not yet see it — so `app_sj_locations()` comes
-- back without the very row being checked, the USING clause evaluates
-- false for a row that is in fact permitted, and RETURNING fails. This is
-- specific to each table checking ITSELF through the function; it never
-- affected `sj_temperature_logs`/`sj_seals`/`sj_lines` (their own policies,
-- defined in 037/207), because those three only ever query the *parent*
-- `surat_jalan`/`sj_drops` rows, which are always pre-existing, already-
-- committed rows by the time a temperature log or seal is recorded.
--
-- FIX CHOSEN (the coordinator's option 2, structurally): give each policy's
-- USING clause a first arm that resolves the row's OWN scope from its OWN
-- column directly — no function call, no subquery, nothing but a plain
-- correlated column reference, which is always visible during that row's
-- own INSERT because it isn't a separate query at all. `app_sj_locations()`
-- remains as a second arm, for the one case a direct column check cannot
-- cover: the *other* table's visibility into rows it doesn't own (a
-- warehouse actor seeing every drop of an SJ they dispatched; an outlet
-- actor seeing the SJ header of a drop addressed to them). That second arm
-- keeps working correctly even at INSERT time, because in every case where
-- the first arm cannot resolve the check, the *other* table's row it needs
-- to read is a pre-existing, already-committed row (you cannot insert a
-- drop before its parent SJ exists, and you cannot log a temperature
-- before a drop or its SJ exists) -- the blind spot only ever bit the
-- exact-same-row-in-the-exact-same-command case, which the new first arm
-- now resolves without going through the function at all.
--
-- This is not a security change: `app_has_location(origin_location_id)` /
-- `app_has_location(location_id)` were already implied by
-- `app_sj_locations()`'s result set (which unions in exactly those two
-- columns) -- the same rows become visible, reached by a path that doesn't
-- require the function to see a row still in flight within the current
-- command. `WITH CHECK` is unchanged (it already used the direct column
-- check, never the function -- that's why plain INSERT without RETURNING
-- never showed this bug, only RETURNING's extra SELECT-side re-check did).
-- Created at: 2026-08-17

BEGIN;

DROP POLICY IF EXISTS surat_jalan_scope ON surat_jalan;
CREATE POLICY surat_jalan_scope ON surat_jalan FOR ALL
  USING (
    app_has_location(origin_location_id)
    OR EXISTS (SELECT 1 FROM unnest(app_sj_locations(surat_jalan.id)) AS loc WHERE app_has_location(loc))
    OR (
      current_setting('app.role', true) = 'driver'
      AND EXISTS (
        SELECT 1 FROM drivers dr
        WHERE dr.id = surat_jalan.driver_id
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
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
          AND dr.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
      )
    )
  );

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
