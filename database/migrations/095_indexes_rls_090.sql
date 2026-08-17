-- Migration: 095_indexes_rls_090
-- Block: 090-099 (accounting)
-- Description: indexes + RLS for block 090-099.
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_chart_of_accounts_parent ON chart_of_accounts(parent_id);
CREATE INDEX idx_chart_of_accounts_type ON chart_of_accounts(type);

CREATE INDEX idx_journal_entries_period ON journal_entries(fiscal_period_id);
CREATE INDEX idx_journal_entries_location ON journal_entries(location_id);
CREATE INDEX idx_journal_entries_event_type ON journal_entries(event_type);
CREATE INDEX idx_journal_entries_ref ON journal_entries(ref_type, ref_id);
CREATE INDEX idx_journal_entries_entry_date ON journal_entries(entry_date);

CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_id);
CREATE INDEX idx_journal_lines_location ON journal_lines(location_id);

CREATE INDEX idx_posting_rules_event_type ON posting_rules(event_type);

CREATE INDEX idx_payment_verifications_ref ON payment_verifications(ref_type, ref_id);
CREATE INDEX idx_payment_verifications_status ON payment_verifications(status);
CREATE INDEX idx_payment_verifications_location ON payment_verifications(location_id);
CREATE INDEX idx_payment_verifications_payee ON payment_verifications(payee_type, payee_id);

-- =============================================================================
-- RLS — chart_of_accounts / fiscal_periods / journal_entries / journal_lines /
-- posting_rules / payment_verifications: ROLE(owner,manager,finance)
-- =============================================================================

ALTER TABLE chart_of_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE chart_of_accounts FORCE ROW LEVEL SECURITY;
CREATE POLICY chart_of_accounts_role ON chart_of_accounts FOR ALL
  USING (current_setting('app.role', true) IN ('owner','manager','finance'))
  WITH CHECK (current_setting('app.role', true) IN ('owner','finance'));

ALTER TABLE fiscal_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE fiscal_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY fiscal_periods_role ON fiscal_periods FOR ALL
  USING (current_setting('app.role', true) IN ('owner','manager','finance'))
  WITH CHECK (current_setting('app.role', true) IN ('owner','finance'));

ALTER TABLE journal_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_entries_role ON journal_entries FOR ALL
  USING (current_setting('app.role', true) IN ('owner','manager','finance'))
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance'));

ALTER TABLE journal_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE journal_lines FORCE ROW LEVEL SECURITY;
CREATE POLICY journal_lines_role ON journal_lines FOR ALL
  USING (current_setting('app.role', true) IN ('owner','manager','finance'))
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance'));

ALTER TABLE posting_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE posting_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY posting_rules_role ON posting_rules FOR ALL
  USING (current_setting('app.role', true) IN ('owner','manager','finance'))
  WITH CHECK (current_setting('app.role', true) IN ('owner','finance'));

ALTER TABLE payment_verifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_verifications FORCE ROW LEVEL SECURITY;
CREATE POLICY payment_verifications_role ON payment_verifications FOR ALL
  USING (current_setting('app.role', true) IN ('owner','manager','finance'))
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager','finance'));

COMMIT;
