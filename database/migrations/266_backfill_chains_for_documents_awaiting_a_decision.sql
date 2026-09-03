-- =============================================================================
-- 266: A DOCUMENT WAITING FOR A DECISION MUST HAVE A CHAIN TO RECORD IT.
--
-- Reported from production 2026-09-04 as "gagal approve cuti". Three sick-leave
-- requests sat at Menunggu, the screen offered Setujui and Tolak, and every
-- click failed. `GET /api/approvals/leave_request/<id>` answered
-- "No approval found" for all three: the rows had no `approvals` record at all,
-- so `ApprovalService.approve` had nothing to advance and returned 404 — which
-- the HR panel discarded in favour of "Terjadi kesalahan".
--
-- They came from `database/seed.ts`, which inserts a pending leave request
-- directly. `seed-gaps.ts` builds chains for seeded documents afterwards, but
-- production runs `pnpm migrate` on deploy and NOT `pnpm seed`, so rows created
-- by an earlier seed were never given one. Three of them, because the seed's
-- guard keys on (employee_id, start_date) and the date moves with the run day.
--
-- ## What this does
--
-- For every document that CONTRACTS.md §5 says can still be approved or
-- rejected, and that has no chain, it creates one PENDING approval with its
-- configured steps. Nothing else changes: the document keeps its status, its
-- requester and its dates.
--
-- ## What it deliberately does NOT do
--
-- It never touches a document that is already past a decision. `seed-gaps.ts`
-- fabricates decided chains with plausible actors and timestamps for demo data,
-- which is right for a demo and WRONG here: inventing "approved by X on date Y"
-- in a production audit trail would be worse than the missing row, because it
-- would look like evidence. An approved document with no chain stays as it is —
-- visibly missing its history rather than carrying a fictional one.
--
-- Idempotent, and safe to re-run: the NOT EXISTS guard means a second run finds
-- nothing to do. Each block computes its own amount because the chain's
-- thresholds route on it (§5.4 opname on variance VALUE, §5.2 void/refund on
-- the refunded amount), and a chain built with the wrong amount would put the
-- document in front of the wrong approver.
-- =============================================================================

-- One row per (table, document_type, decidable statuses, amount expression).
-- Written as a DO block rather than twelve near-identical statements so the
-- guard and the step-building logic exist once.
DO $$
DECLARE
  spec RECORD;
  doc RECORD;
  new_approval_id uuid;
  step_rows int := 0;
  steps_added int := 0;
  chains_added int := 0;
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      -- §5.10: a leave request waits on its supervisor.
      ('leave_requests',           'leave_request',           ARRAY['pending'],                                  'NULL::numeric'),
      -- §5.11: a kasbon waits on finance, then the manager above a threshold.
      ('employee_loans',           'employee_loan',           ARRAY['pending'],                                  'd.principal'),
      -- §5.4: routed on the VALUE of the variance, not the size of the count.
      ('stock_opname',             'stock_opname',            ARRAY['submitted'],                                '(SELECT COALESCE(SUM(ABS(l.diff_qty) * i.avg_cost), 0) FROM stock_opname_lines l JOIN items i ON i.id = l.item_id WHERE l.opname_id = d.id)'),
      ('purchase_requests',        'purchase_request',        ARRAY['submitted'],                                '(SELECT COALESCE(SUM(l.qty * l.est_price), 0) FROM purchase_request_lines l WHERE l.pr_id = d.id)'),
      ('purchase_orders',          'purchase_order',          ARRAY['submitted'],                                'd.total'),
      -- §5.1: an unconditional two-step chain, supervisor then warehouse.
      ('replenishment_requests',   'replenishment_request',   ARRAY['submitted','awaiting_approval'],            'NULL::numeric'),
      ('returns',                  'return',                  ARRAY['pending'],                                  '(SELECT COALESCE(SUM(l.qty * COALESCE(l.unit_cost, i.avg_cost)), 0) FROM return_lines l JOIN items i ON i.id = l.item_id WHERE l.return_id = d.id)'),
      ('waste_records',            'waste',                   ARRAY['pending'],                                  'd.qty * COALESCE(d.unit_cost, 0)'),
      ('void_refunds',             'void_refund',             ARRAY['pending'],                                  'd.amount'),
      ('cash_variance_proposals',  'cash_variance_proposal',  ARRAY['pending'],                                  'ABS(d.amount)')
    ) AS t(tbl, doc_type, statuses, amount_sql)
  LOOP
    FOR doc IN EXECUTE format(
      'SELECT d.id,
              %s AS amount,
              %s AS location_id,
              %s AS requested_by
         FROM %I d
        WHERE d.status::text = ANY($1)
          AND NOT EXISTS (
            SELECT 1 FROM approvals a
             WHERE a.document_type = $2 AND a.document_id = d.id
          )',
      spec.amount_sql,
      -- Not every document is located (a payroll run, a kasbon); the column
      -- decides, and `approvals.location_id` is nullable for exactly this.
      CASE WHEN EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = spec.tbl AND column_name = 'location_id'
      ) THEN 'd.location_id' ELSE 'NULL::uuid' END,
      -- The requester column is spelled differently per module.
      CASE
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = spec.tbl AND column_name = 'requested_by') THEN 'd.requested_by'
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = spec.tbl AND column_name = 'reported_by') THEN 'd.reported_by'
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = spec.tbl AND column_name = 'counted_by') THEN 'd.counted_by'
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = spec.tbl AND column_name = 'created_by') THEN 'd.created_by'
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = spec.tbl AND column_name = 'kasir_user_id') THEN 'd.kasir_user_id'
        WHEN EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = spec.tbl AND column_name = 'employee_id') THEN '(SELECT e.user_id FROM employees e WHERE e.id = d.employee_id)'
        ELSE 'NULL::uuid'
      END,
      spec.tbl
    ) USING spec.statuses, spec.doc_type
    LOOP
      -- `requested_by` is NOT NULL on `approvals`. A document whose requester
      -- cannot be resolved (an employee with no user account, say) is left
      -- alone rather than attributed to somebody arbitrary.
      CONTINUE WHEN doc.requested_by IS NULL;

      INSERT INTO approvals (document_type, document_id, state, current_step, amount, location_id, requested_by, requested_at)
      VALUES (spec.doc_type, doc.id, 'pending', 1, doc.amount, doc.location_id, doc.requested_by, NOW())
      RETURNING id INTO new_approval_id;
      chains_added := chains_added + 1;

      -- Only the steps this document's amount actually triggers: a Rp2 juta
      -- order must not acquire the owner step that begins at Rp10 juta.
      INSERT INTO approval_steps (approval_id, step_no, approver_role, state)
      SELECT new_approval_id, s.step_no, s.approver_role, 'pending'
        FROM approval_chain_steps s
       WHERE s.document_type = spec.doc_type
         AND (s.min_amount IS NULL OR (doc.amount IS NOT NULL AND doc.amount >= s.min_amount));
      GET DIAGNOSTICS step_rows = ROW_COUNT;
      steps_added := steps_added + step_rows;
    END LOOP;
  END LOOP;

  RAISE NOTICE 'backfilled % pending chains (% steps) for documents awaiting a decision', chains_added, steps_added;
END $$;
