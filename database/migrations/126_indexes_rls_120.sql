-- Migration: 126_indexes_rls_120
-- Block: 120-129 (sync & offline authorization, D-12, D-17)
-- Description: indexes + RLS for block 120-129. Per §1.14, only
--              offline_credentials is RLS-enabled (SELF, grouped with
--              sessions); sync_events/sync_batches/sync_cursors/
--              sync_conflicts/offline_authorizations are NONE (API-gated —
--              these are cloud-kernel bookkeeping surfaces reached only
--              through M23 sync / F12 topology, never raw CRUD).
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- INDEXES
-- =============================================================================

CREATE INDEX idx_sync_events_entity ON sync_events(entity, entity_id);
CREATE INDEX idx_sync_events_location_seq ON sync_events(location_id, server_seq);
CREATE INDEX idx_sync_events_apply_status ON sync_events(apply_status) WHERE apply_status <> 'applied';
CREATE INDEX idx_sync_events_origin_device ON sync_events(origin_device_id);
CREATE INDEX idx_sync_events_batch ON sync_events(batch_id);
CREATE INDEX idx_sync_events_actor ON sync_events(actor_user_id);

CREATE INDEX idx_sync_batches_origin_device ON sync_batches(origin_device_id);
CREATE INDEX idx_sync_batches_location ON sync_batches(location_id);
CREATE INDEX idx_sync_batches_status ON sync_batches(status);

CREATE INDEX idx_sync_cursors_subscriber ON sync_cursors(subscriber_id);

CREATE INDEX idx_sync_conflicts_status ON sync_conflicts(status);
CREATE INDEX idx_sync_conflicts_queue ON sync_conflicts(queue);
CREATE INDEX idx_sync_conflicts_location ON sync_conflicts(location_id);
CREATE INDEX idx_sync_conflicts_entity ON sync_conflicts(entity, entity_id);

CREATE INDEX idx_offline_credentials_user ON offline_credentials(user_id);
CREATE INDEX idx_offline_credentials_device ON offline_credentials(device_id);
CREATE INDEX idx_offline_credentials_expires ON offline_credentials(expires_at);

CREATE INDEX idx_offline_authorizations_credential ON offline_authorizations(credential_id);
CREATE INDEX idx_offline_authorizations_user ON offline_authorizations(user_id);
CREATE INDEX idx_offline_authorizations_device ON offline_authorizations(device_id);
CREATE INDEX idx_offline_authorizations_document ON offline_authorizations(document_type, document_id);
CREATE INDEX idx_offline_authorizations_outcome ON offline_authorizations(outcome);

-- =============================================================================
-- RLS — offline_credentials: SELF
-- =============================================================================

ALTER TABLE offline_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE offline_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY offline_credentials_self ON offline_credentials FOR ALL
  USING (app_is_self(user_id)) WITH CHECK (app_is_self(user_id));

COMMIT;
