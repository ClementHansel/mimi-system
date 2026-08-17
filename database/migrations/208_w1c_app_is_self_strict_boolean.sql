-- Migration: 208_w1c_app_is_self_strict_boolean
-- Fix block: 2xx. Self-caught refinement of 207, before reporting it as
--             done: 207's fix made `app_is_self()` stop throwing on an
--             empty-string `app.user_id`, but it left the function
--             returning SQL NULL in that case, not a strict boolean FALSE.
--
-- Why that matters even though NULL and FALSE behave identically inside an
-- RLS USING/WITH CHECK clause (both exclude the row): `app_is_self()` is a
-- named, reusable predicate, not only ever consumed as a bare RLS predicate.
-- SQL's three-valued logic means `NOT NULL` is NULL, not TRUE — so any
-- future caller that composes this function with negation (`WHERE NOT
-- app_is_self(x)`, or application code treating the result as a strict
-- true/false) would get a silently wrong answer precisely in the "GUC
-- absent" case this whole fix exists to make safe. The coordinator's ask
-- was "returns false rather than throwing" — literally, not just
-- practically-equivalent-in-a-WHERE-clause.
--
-- Fix: wrap the whole expression in COALESCE(..., false), guaranteeing a
-- real boolean result in every case. No other function needs this same
-- treatment: app_is_central() only ever does a string IN-comparison
-- (already strictly boolean, never NULL, since `'' IN (...)` is false, not
-- null), and app_has_location() short-circuits on `loc IS NOT NULL` first
-- (loc is always a real, non-null caller-supplied UUID in every call site
-- in this schema) before touching any GUC-derived value.
-- Created at: 2026-08-17

BEGIN;

CREATE OR REPLACE FUNCTION app_is_self(owner_user_id UUID)
RETURNS BOOLEAN AS $$
  SELECT COALESCE(
    owner_user_id IS NOT NULL
    AND owner_user_id = NULLIF(current_setting('app.user_id', true), '')::uuid,
    false
  );
$$ LANGUAGE sql STABLE;

COMMIT;
