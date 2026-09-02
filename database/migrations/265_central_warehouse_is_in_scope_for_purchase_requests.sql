-- =============================================================================
-- 265: A PURCHASE REQUEST LIVES AT THE WAREHOUSE, SO SCOPED ROLES MUST SEE IT.
--
-- Reported from production 2026-09-02, as two separate complaints that turned
-- out to be one cause:
--
--   * A Supervisor Cabang could not turn an outlet request into a PR:
--     "Anda tidak punya akses untuk tindakan ini", on an account that holds
--     `purchasing.pr.create`.
--   * A Manager's "Permintaan Pembelian" tab said "Belum ada data" while a PR
--     sat at step 1 of its chain waiting for Manager approval.
--
-- A PR's `location_id` is the DESTINATION — the warehouse the goods will be
-- received into. There is exactly one warehouse (GDG, "Gudang Pusat
-- Balikpapan"); the other twenty locations are outlets. Migration 235 scoped a
-- manager to their assigned branches, and `simulate-org.ts` assigns the two
-- regional managers ten OUTLETS each. GDG is in neither list, so:
--
--   manager1 (BPP01-05, SMD01-05): 0 of 11 purchase requests visible.
--   manager_pusat (no branches):  all 11 visible.
--
-- Not "the new PR was missing" — a branch-scoped manager could see NO purchase
-- request at all, ever, and their approvals inbox carried no `purchase_request`
-- items among 67 pending ones. Every submitted PR would sit at step 1 forever
-- unless an unscoped manager happened to exist. Same cause on the write side:
-- a supervisor scoped to BPP01 fails `app_has_location(GDG)`, so the RLS
-- WITH CHECK refuses the insert even before the service's own scope test.
--
-- ## Why widening this is safe
--
-- 235 exists because `app_is_central()` returned true for `manager` and a
-- manager was reading another region's SALES — 50 rows of Balikpapan's takings
-- for a manager who runs Banjarmasin. That is a real boundary and this does not
-- touch it. A warehouse has no sales, no attendance and no till; hiding it from
-- a regional manager protected nothing and broke the purchasing chain.
--
-- Deliberately NARROW: only the purchase request and its lines. Warehouse
-- stock, deliveries and receipts stay scoped exactly as they are.
--
-- Both tables need it. 235 says the child policies "delegate to the parent
-- document, which IS scoped — so they inherit the restriction", and they do
-- inherit the restriction — but `purchase_request_lines_parent` re-tests
-- `app_has_location(r.location_id)` in its own EXISTS rather than deferring to
-- the parent's policy, so it does NOT inherit a relaxation. Fixing only the
-- parent left the header insertable and the lines refused: "new row violates
-- row-level security policy for table purchase_request_lines".
--
-- The same effect is already reachable by hand — tick GDG on a manager in
-- Administrasi — which is what makes this the right shape: it is the durable
-- version of a fix the UI already permits, so a manager added next month does
-- not silently arrive unable to approve a purchase.
-- =============================================================================

-- SECURITY DEFINER because `locations` is itself RLS-protected: read as the
-- caller, a supervisor asking "is this location a warehouse" could be answered
-- with silence for the very row in question. Mirrors the other `app_*` helpers
-- that have to see past a policy to answer a question about one.
CREATE OR REPLACE FUNCTION public.app_location_is_central(loc uuid)
  RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
AS $function$
  SELECT COALESCE(
    (SELECT l.type <> 'outlet' FROM locations l WHERE l.id = loc),
    false
  );
$function$;

COMMENT ON FUNCTION public.app_location_is_central(uuid) IS
  'True when the location is not an outlet (i.e. the central warehouse). Used by '
  'purchase_requests_loc_role so a branch-scoped manager or supervisor can still '
  'see and raise a purchase request destined for the warehouse (migration 265).';

-- `app_user` is the group the runtime identities belong to (`mimi` and
-- `mimi_app` are both members), and it is what the other SECURITY DEFINER
-- helper `app_user_display` grants to. Granting `mimi_app` instead left the
-- policy unable to call this at all: every purchase-request read came back
-- 42501 insufficient_privilege, surfacing as a bare 403.
REVOKE ALL ON FUNCTION public.app_location_is_central(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.app_location_is_central(uuid) TO app_user;

ALTER POLICY purchase_requests_loc_role ON purchase_requests
  USING (
    ((app_has_location(location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text]))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
    -- A purchase request is received at the warehouse, which belongs to no
    -- branch. Without this, scoping a manager to branches removes the entire
    -- purchasing queue they are the first approver of.
    OR (
      app_location_is_central(location_id)
      AND current_setting('app.role'::text, true) = ANY (ARRAY['manager'::text, 'supervisor'::text])
    )
  )
  WITH CHECK (
    ((app_has_location(location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text]))))
    OR (current_setting('app.role'::text, true) = 'manager'::text AND app_has_location(location_id))
    OR (
      app_location_is_central(location_id)
      AND current_setting('app.role'::text, true) = ANY (ARRAY['manager'::text, 'supervisor'::text])
    )
  );

-- The child re-tests the location itself (see the note above), so relaxing the
-- parent alone is not enough. Mirrored exactly: the existing clause is
-- untouched and a central destination is added for the same two roles.
ALTER POLICY purchase_request_lines_parent ON purchase_request_lines
  USING (
    EXISTS (
      SELECT 1 FROM purchase_requests r
       WHERE r.id = purchase_request_lines.pr_id
         AND (
           (app_has_location(r.location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'manager'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text])))
           OR (app_location_is_central(r.location_id) AND current_setting('app.role'::text, true) = ANY (ARRAY['manager'::text, 'supervisor'::text]))
         )
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM purchase_requests r
       WHERE r.id = purchase_request_lines.pr_id
         AND (
           (app_has_location(r.location_id) AND (current_setting('app.role'::text, true) = ANY (ARRAY['owner'::text, 'manager'::text, 'finance'::text, 'kepala_gudang'::text, 'supervisor'::text])))
           OR (app_location_is_central(r.location_id) AND current_setting('app.role'::text, true) = ANY (ARRAY['manager'::text, 'supervisor'::text]))
         )
    )
  );
