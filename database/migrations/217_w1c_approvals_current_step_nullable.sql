-- Migration: 217_w1c_approvals_current_step_nullable
-- Renumbered from 216 on 2026-08-17: two agents' migrations independently
-- landed on 216 in the same session (this one and
-- 216_w1c_fix_surat_jalan_with_check_asymmetry, a production-blocking RLS
-- fix other agents already reference by number) — moved this one per the
-- coordinator's call, not the SJ fix.
-- Fix block: 2xx. approvals.current_step (008) is INTEGER NOT NULL DEFAULT 1.
--             kernel/approvals' contract documents current_step IS NULL as
--             the "chain is finalized" signal (approved/rejected/cancelled)
--             -- ApprovalService/ApprovalsRepository.finalizeApproval needs
--             to null it out on finalization, but the NOT NULL constraint
--             makes that impossible. Leaving current_step at whatever step
--             number last acted after finalization is misleading for any
--             reporting query or future reader that reads the column
--             directly instead of going through the service -- it reads as
--             "still awaiting action at step N" when the chain is actually
--             done.
--
-- CHANGE: drop NOT NULL on approvals.current_step. This is the entire
-- schema change -- no other columns, no default change, no CHECK
-- constraint added. Existing rows are untouched (DROP NOT NULL is a
-- metadata-only change, no table rewrite, no lock beyond a brief
-- ACCESS EXCLUSIVE on the catalog update). Application-level nulling of
-- current_step on finalize is kernel/approvals' responsibility, not this
-- migration's.
-- Created at: 2026-08-17

BEGIN;

ALTER TABLE approvals ALTER COLUMN current_step DROP NOT NULL;

COMMIT;
