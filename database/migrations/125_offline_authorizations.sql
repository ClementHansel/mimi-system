-- Migration: 125_offline_authorizations
-- Block: 120-129 (sync & offline authorization, D-12, D-17)
-- Description: one row per offline authorization USE, with credential
--              binding + three-valued re-verification outcome.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE offline_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES offline_credentials(credential_id),
  approval_event_id UUID REFERENCES sync_events(event_id),   -- the *_offline decision event
  user_id UUID NOT NULL REFERENCES users(id),    -- the approver
  device_id UUID NOT NULL REFERENCES devices(id),
  location_id UUID REFERENCES locations(id),
  document_type VARCHAR(40) NOT NULL,            -- ApprovalDocumentType
  document_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,                   -- scope key exercised ('void_refund.approve', …)
  amount NUMERIC(18,2),                          -- for scope max_idr + selfie-threshold checks
  binding_hmac VARCHAR(64) NOT NULL,             -- §7.3: HMAC(k, event_id|entity|entity_id|op|amount|occurred_at)
  pin_attempts_before_success SMALLINT,          -- §7.4 check 7 telemetry
  selfie_attachment_id UUID REFERENCES attachments(id),      -- required iff amount >= threshold
  granted_at TIMESTAMPTZ NOT NULL,               -- client time (advisory)
  relay_received_at TIMESTAMPTZ,                 -- first server sighting -> expiry provability (§6.4)
  synced_at TIMESTAMPTZ,
  outcome VARCHAR(30) NOT NULL DEFAULT 'pending_verification' CHECK (outcome IN
    ('pending_verification','verified','failed','unprovable')),   -- three-valued + pending (§7.4)
  failure_reason TEXT,                           -- which §7.4 check failed / why unprovable
  verdict VARCHAR(10) CHECK (verdict IN ('upheld','rejected')),   -- finance decision on failed/unprovable (§7.5)
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- verdict='rejected' with physical effect => posting rule OFFLINE_AUTH_REJECTED (§6.3) books the loss
-- to Piutang Klaim Karyawan — the ledger is append-only, the unwind is a claim, never a deletion.

CREATE TRIGGER set_updated_at BEFORE UPDATE ON offline_authorizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
