-- Migration: 007_settings_document_counters
-- Block: 001-009 (core)
-- Description: namespaced app settings (M20 reads/writes) + cloud-issued
--              document numbering counters (CONTRACTS.md §0).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE settings (                          -- namespaced keys, e.g. 'company.profile',
  key VARCHAR(100) PRIMARY KEY,                  -- 'approval.threshold.void', 'approval.threshold.po',
  value JSONB NOT NULL,                          -- 'hr.geofence_radius_m', 'hr.late_grace_minutes', 'hr.overtime_rate',
  description TEXT,                              -- 'coldchain.frozen.max_temp', 'leave.annual_quota_days'=12,
  updated_by UUID REFERENCES users(id),          -- 'leave.marriage_days'=3, 'sync.stale_thresholds', 'wa.enabled', …
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE document_counters (                 -- cloud-only numbering; offline docs use device-local numbers (§0)
  doc_type VARCHAR(30) NOT NULL,                 -- 'SJ','PO','PR','PC','OPN','RET','WST','JE','PRUN','PV','RR','GR'
  period VARCHAR(6) NOT NULL,                    -- 'YYYYMM'
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, period)
);

-- =============================================================================
-- SEED — settings defaults (CONTRACTS.md §4.20; contract for every module
-- that reads them). 'payroll.statutory' stays OFF (Amendment 1 default);
-- switching it on goes through the §4.15 wizard endpoints only, never a raw
-- settings PUT (ERR_USE_WIZARD, enforced at the API layer).
-- =============================================================================

INSERT INTO settings (key, value, description) VALUES
  ('company.profile', '{"name":"Mimi Chicken","address":"Jl. Jenderal Sudirman No. 1, Balikpapan","city":"Balikpapan","logoAttachmentId":null}', 'Company profile used by the print layer and payslips'),
  ('approval.threshold.void', '{"managerAboveIdr":"200000.00"}', 'Void/refund manager escalation threshold (§5.2)'),
  ('approval.threshold.po', '{"ownerAboveIdr":"10000000.00"}', 'Purchase order owner escalation threshold (§5.3)'),
  ('approval.threshold.payment', '{"ownerAboveIdr":"20000000.00"}', 'Payment verification owner escalation threshold (§5.8)'),
  ('approval.threshold.opname', '{"managerAboveIdr":"2000000.00"}', 'Stock opname manager escalation threshold (§5.4)'),
  ('hr.geofence_radius_m', '100', 'Default attendance geofence radius; overridable per location (FR-HR-01)'),
  ('hr.late_grace_minutes', '5', 'Grace minutes before attendance counts as late (POUT-07)'),
  ('hr.overtime', '{"ratePerHour":"15000.00","minMinutes":30}', 'Overtime rate + minimum minutes (PIN-02)'),
  ('hr.deduction_rates', '{"perAbsentDay":"daily_rate","perLateMinute":"500.00","sickPaid":true,"permissionPaid":false}', 'Attendance-driven deduction rates (POUT-01..03/07)'),
  ('leave.quotas', '{"annual":12,"marriage":3}', 'Annual leave day quotas (POUT-04)'),
  ('payroll.so_shortfall', '{"mode":"attributable_only","splitRule":"equal_among_on_shift"}', 'Stock opname shortfall attribution to payroll (POUT-05)'),
  ('payroll.statutory', '{"enabled":false,"enabledAt":null,"enabledBy":null}', 'Amendment 1 gate: PPh21 + BPJS statutory payroll — flipped only via the setup wizard'),
  ('pos.cash_variance_propose_above', '"0.00"', 'Amendment 2: shift-close shortfall threshold that auto-creates a pending cash-variance deduction proposal'),
  ('coldchain.frozen', '{"minC":"-25.0","maxC":"-15.0"}', 'Frozen cold-chain bounds, mirrors shipment_types (D-14)'),
  ('auth.offline_credential_ttl_h', '24', 'Offline approval credential TTL in hours (D-17)'),
  ('offline.selfie_required_above', '"200000.00"', 'Offline approval selfie requirement threshold (SYNC-PROTOCOL §7)'),
  ('offline.approval_volume_cap', '20', 'Max offline approvals per credential per TTL window (SYNC-PROTOCOL §7.4)'),
  ('sync.max_offline_window_h', '24', 'Maximum tolerated offline window before defensibility clamps (SYNC-PROTOCOL §6.4)'),
  ('sync.price_variance_tolerance', '{"pct":"1.0"}', 'Reconciliation price variance tolerance (SYNC-PROTOCOL R4)'),
  ('pos.qris', '{"mode":"static"}', 'QRIS integration mode (M13)'),
  ('wa.enabled', 'false', 'WhatsApp channel toggle; false = mock into notification_outbox (RISK-P4, D-03)')
ON CONFLICT (key) DO NOTHING;

COMMIT;
