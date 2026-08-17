-- Migration: 006_notifications
-- Block: 001-009 (core)
-- Description: in-app notifications + outbound email/WhatsApp queue (D-03).
--              notification_outbox is the RISK-P4 mock target while WA
--              gateway credentials are pending.
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,                     -- 'low_stock','approval_pending','approval_decided','cold_chain_breach',
                                                  -- 'outlet_offline','maintenance_due','payment_pending','payroll_slip','sync_exception'
  title VARCHAR(255) NOT NULL,                   -- i18n-resolved Bahasa Indonesia at render time; store key+params in payload
  body TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  location_id UUID REFERENCES locations(id),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notification_outbox (               -- RISK-P4: WA channel mocks into this table until credentials arrive
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email','whatsapp')),
  recipient VARCHAR(255) NOT NULL,               -- email address or WA number
  template_key VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON notification_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

COMMIT;
