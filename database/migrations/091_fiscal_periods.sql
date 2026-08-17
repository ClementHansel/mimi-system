-- Migration: 091_fiscal_periods
-- Block: 090-099 (accounting)
-- Description: fiscal periods. Posting into 'closed' => ERR_PERIOD_CLOSED;
--              'locked' additionally forbids reversal entries.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE fiscal_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code VARCHAR(7) UNIQUE NOT NULL,        -- '2026-08'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked')),
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
