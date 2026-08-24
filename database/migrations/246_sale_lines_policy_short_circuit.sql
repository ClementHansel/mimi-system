-- 246 — Let `sale_lines_parent` short-circuit for central roles.
--
-- ## The cost being removed
--
-- `sale_lines_parent` (migration 055) is a "parent group" policy: a sale line
-- is visible if its parent sale is.
--
--     EXISTS (SELECT 1 FROM sales s
--              WHERE s.id = sale_lines.sale_id
--                AND app_has_location(s.location_id))
--
-- Under FORCE ROW LEVEL SECURITY the planner cannot fold that into a semi-join
-- with the `sales` the query has ALREADY joined on the very same key, so it
-- runs as a correlated subplan — once per candidate row. On the dashboard's
-- COGS aggregate over a quarter of trading that is ~99,000 executions and
-- ~400,000 buffer touches, and after migration 245 removed the sequential scan
-- it became the single largest remaining cost in the query.
--
-- ## Why THIS change and not the obvious ones
--
-- Two cheaper hypotheses were tested on a full copy of production and both
-- failed, so they are recorded here to save the next person the experiment:
--
--   * Marking `app_has_location`/`app_is_central` LEAKPROOF: 1204ms -> ~1175ms.
--     No real effect. The barrier that blocks the pull-up is the nested RLS on
--     `sales`, not the leakproofness of the helper.
--   * Adding indexes: nothing to index. The subplan is already an index lookup;
--     the cost is executing it 99,000 times.
--
-- What DOES work is noticing that for a central role the subquery's answer is
-- a foregone conclusion. `app_has_location()` returns true unconditionally when
-- `app_is_central()` is true, so for owner/superadmin/manager/finance the whole
-- EXISTS can only ever be true. Hoisting that test out of the subquery lets the
-- planner discard the subplan entirely for those roles.
--
--     owner (central), COGS aggregate: ~1204ms -> ~897ms   (about 25% faster)
--
-- Branch roles are unaffected: they still evaluate the EXISTS exactly as before,
-- because `app_is_central()` is false for them and the OR falls through.
--
-- ## Why this is not a weakening
--
-- The two forms differ in exactly one case: a `sale_lines` row whose parent
-- `sales` row does not exist. The old form hides such a row from everyone; the
-- new one would show it to a central role.
--
-- That row cannot exist. `sale_lines.sale_id` is NOT NULL and carries a foreign
-- key to `sales(id)` ON DELETE CASCADE — verified against the live schema
-- before writing this, not assumed. There is no path that produces an orphan:
-- it cannot be inserted, and deleting the parent deletes the child.
--
-- If that FK is ever dropped or made deferrable, this policy must be revisited
-- FIRST. That is the whole of the argument this change rests on.
--
-- Not attempted here: denormalising `location_id` onto `sale_lines` so the
-- policy needs no subquery at all. That would remove the remaining cost for
-- branch roles too, but it puts a scope column on the hot sales write path and
-- needs a decision about who keeps it in step with the parent. The endpoint
-- already meets NFR-01 (about 0.6s against a 3s budget), so that trade is not
-- justified by the numbers today.
-- Created at: 2026-08-25

BEGIN;

ALTER POLICY sale_lines_parent ON sale_lines
  USING (
    app_is_central()
    OR EXISTS (
      SELECT 1 FROM sales s
       WHERE s.id = sale_lines.sale_id
         AND app_has_location(s.location_id)
    )
  )
  WITH CHECK (
    app_is_central()
    OR EXISTS (
      SELECT 1 FROM sales s
       WHERE s.id = sale_lines.sale_id
         AND app_has_location(s.location_id)
    )
  );

COMMIT;
