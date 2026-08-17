-- Migration: 094_payment_verifications
-- Block: 090-099 (accounting)
-- Description: payment verification queue (PRD 8.9.1; FR-ACCT-01..04).
--              Resolves the payment_verification_id forward references left
--              dangling on purchase_orders, petty_cash, payroll_runs,
--              maintenance_jobs.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE payment_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pv_number VARCHAR(30) UNIQUE NOT NULL,
  ref_type VARCHAR(40) NOT NULL CHECK (ref_type IN
    ('purchase_order','payroll_run','petty_cash','maintenance_job','sale_payment','online_order','incentive','thr','other')),
  ref_id UUID,
  payee_type VARCHAR(20) NOT NULL CHECK (payee_type IN ('supplier','employee','platform','other')),
  payee_id UUID,                                 -- suppliers.id / employees.id
  amount NUMERIC(18,2) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','paid','rejected')),
  proof_attachment_id UUID REFERENCES attachments(id),  -- FR-ACCT-01 bukti pembayaran
  reference_number VARCHAR(100),                 -- FR-ACCT-01 nomor referensi
  submitted_by UUID NOT NULL REFERENCES users(id),
  verified_by UUID REFERENCES users(id),         -- FR-ACCT-02 siapa + kapan
  verified_at TIMESTAMPTZ,
  approval_id UUID REFERENCES approvals(id),     -- owner step above threshold (§5.8)
  paid_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  paid_via VARCHAR(20) CHECK (paid_via IN ('cash','bank_transfer','qris')),
  rejection_reason TEXT,
  location_id UUID REFERENCES locations(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON payment_verifications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE purchase_orders ADD CONSTRAINT fk_po_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);
ALTER TABLE petty_cash ADD CONSTRAINT fk_pc_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);
ALTER TABLE payroll_runs ADD CONSTRAINT fk_prun_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);
ALTER TABLE maintenance_jobs ADD CONSTRAINT fk_mj_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);

COMMIT;
