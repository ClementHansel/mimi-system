-- Migration: 092_journal
-- Block: 090-099 (accounting)
-- Description: journal (double-entry; always balanced — property-tested by
--              M17/W4-03).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number VARCHAR(30) UNIQUE NOT NULL,      -- 'JE/YYYYMM/nnnnn'
  entry_date DATE NOT NULL,
  fiscal_period_id UUID NOT NULL REFERENCES fiscal_periods(id),
  event_type VARCHAR(50),                        -- JournalEventType (§2); NULL for manual entries
  source VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (source IN ('system','manual')),
  ref_type VARCHAR(40),                          -- 'po_receipt','surat_jalan','sj_drop','sale_day','waste_batch',
                                                  -- 'stock_adjustment','return','petty_cash','payroll_run','payment_verification'
  ref_id UUID,
  location_id UUID REFERENCES locations(id),     -- reporting dimension (jurnal gudang vs outlet)
  description TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversed_by_entry_id UUID REFERENCES journal_entries(id),
  posted_by UUID REFERENCES users(id),           -- NULL for engine postings
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Idempotency: UNIQUE (event_type, ref_type, ref_id) WHERE source='system' — the engine can replay events safely.
CREATE UNIQUE INDEX uq_journal_entries_system_event
  ON journal_entries(event_type, ref_type, ref_id) WHERE source = 'system';

CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  debit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  location_id UUID REFERENCES locations(id),
  memo TEXT,
  CHECK ((debit = 0) <> (credit = 0)),           -- exactly one side per line
  UNIQUE (entry_id, line_no)
);

COMMIT;
