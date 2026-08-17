-- Migration: 202_w1c_approval_chain_steps_document_type_check
-- Fix block: 2xx. Architect amendment: approval_chain_steps.document_type
--             must CHECK against exactly the twelve ApprovalDocumentType
--             enum values (CONTRACTS.md §2.5), not an informally hand-copied
--             list — the exact drift that let 'waste' and
--             'cash_variance_proposal' go unconstrained. The seed rows this
--             agent already wrote in migration 069 use exactly these twelve
--             values, so this constraint applies cleanly with no data fix.
-- Created at: 2026-08-17

BEGIN;

ALTER TABLE approval_chain_steps
  ADD CONSTRAINT chk_approval_chain_steps_document_type CHECK (document_type IN (
    'replenishment_request', 'void_refund', 'purchase_request', 'purchase_order',
    'stock_opname', 'return', 'waste', 'payroll_run', 'payment_verification',
    'leave_request', 'employee_loan', 'cash_variance_proposal'
  ));

COMMIT;
