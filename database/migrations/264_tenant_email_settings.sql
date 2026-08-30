-- Migration: 264_tenant_email_settings
-- Block: 2xx (fixes / gaps)
-- Description: Per-tenant outbound email, configured by the tenant themselves.
--
--              Owner decision 2026-08-30: each client connects THEIR OWN Gmail
--              (they set up their own 2FA and App Password) and the system
--              sends as them. Until now SMTP came from process-wide `SMTP_*`
--              environment variables — one mailbox for the entire deployment,
--              which cannot work once one instance serves several businesses.
--
--              WHY A DEDICATED TABLE RATHER THAN `settings`.
--              `settings` is a global key/value store with `key` as its
--              PRIMARY KEY, no `tenant_id`, and NO RLS at all (migration 009's
--              "NONE" group). Making it tenant-aware means re-keying it and
--              enabling RLS underneath ~10 existing readers spread across
--              approvals, payroll, HR, sync and auth — a wide blast radius for
--              a feature that needs one row per tenant. This table is scoped
--              from the first line instead, and touches nothing that already
--              works.
--
--              THE PASSWORD IS ENCRYPTED, NOT HASHED. It has to be replayed to
--              Gmail on every send, so it cannot be a one-way hash. It is
--              AES-256-GCM sealed with `SETTINGS_ENCRYPTION_KEY` and stored
--              here as ciphertext; the key lives in the environment, never in
--              this table. That is a real limitation and worth stating plainly:
--              anyone holding BOTH the database and the environment can read
--              these passwords. A Gmail App Password grants full send rights on
--              that mailbox, so this table is a credential store and should be
--              treated as one. OAuth2 refresh tokens would be revocable and
--              send-scoped; that was offered and App Passwords were chosen
--              (docs/MULTI-TENANCY.md §5).
--
-- Created at: 2026-08-30

BEGIN;

CREATE TABLE tenant_email_settings (
  -- One row per tenant, so `tenant_id` IS the primary key. No surrogate id:
  -- a second SMTP config for the same tenant is not a thing that can be
  -- meaningful, and the PK is what enforces that rather than a UNIQUE bolted
  -- on afterwards.
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,

  host VARCHAR(255) NOT NULL,
  port INTEGER NOT NULL DEFAULT 587,
  -- Gmail on 587 uses STARTTLS, which nodemailer expects as `secure: false`.
  -- `secure: true` means implicit TLS on 465. Getting this backwards produces
  -- a connection that hangs rather than an error, so it is a stored choice
  -- rather than something inferred from the port.
  secure BOOLEAN NOT NULL DEFAULT FALSE,
  username VARCHAR(255),

  -- AES-256-GCM ciphertext, base64, of the App Password. NULL means "no
  -- authentication", which is legitimate for an internal relay.
  password_encrypted TEXT,

  from_email VARCHAR(255) NOT NULL,
  from_name VARCHAR(120),

  -- Lets a tenant turn sending off without destroying their credentials, and
  -- gives the channel a single flag to check.
  is_enabled BOOLEAN NOT NULL DEFAULT TRUE,

  -- The result of the LAST test-connection attempt. Stored rather than merely
  -- returned, because the failure that matters is the one nobody was watching:
  -- credentials that silently stopped working weeks after they were entered.
  last_tested_at TIMESTAMPTZ,
  last_test_ok BOOLEAN,
  last_test_error TEXT,

  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT tenant_email_settings_port_range CHECK (port BETWEEN 1 AND 65535)
);

COMMENT ON TABLE tenant_email_settings IS
  'Per-tenant outbound SMTP. One row per tenant. `password_encrypted` is '
  'AES-256-GCM ciphertext under SETTINGS_ENCRYPTION_KEY, never a hash — the '
  'password must be replayed to the provider on every send.';

-- RLS from the start, unlike `settings`, which has none.
ALTER TABLE tenant_email_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_email_settings FORCE ROW LEVEL SECURITY;

-- Read: anyone in the tenant whose role can see settings at all. The
-- controller adds the permission check; this is the tenant boundary, and it
-- fails closed on an unset `app.tenant_id` exactly like every other
-- `app_in_tenant` policy.
CREATE POLICY tenant_email_settings_select ON tenant_email_settings FOR SELECT
  USING (app_in_tenant(tenant_id));

-- Write: owner/manager only, and still only inside their own tenant. Both
-- halves matter — the role check alone would let an owner of one company
-- rewrite another's mail credentials.
CREATE POLICY tenant_email_settings_insert ON tenant_email_settings FOR INSERT
  WITH CHECK (
    app_in_tenant(tenant_id)
    AND current_setting('app.role', true) = ANY (ARRAY['owner', 'manager', 'superadmin'])
  );

CREATE POLICY tenant_email_settings_update ON tenant_email_settings FOR UPDATE
  USING (
    app_in_tenant(tenant_id)
    AND current_setting('app.role', true) = ANY (ARRAY['owner', 'manager', 'superadmin'])
  );

CREATE POLICY tenant_email_settings_delete ON tenant_email_settings FOR DELETE
  USING (
    app_in_tenant(tenant_id)
    AND current_setting('app.role', true) = ANY (ARRAY['owner', 'manager', 'superadmin'])
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON tenant_email_settings TO app_user;

COMMIT;
