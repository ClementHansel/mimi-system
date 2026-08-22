/**
 * Typed REST calls for F12 `topology` (CONTRACTS.md §4.21/§4.23). Plain
 * online REST — this is a laptop/wallboard monitoring surface, never an
 * offline-enqueued write path (there are no writes here beyond dismissing a
 * conflict, which only ever happens online).
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type { TopologyTree, SyncStatusRow, SyncConflictRow, ReconciliationRow } from './types';

export function getTopologyTree() {
  return api.get<TopologyTree>('/topology');
}

export function getSyncStatus(locationId?: string) {
  const qs = locationId ? `?locationId=${locationId}` : '';
  return api.get<SyncStatusRow[]>(`/sync/status${qs}`);
}

export interface ConflictListParams {
  kind?: string;
  queue?: string;
  status?: string;
  locationId?: string;
  page?: number;
  pageSize?: number;
}

export function getSyncConflicts(params: ConflictListParams) {
  const qs = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 20),
  });
  if (params.kind) qs.set('kind', params.kind);
  if (params.queue) qs.set('queue', params.queue);
  if (params.status) qs.set('status', params.status);
  if (params.locationId) qs.set('locationId', params.locationId);
  return api.get<Paginated<SyncConflictRow>>(`/sync/conflicts?${qs.toString()}`);
}

export function dismissSyncConflict(id: string, reason: string) {
  return api.post<SyncConflictRow>(`/sync/conflicts/${id}/dismiss`, { reason });
}

/**
 * Records the outcome of a stock divergence investigation (D-16). The note is
 * mandatory server-side; `adjustmentId` is the opname/adjustment this was
 * settled by, when there was one — the endpoint folds it into the stored
 * resolution text so the trail says which document fixed it.
 */
export function resolveReconciliation(id: string, resolution: string, adjustmentId?: string) {
  return api.post<ReconciliationRow>(`/sync/reconciliations/${id}/resolve`, {
    resolution,
    adjustmentId,
  });
}

export interface ReconciliationListParams {
  status?: string;
  locationId?: string;
  page?: number;
  pageSize?: number;
}

export function getReconciliations(params: ReconciliationListParams) {
  const qs = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 20),
  });
  if (params.status) qs.set('status', params.status);
  if (params.locationId) qs.set('locationId', params.locationId);
  return api.get<Paginated<ReconciliationRow>>(`/sync/reconciliations?${qs.toString()}`);
}
