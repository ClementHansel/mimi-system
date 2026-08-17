-- Migration: 124_offline_credentials
-- Block: 120-129 (sync & offline authorization, D-12, D-17)
-- Description: offline credential registry (cloud mint record; the signed
--              token itself goes to the device over the authenticated login
--              API, NEVER through the event stream — SYNC-PROTOCOL §7.2).
--              Resolves the offline_credential_id forward reference on
--              approval_steps (block 008).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE offline_credentials (
  credential_id UUID PRIMARY KEY,                -- the id inside the signed token
  user_id UUID NOT NULL REFERENCES users(id),    -- approver (sub)
  device_id UUID REFERENCES devices(id),         -- NULL = minted for all devices of the location(s)
  role_key VARCHAR(30) NOT NULL,
  location_ids UUID[] NOT NULL,
  scopes JSONB NOT NULL,                         -- {"void_refund.approve":{"max_idr":"500000.00"}, …} (§7.2 shape)
  binding_secret_enc BYTEA NOT NULL,             -- per-issuance k, encrypted at rest; verifies §7.3 binding HMAC
  pin_verifier VARCHAR(255) NOT NULL,            -- argon2id of approver PIN (also shipped in token for local check)
  selfie_required_above NUMERIC(18,2) NOT NULL DEFAULT 200000.00,
  volume_cap INTEGER NOT NULL DEFAULT 20,        -- §7.4 check 8
  use_count INTEGER NOT NULL DEFAULT 0,
  minted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,               -- TTL: settings.auth.offline_credential_ttl_h (default 24 h)
  revoked_at TIMESTAMPTZ                         -- revocation rides the CRL pull
);

ALTER TABLE approval_steps ADD CONSTRAINT fk_as_offline_cred
  FOREIGN KEY (offline_credential_id) REFERENCES offline_credentials(credential_id);

COMMIT;
