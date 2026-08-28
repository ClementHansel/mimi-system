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
  /** Defaults to 1 — added so an export walk can page past the 100-row cap `AssetRegisterPanel` otherwise reads as "everything". */
  page?: number;
}

export function getAssets(params: AssetListParams) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '100' });
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

export function updateAsset(
  id: string,
  body: Partial<{
    name: string;
    category: string;
    locationId: string;
    serialNumber: string;
    brand: string;
    model: string;
    condition: string;
    status: string;
    assignedToEmployeeId: string | null;
  }>,
) {
  return api.patch<Asset>(`/assets/${id}`, body);
}

export function getSchedules(assetId: string) {
  return api.get<Schedule[]>(`/assets/${assetId}/schedules`);
}

export function createSchedule(
  assetId: string,
  body: {
    name: string;
    intervalType: 'days' | 'months';
    intervalValue: number;
    nextDueAt: string;
    reminderDaysBefore?: number;
  },
) {
  return api.post<Schedule>(`/assets/${assetId}/schedules`, body);
}

export function updateSchedule(
  scheduleId: string,
  body: Partial<{
    name: string;
    intervalType: 'days' | 'months';
    intervalValue: number;
    nextDueAt: string;
    reminderDaysBefore: number;
    isActive: boolean;
  }>,
) {
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
  /** Defaults to 1 — see `AssetListParams.page`. */
  page?: number;
}

export function getJobs(params: JobListParams) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1), pageSize: '100' });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.status) qs.set('status', params.status);
  if (params.assetId) qs.set('assetId', params.assetId);
  return api.get<Paginated<Job>>(`/assets/jobs?${qs.toString()}`);
}

export function createJob(assetId: string, description: string, assignedToEmployeeId?: string) {
  return api.post<Job>(`/assets/${assetId}/jobs`, {
    type: 'corrective',
    description,
    assignedToEmployeeId,
  });
}

export function startJob(jobId: string) {
  return api.post<Job>(`/assets/jobs/${jobId}/start`);
}

export function completeJob(
  jobId: string,
  body: {
    proofAttachmentIds: string[];
    cost?: string;
    vendor?: string;
    conditionAfter: string;
    odometerKm?: number;
    notes?: string;
  },
) {
  return api.post<Job>(`/assets/jobs/${jobId}/complete`, body);
}

export function verifyJob(jobId: string, note?: string) {
  return api.post<Job>(`/assets/jobs/${jobId}/verify`, { note });
}

export function getAssetHistory(assetId: string) {
  return api.get<Paginated<ServiceHistoryRow>>(`/assets/${assetId}/history?page=1`);
}

// ── export/import lookups (§4.16 register round-trip) ───────────────────────
//
// `assetIoColumns` (`lib/io-columns.ts`) needs a location CODE and an
// employee_number for two of the importer's columns, neither of which
// `AssetDto` puts on the wire (see that file's header). Both helpers below
// resolve by NAME against the reference lists those OTHER modules already
// expose read-only endpoints for — best effort, not a guess: an unmatched or
// ambiguous name is simply absent from the returned map, and `io-columns.ts`
// exports a blank cell for that case rather than picking one.

/** Every active location's code, keyed by name. */
export function listLocationCodesByName(): Promise<Map<string, string>> {
  return api
    .get<{ rows: { name: string; code: string }[] }>('/locations?active=true&pageSize=200')
    .then((res) => new Map(res.rows.map((l) => [l.name, l.code])))
    .catch(() => new Map<string, string>());
}

/**
 * Every employee's number, keyed by name — walked a few pages rather than
 * one giant `pageSize` (mirrors `EmployeesPanel.loadExportSnapshot`'s bound,
 * for the same reason: a server that ignores `page` must not spin here
 * forever). Two employees sharing a name collide in this map (the second
 * wins) — an accepted gap for a best-effort optional column, not a silent
 * wrong PIC: `io-columns.ts` only uses this for the importer's OPTIONAL
 * `assigned_to`, never a required field.
 */
export async function listEmployeeNumbersByName(): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  let fetched = 0;
  for (let page = 1; page <= 40; page += 1) {
    let res: { rows: { name: string; employeeNumber: string }[]; total: number };
    try {
      res = await api.get(`/hr/employees?page=${page}&pageSize=100`);
    } catch {
      // No `hr.employee.read` (asset staff without HR access) or a transient
      // error — degrade to no PIC resolution rather than fail the export.
      break;
    }
    for (const e of res.rows) byName.set(e.name, e.employeeNumber);
    fetched += res.rows.length;
    if (res.rows.length < 100 || fetched >= res.total) break;
  }
  return byName;
}
