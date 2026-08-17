-- Migration: 209_w1c_kepala_gudang_fulfilment_visibility
-- Fix block: 2xx. RLS gap found by W3-06: kepala_gudang (KGD) could not see
--             or act on any outlet-authored replenishment_requests row.
--             Migration 037 scopes those rows by the requesting outlet's
--             location_id, and app_is_central() does not include
--             kepala_gudang. But the warehouse approval step is the SECOND
--             step of the FR-LOG-10 chain — outlet requests, Supervisor
--             approves, Kepala Gudang approves and fulfils (CONTRACTS.md
--             §5.1) — so the chain was broken at step 2 for every request
--             in the system.
--
-- WHY A NEW HELPER, NOT JUST app_is_central(): kepala_gudang sits
-- deliberately between central and location-scoped. It is NOT central — it
-- must not read payroll, another city's sales, or anything outside its
-- logistics mandate — but it legitimately needs cross-outlet visibility of
-- whatever it fulfils or receives. Folding it into app_is_central() would
-- be simpler but wrong: it would hand KGD blanket access to every
-- location-scoped table that checks app_is_central(), including
-- payroll_periods/payroll_runs/payroll_lines and pos_shifts/sales at every
-- outlet, none of which KGD has any business reading. A dedicated
-- `app_is_fulfilment_role()` — used only on the specific tables where KGD's
-- cross-outlet mandate actually applies — keeps that boundary intact and
-- gives the next table that needs the same treatment one place to look,
-- exactly the reasoning that made app_has_location() worth having.
--
-- AUDIT OF THE OTHER CANDIDATES THE COORDINATOR NAMED, so this is recorded
-- rather than silently skipped:
--   - `returns` (outlet->gudang direction): CONFIRMED a second instance of
--     the same bug class, but NOT fixed with the role helper — its RLS
--     predicate only ever checked `from_location_id`, and for an
--     outlet_to_warehouse return, `from_location_id` is the OUTLET while
--     `to_location_id` is the WAREHOUSE (CONTRACTS.md §1.9's CHECK
--     constraint guarantees `to_location_id` is populated for exactly this
--     direction). KGD's own `user_locations` grant already covers the
--     warehouse — the predicate itself was just checking the wrong column
--     for the receiving side. Fixed generally (`app_has_location(from) OR
--     app_has_location(to)`), the same "either side of a transfer" shape
--     already used for `stock_movements.counterparty_location_id` and
--     `surat_jalan`'s origin-or-any-drop check — not a kepala_gudang
--     carve-out, because any role legitimately standing on the receiving
--     side of a transfer should see it, not specifically this one role.
--   - `goods_receipts`: NOT affected. This table is PRD 8.6.1 outlet-side
--     direct-from-supplier receiving, explicitly OUTSIDE the SJ/PO flows
--     (migration 036's header) — there is no KGD approval step over it (no
--     `approval_id`/`approved_by` column), so there is no cross-outlet
--     workflow need. Where the warehouse itself is the receiving location,
--     KGD's own `user_locations` grant already covers it.
--   - `waste_records` for warehouse approval: NOT affected. `waste_records`
--     has a single `location_id` — where that location is the warehouse,
--     KGD's own grant already covers it via the existing `app_has_location`
--     check, the same way `supervisor`'s own grant covers their own
--     outlet's waste. `waste.read` appearing in the RBAC matrix without a
--     location qualifier does not imply cross-location RLS visibility —
--     `supervisor` and `leader_outlet` hold the identical permission key
--     and are unambiguously meant to be single-location-scoped, so the
--     permission key alone cannot be read as "see every location's waste."
--   - `stock_opname` at warehouse locations: NOT affected, same reasoning
--     as waste_records — KGD's own location grant already covers
--     warehouse-located opnames; `opname.read` is not a cross-location
--     grant for `supervisor`/`leader_outlet` either.
--
-- BONUS (found while auditing every GUC-reading helper per the coordinator's
-- unrelated but concurrent request re: app_is_self): app_is_central() and
-- app_has_location() can return SQL NULL rather than a strict boolean on a
-- connection where app.role/app.location_ids have never once been set in
-- the session (NULL <> 'x' is NULL, not false; NULL = ANY(NULL[]) is NULL).
-- Harmless inside a USING/WITH CHECK clause (NULL excludes the row exactly
-- like false), but the same "should be strictly false" argument applies as
-- it did to app_is_self() (208) — hardened here for the same reason, while
-- this migration already touches this function family.
-- Created at: 2026-08-17

BEGIN;

CREATE OR REPLACE FUNCTION app_is_central()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(current_setting('app.role', true) IN ('owner', 'manager', 'finance', 'hr_admin'), false);
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION app_has_location(loc UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    loc IS NOT NULL
    AND (
      app_is_central()
      OR loc::text = ANY(
        string_to_array(NULLIF(current_setting('app.location_ids', true), ''), ',')
      )
    ),
    false
  );
$$ LANGUAGE sql STABLE;

-- True for roles that sit between central and location-scoped: no blanket
-- visibility, but a legitimate cross-location fulfilment/receiving mandate
-- on specific tables. Currently just kepala_gudang; extend this list, not
-- the tables, if another role needs the same treatment later.
CREATE OR REPLACE FUNCTION app_is_fulfilment_role()
RETURNS BOOLEAN AS $$
  SELECT COALESCE(current_setting('app.role', true) IN ('kepala_gudang'), false);
$$ LANGUAGE sql STABLE;

-- ---------------------------------------------------------------------------
-- replenishment_requests / replenishment_request_lines: add the fulfilment
-- carve-out. No second location column exists on this table to check
-- bidirectionally (there is exactly one warehouse in this system; the
-- fulfilling side is implicit, not an FK), which is exactly why this table
-- needs the role helper rather than the general fix applied to `returns`.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS replenishment_requests_loc ON replenishment_requests;
CREATE POLICY replenishment_requests_loc ON replenishment_requests FOR ALL
  USING (app_has_location(location_id) OR app_is_fulfilment_role())
  WITH CHECK (app_has_location(location_id) OR app_is_fulfilment_role());

DROP POLICY IF EXISTS replenishment_request_lines_parent ON replenishment_request_lines;
CREATE POLICY replenishment_request_lines_parent ON replenishment_request_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM replenishment_requests r
      WHERE r.id = replenishment_request_lines.request_id
        AND (app_has_location(r.location_id) OR app_is_fulfilment_role())
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM replenishment_requests r
      WHERE r.id = replenishment_request_lines.request_id
        AND (app_has_location(r.location_id) OR app_is_fulfilment_role())
    )
  );

-- ---------------------------------------------------------------------------
-- returns / return_lines: general bidirectional fix (both sides of the
-- transfer), not a role carve-out — see the audit note above.
-- ---------------------------------------------------------------------------

DROP POLICY IF EXISTS returns_loc ON returns;
CREATE POLICY returns_loc ON returns FOR ALL
  USING (app_has_location(from_location_id) OR app_has_location(to_location_id))
  WITH CHECK (app_has_location(from_location_id) OR app_has_location(to_location_id));

DROP POLICY IF EXISTS return_lines_parent ON return_lines;
CREATE POLICY return_lines_parent ON return_lines FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM returns r
      WHERE r.id = return_lines.return_id
        AND (app_has_location(r.from_location_id) OR app_has_location(r.to_location_id))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM returns r
      WHERE r.id = return_lines.return_id
        AND (app_has_location(r.from_location_id) OR app_has_location(r.to_location_id))
    )
  );

COMMIT;
