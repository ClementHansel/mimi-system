-- 241 — Skip a drop, and photograph a failed one.
--
-- Owner, 2026-08-24: the driver interface needs "finish delivery, skip
-- delivery, cancel delivery + reason + photo proofs". Finish and cancel exist
-- (`receive` and `fail`). The two gaps are the photo on a cancellation, and
-- skip, which has no equivalent at all.
--
-- ## Photo proof on failure
--
-- `receive` already demands a wajib-foto set and a signature. `fail` takes a
-- free-text reason and nothing else — so the ONE outcome where the goods come
-- back on the van, and where a driver has the clearest incentive to
-- misdescribe what happened, is the one outcome carrying no evidence. That is
-- backwards. `failure_attachment_id` closes it.
--
-- Nullable, deliberately. Making it NOT NULL would invalidate every drop
-- already failed under the old contract, and — worse — a driver at a shuttered
-- outlet with no signal must still be able to record the failure. The API
-- requires the photo where it can; the column permits the history that predates
-- it.
--
-- ## Skip is NOT a new terminal status
--
-- Deliberately no `'skipped'` value on `sj_drops_status_check`. A terminal
-- skip would duplicate `failed`, which already means "this drop is not
-- happening" — and `checkAndCompleteSuratJalan` REVERSES the dispatch
-- `transfer_out` for a failed drop, returning its stock to the warehouse. That
-- is right for a genuine failure and wrong for a skip: a driver bypassing a
-- busy outlet to come back in an hour still has the goods on the van. Making
-- skip terminal would silently return stock that never moved and hand the next
-- stock opname a discrepancy nobody could explain.
--
-- So a skip is a RE-ORDERING, not an outcome. The drop returns to `pending`,
-- moves to the end of the route, and stays deliverable today. What is recorded
-- is that it happened and why — which is the part with operational value: a
-- branch skipped three times a week is telling you something about that branch,
-- not about that driver.
--
-- `skip_count` rather than a boolean, because "skipped twice" is a different
-- fact from "skipped", and a boolean cannot recover the difference later.

ALTER TABLE sj_drops
  ADD COLUMN IF NOT EXISTS failure_attachment_id uuid REFERENCES attachments(id),
  ADD COLUMN IF NOT EXISTS skip_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_skip_reason text,
  ADD COLUMN IF NOT EXISTS last_skipped_at timestamptz;

ALTER TABLE sj_drops
  ADD CONSTRAINT sj_drops_skip_count_nonneg CHECK (skip_count >= 0);

COMMENT ON COLUMN sj_drops.failure_attachment_id IS
  'Wajib foto for a failed drop — the shuttered gate, the wrong address. Nullable: history predates it, and a failure must remain recordable with no signal.';
COMMENT ON COLUMN sj_drops.skip_count IS
  'How many times the driver deferred this drop within its run. A skip re-orders the route; it is not a terminal state and moves no stock.';
COMMENT ON COLUMN sj_drops.last_skip_reason IS
  'Why the most recent skip happened. Required by the API on every skip.';

-- Finding a route''s skipped drops is a per-SJ question asked while the route
-- is live, so the index is partial — the overwhelming majority of drops are
-- never skipped and do not belong in it.
CREATE INDEX IF NOT EXISTS idx_sj_drops_skipped
  ON sj_drops (sj_id, drop_seq)
  WHERE skip_count > 0;
