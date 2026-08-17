-- Migration: 121_sync_batches
-- Block: 120-129 (sync & offline authorization, D-12, D-17)
-- Description: push batches (transport observability; batch_id is NOT an
--              idempotency key — event_id is).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE sync_batches (
  id UUID PRIMARY KEY,                           -- client-generated per transmission (retry mints a new one)
  origin_tier VARCHAR(10) NOT NULL,
  origin_device_id UUID NOT NULL,
  location_id UUID REFERENCES locations(id),
  event_count INTEGER NOT NULL,
  first_seq BIGINT NOT NULL,
  last_seq BIGINT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'received' CHECK (status IN ('received','applied','partial','failed')),
  result JSONB NOT NULL DEFAULT '{}',            -- {accepted_through, confirmed_through, rejected[], resend_from}
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

ALTER TABLE sync_events ADD CONSTRAINT fk_se_batch FOREIGN KEY (batch_id) REFERENCES sync_batches(id);

COMMIT;
