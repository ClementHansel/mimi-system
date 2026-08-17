-- Migration: 204_w1c_stock_movements_natural_key
-- Fix block: 2xx. Requested by W2-A (not urgent, addressed alongside the
--             security-critical role fix in 203).
--
-- The problem: stock_movements.sync_event_id is UNIQUE but single-column.
-- One synced fact routinely explodes into SEVERAL movement rows — one
-- sale's recipe ingredients (N items consumed from kitchen_line), one
-- receipt's several putaway lines (possibly across different storage
-- areas). A single-column UNIQUE on sync_event_id can protect at most ONE
-- of those rows per event; every row after the first sharing that event's
-- id would fail with a uniqueness violation. So sync_event_id alone was
-- never actually usable as the multi-row idempotency key it was
-- documented as, and W2-A correctly did not rely on it — instead dedup'ing
-- in application code on the natural key (ref_type, ref_id, item_id,
-- storage_area_id, movement_type), serialized by an advisory lock.
--
-- Is a DB-enforced composite UNIQUE on that same tuple sound, i.e. is there
-- a legitimate case where one ref_id needs two movement rows of the same
-- type for the same item in the same area? Considered and rejected:
--   - Two sale_lines in one sale using the same ingredient (e.g. two
--     different products both containing "Ayam Potong Utuh") must be
--     AGGREGATED into one usage_out movement per item during recipe
--     explosion, not posted as two rows — that is the correct ledger
--     pattern (one line per distinct item consumed per document), and
--     it is exactly what makes this tuple unique per ref in practice.
--   - Different movement_type values (e.g. a void's usage_out reversal
--     posts return_in, not a second usage_out) are naturally distinguished
--     by the tuple already.
--   - Different storage areas for the same item within one PO receipt or
--     goods receipt are naturally distinguished by storage_area_id.
--   - ref_id is nullable (e.g. this agent's own seed.ts uses
--     ref_type='seed' with ref_id left NULL for opening balances); Postgres
--     never treats two NULLs as equal for uniqueness purposes, so rows
--     with a NULL ref_id are correctly exempt from this guarantee — it only
--     bites where a real synced fact is behind the movement, which is
--     exactly the population that needs it.
-- No case survives where a legitimate duplicate is wanted. Adding the
-- index lets Postgres enforce, rather than the application's advisory
-- lock alone, the invariant W2-A already designed around.
-- Created at: 2026-08-17

BEGIN;

CREATE UNIQUE INDEX uq_stock_movements_natural_key
  ON stock_movements (ref_type, ref_id, item_id, storage_area_id, movement_type);

COMMIT;
