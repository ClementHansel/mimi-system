/**
 * Cloud-only DB row shapes — CONTRACTS.md §1.13 block 120-129, verbatim
 * column names (raw `pg` returns snake_case). These are NOT protocol surface
 * (that's `@mimi/sync-protocol`'s `SyncEventEnvelope` etc., camelCase,
 * frozen) — this file exists only because the cloud persists bookkeeping
 * columns (`apply_status`, `applied_at`, `batch_id`, `reject_code`, ...)
 * that CONTRACTS.md explicitly marks "not protocol surface" (SYNC-PROTOCOL
 * §2.1) and therefore do not appear in the shared package.
 */
import type { Money, UUID } from '@mimi/shared';

export type ApplyStatus = 'pending' | 'applied' | 'quarantined' | 'superseded' | 'pending_dependency';
export type SyncBatchStatusRow = 'received' | 'applied' | 'partial' | 'failed';
export type OfflineAuthOutcomeRow = 'pending_verification' | 'verified' | 'failed' | 'unprovable';
export type OfflineAuthVerdictRow = 'upheld' | 'rejected';

export interface SyncEventRow {
  event_id: UUID;
  server_seq: string; // BIGINT -> pg returns string
  origin_tier: 'device' | 'node' | 'cloud';
  origin_device_id: UUID;
  location_id: UUID | null;
  entity: string;
  entity_id: UUID;
  op: string;
  payload: unknown;
  client_seq: string; // BIGINT
  occurred_at: string;
  received_at: string;
  relay_received_at: string | null;
  relayed_via_node_id: UUID | null;
  actor_user_id: UUID;
  schema_v: number;
  batch_id: UUID | null;
  apply_status: ApplyStatus;
  applied_at: string | null;
  reject_code: string | null;
  reject_detail: string | null;
}

export interface SyncBatchRow {
  id: UUID;
  origin_tier: string;
  origin_device_id: UUID;
  location_id: UUID | null;
  event_count: number;
  first_seq: string;
  last_seq: string;
  status: SyncBatchStatusRow;
  result: unknown;
  received_at: string;
  processed_at: string | null;
}

export interface SyncCursorRow {
  id: UUID;
  subscriber_type: 'device' | 'node';
  subscriber_id: UUID;
  stream: string;
  cursor: string;
  updated_at: string;
}

export interface SyncConflictRow {
  id: UUID;
  kind: string;
  queue: 'conflict' | 'exception' | 'finance' | 'hr';
  entity: string;
  entity_id: UUID | null;
  location_id: UUID | null;
  winner_event_id: UUID | null;
  loser_event_id: UUID | null;
  detail: unknown;
  physical_effect_suspected: boolean;
  assignee_role: string | null;
  status: 'open' | 'resolved' | 'dismissed';
  resolution_event_id: UUID | null;
  resolved_by: UUID | null;
  resolved_at: string | null;
  resolution: string | null;
  created_at: string;
  updated_at: string;
}

export interface OfflineCredentialRow {
  credential_id: UUID;
  user_id: UUID;
  device_id: UUID | null;
  role_key: string;
  location_ids: UUID[];
  scopes: Record<string, { max_idr?: Money }>;
  binding_secret_enc: Buffer;
  pin_verifier: string;
  selfie_required_above: Money;
  volume_cap: number;
  use_count: number;
  minted_at: string;
  expires_at: string;
  revoked_at: string | null;
}

export interface OfflineAuthorizationRow {
  id: UUID;
  credential_id: UUID;
  approval_event_id: UUID | null;
  user_id: UUID;
  device_id: UUID;
  location_id: UUID | null;
  document_type: string;
  document_id: UUID;
  action: string;
  amount: Money | null;
  binding_hmac: string;
  pin_attempts_before_success: number | null;
  selfie_attachment_id: UUID | null;
  granted_at: string;
  relay_received_at: string | null;
  synced_at: string | null;
  outcome: OfflineAuthOutcomeRow;
  failure_reason: string | null;
  verdict: OfflineAuthVerdictRow | null;
  reviewed_by: UUID | null;
  reviewed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface DeviceRow {
  id: UUID;
  location_id: UUID;
  node_id: UUID | null;
  category: string;
  name: string;
  status: 'online' | 'stale' | 'offline' | 'unpaired' | 'retired';
  device_token_hash: string | null;
  queue_depth: number;
  last_seen_at: string | null;
  last_sync_at: string | null;
}
