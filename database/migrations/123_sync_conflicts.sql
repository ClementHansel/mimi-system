-- Migration: 123_sync_conflicts
-- Block: 120-129 (sync & offline authorization, D-12, D-17)
-- Description: conflict + exception queue rows (SYNC-PROTOCOL §5.2/§5.4;
--              F12 + F07 surfaces).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE sync_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(30) NOT NULL CHECK (kind IN (
    'double_count',              -- C1 opname line counted twice
    'duplicate_receipt',         -- C2 drop received twice
    'decision_race',             -- C3 offline vs online decision, divergent outcomes
    'attendance_overlap',        -- C4
    'negative_balance',          -- C5 (also mirrored in stock_reconciliations)
    'duplicate_inbound',         -- C6
    'offline_auth',              -- C7 failed/unprovable re-verification
    'duplicate_platform_order',  -- C8
    'poison')),                  -- C9 malformed / authority_violation / seq_conflict
  queue VARCHAR(10) NOT NULL CHECK (queue IN ('conflict','exception','finance','hr')),  -- §5.4 routing
  entity TEXT NOT NULL,
  entity_id UUID,
  location_id UUID REFERENCES locations(id),
  winner_event_id UUID REFERENCES sync_events(event_id),
  loser_event_id UUID REFERENCES sync_events(event_id),
  detail JSONB NOT NULL DEFAULT '{}',            -- both payloads + detection rule + suggested action
  physical_effect_suspected BOOLEAN NOT NULL DEFAULT false,  -- §7.5
  assignee_role VARCHAR(30),
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution_event_id UUID REFERENCES sync_events(event_id), -- resolutions are new events, never edits
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON sync_conflicts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
