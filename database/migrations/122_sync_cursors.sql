-- Migration: 122_sync_cursors
-- Block: 120-129 (sync & offline authorization, D-12, D-17)
-- Description: pull cursors per subscriber (positions in THIS tier's
--              server_seq; per-upstream, non-transferable).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE sync_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_type VARCHAR(10) NOT NULL CHECK (subscriber_type IN ('device','node')),
  subscriber_id UUID NOT NULL,
  stream VARCHAR(40) NOT NULL DEFAULT 'main',    -- single main stream v1; reserved for future split
  cursor BIGINT NOT NULL DEFAULT 0,              -- last server_seq served/acked
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscriber_id, stream)
);

COMMIT;
