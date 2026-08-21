-- =============================================================================
-- W7 — purchase requests become EDITABLE, and say who touched them.
--
-- Owner's ruling (2026-08-21): "PR should be editable but shown who make it and
-- who made the changes, who approved it etc with time stamps."
--
-- Three of those four facts already existed: `requested_by` + `created_at` say
-- who raised it and when, and the approval chain (`approvals`/`approval_steps`
-- via `approval_id`) already records every approver with `acted_at`. The one
-- missing fact is the EDIT: there was no PATCH endpoint at all, so nothing ever
-- needed to record an editor. `updated_by` closes that, alongside the
-- `updated_at` the table's trigger already maintains.
--
-- The narrative of WHAT changed is not duplicated into a new revisions table:
-- `audit_log` already stores before/after JSONB per action, written by the
-- `@Audited()` interceptor, and `replenishment` already exposes exactly this as
-- `GET :id/history`. The PR history endpoint reads the same source, so there is
-- one audit trail in this system, not two that can disagree.
--
-- `source_replenishment_id` is the other half of the same ruling — "need to have
-- a place to see requests from stores properly and able to convert that to PR".
-- A PR born from an outlet's replenishment request keeps the pointer, so the
-- office can answer "which store asked for this?" from the document itself
-- rather than from a note someone typed.
--
-- Both columns are NULLABLE with no default: every existing row predates them
-- and inventing a value would be a claim about history we cannot make.
-- =============================================================================

BEGIN;

ALTER TABLE purchase_requests
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS source_replenishment_id UUID REFERENCES replenishment_requests(id);

COMMENT ON COLUMN purchase_requests.updated_by IS
  'Last user to edit the PR via PATCH. NULL = never edited since creation (or edited before migration 227).';
COMMENT ON COLUMN purchase_requests.source_replenishment_id IS
  'The outlet replenishment request this PR was converted from, when it was. NULL = raised directly by the office.';

-- Purchase orders are editable already (`PATCH /purchasing/orders/:id`) but were
-- equally silent about who edited them — same fix, same reason.
ALTER TABLE purchase_orders
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES users(id);

COMMENT ON COLUMN purchase_orders.updated_by IS
  'Last user to edit the PO via PATCH. NULL = never edited since creation.';

-- "Has this outlet request already become a PR?" is asked once per row when the
-- conversion inbox renders, so it gets an index; partial, because the vast
-- majority of PRs are raised directly and NULLs are not worth indexing.
CREATE INDEX IF NOT EXISTS idx_pr_source_replenishment
  ON purchase_requests (source_replenishment_id)
  WHERE source_replenishment_id IS NOT NULL;

COMMIT;
