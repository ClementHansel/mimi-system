-- Migration: 258_w3_10_branch_node_network_config
-- Block: 110-119 (device registry & branch nodes, D-12/D-13)
-- Description: real remote write path for a branch node's network settings
--   (W3-10 hardening — closes the "network config has no backend" gap) plus
--   two new device_events types for the remote-command/network-config result
--   history the same hardening pass adds to `BridgeGateway`.
-- Created at: 2026-08-27

BEGIN;

-- `network_config` — the NON-SECRET desired/current settings (BE-side
-- validated shape: healthPort, scanSubnet, wifiSsid, staticIp, subnetMask,
-- gateway, dns[], plus a `wifiPassphraseSet: boolean` flag). Never contains
-- the WiFi passphrase itself — that lives only in `network_secret_enc`,
-- encrypted at rest (AES-256-GCM, same convention as
-- `kernel/sync/binding-crypto.ts`'s `offline_credentials.binding_secret_enc`)
-- and is never selected back out over the API (write-only, like that column).
--
-- `network_config_status` is the apply-then-confirm state machine driven by
-- the node's own `network_config_ack` (received over `/bridge`, never
-- inferred cloud-side): 'pending' the moment a validated config is pushed to
-- a connected node, then 'applied'/'reverted'/'failed' once the node reports
-- back what actually happened. A node that goes unreachable mid-apply simply
-- never sends an ack — the row sits at 'pending' until it reconnects and
-- reports, which is the honest state (the cloud has no channel to force a
-- decision on a node it cannot reach).
ALTER TABLE branch_nodes
  ADD COLUMN network_config JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN network_secret_enc BYTEA,
  ADD COLUMN network_config_id UUID,
  ADD COLUMN network_config_status VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (network_config_status IN ('none', 'pending', 'applied', 'reverted', 'failed')),
  ADD COLUMN network_config_result JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN network_config_updated_at TIMESTAMPTZ;

-- device_events.type CHECK (migration 113) extended for the two new result
-- kinds this hardening pass records: a remote command's outcome
-- (restart/update/log_pull/discovery_scan — `BridgeGateway.onCommandAck`) and
-- a network-config apply's outcome (`BridgeGateway.onNetworkConfigAck`).
-- Append-only per repo convention: DROP + re-ADD the same constraint with the
-- superset list, never a destructive column change.
ALTER TABLE device_events DROP CONSTRAINT device_events_type_check;
ALTER TABLE device_events ADD CONSTRAINT device_events_type_check CHECK (type IN
  ('paired', 'unpaired', 'online', 'offline', 'stale', 'version_changed', 'queue_alert',
   'clock_skew', 'outlet_offline', 'outlet_online', 'command_result', 'network_config_result'));

COMMIT;
