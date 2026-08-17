/**
 * Typed REST calls for F09 `assets` (CONTRACTS.md §4.16). Thin wrappers over
 * `@/lib/api`'s `api` client — same convention as `components/outlet/lib/outlet-api.ts`.
 *
 * Plain online REST throughout. `@mimi/sync-protocol`'s schema registry
 * DOES define offline-eligible ops for this entity (`assets.created/updated
 * /retired`, `maintenance_schedules.updated`, `maintenance_jobs.created
 * /completed`) — unlike outlet's opname/waste/petty-cash gap, this one isn't
 * a missing mapping. Wiring it through `LocalRuntime` (there is no named
 * helper for it yet, only the generic `enqueueFact`) is a reasonable
 * follow-up for a technician completing a job at a signal-dead outlet, but
 * is out of this ticket's scope/budget — flagged in the report rather than
 * half-built here.
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type { Asset, AssetDetail, Schedule, Job, DueItem, ServiceHistoryRow } from './types';

export interface AssetListParams {
  locationId?: string;
  category?: string;
  status?: string;
  condition?: string;
  q?: string;
}

export function getAssets(params: AssetListParams) {
  const qs = new URLSearchParams({ page: '1', pageSize: '100' });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.category) qs.set('category', params.category);
  if (params.status) qs.set('status', params.status);
  if (params.condition) qs.set('condition', params.condition);
  if (params.q) qs.set('q', params.q);
  return api.get<Paginated<Asset>>(`/assets?${qs.toString()}`);
}

export function getAsset(id: string) {
  return api.get<AssetDetail>(`/assets/${id}`);
}

export function createAsset(body: {
  assetNumber?: string;
  name: string;
  category: string;
  locationId: string;
  serialNumber?: string;
  brand?: string;
  model?: string;
  purchaseDate?: string;
  purchasePrice?: string;
  photoAttachmentId?: string;
}) {
  return api.post<Asset>('/assets', body);
}

export function updateAsset(id: string, body: Partial<{
  name: string; category: string; locationId: string; serialNumber: string; brand: string; model: string;
  condition: string; status: string; assignedToEmployeeId: string | null;
}>) {
  return api.patch<Asset>(`/assets/${id}`, body);
}

export function getSchedules(assetId: string) {
  return api.get<Schedule[]>(`/assets/${assetId}/schedules`);
}

export function createSchedule(assetId: string, body: {
  name: string; intervalType: 'days' | 'months'; intervalValue: number; nextDueAt: string; reminderDaysBefore?: number;
}) {
  return api.post<Schedule>(`/assets/${assetId}/schedules`, body);
}

export function updateSchedule(scheduleId: string, body: Partial<{
  name: string; intervalType: 'days' | 'months'; intervalValue: number; nextDueAt: string; reminderDaysBefore: number; isActive: boolean;
}>) {
  return api.patch<Schedule>(`/assets/schedules/${scheduleId}`, body);
}

export function getMaintenanceDue(windowDays = 30, locationId?: string) {
  const qs = new URLSearchParams({ windowDays: String(windowDays) });
  if (locationId) qs.set('locationId', locationId);
  return api.get<DueItem[]>(`/assets/maintenance/due?${qs.toString()}`);
}

export interface JobListParams {
  locationId?: string;
  status?: string;
  assetId?: string;
}

export function getJobs(params: JobListParams) {
  const qs = new URLSearchParams({ page: '1', pageSize: '100' });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.status) qs.set('status', params.status);
  if (params.assetId) qs.set('assetId', params.assetId);
  return api.get<Paginated<Job>>(`/assets/jobs?${qs.toString()}`);
}

export function createJob(assetId: string, description: string, assignedToEmployeeId?: string) {
  return api.post<Job>(`/assets/${assetId}/jobs`, { type: 'corrective', description, assignedToEmployeeId });
}

export function startJob(jobId: string) {
  return api.post<Job>(`/assets/jobs/${jobId}/start`);
}

export function completeJob(jobId: string, body: {
  proofAttachmentIds: string[];
  cost?: string;
  vendor?: string;
  conditionAfter: string;
  odometerKm?: number;
  notes?: string;
}) {
  return api.post<Job>(`/assets/jobs/${jobId}/complete`, body);
}

export function verifyJob(jobId: string, note?: string) {
  return api.post<Job>(`/assets/jobs/${jobId}/verify`, { note });
}

export function getAssetHistory(assetId: string) {
  return api.get<Paginated<ServiceHistoryRow>>(`/assets/${assetId}/history?page=1`);
}
