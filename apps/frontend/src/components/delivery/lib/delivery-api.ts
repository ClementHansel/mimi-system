/**
 * Typed REST calls for F-DELIVERY `delivery` (CONTRACTS.md §4.10, §4.9 read
 * side). Thin wrappers over `@/lib/api`'s `api` client — same convention as
 * `components/warehouse/lib/warehouse-api.ts`'s own §4.10 section (this
 * surface's dispatcher screens moved to a dedicated route/nav entry per the
 * F-DELIVERY ticket, but the wire paths/shapes are identical — CONTRACTS is
 * the single source, transcribed independently here since each frontend
 * surface owns its own API client, the established convention across
 * `outlet`/`warehouse`/`purchasing`/`driver`).
 *
 * Laptop/back-office surface (D-05) — plain online REST, no offline-runtime
 * gap to flag (unlike `driver`'s `LocalRuntime` path for on-road actions).
 */
import { api } from '@/lib/api';
import type { Paginated, SuratJalan } from '@/lib/shared-types';
import type { Driver, Vehicle, DailyRecap, Replenishment } from './types';

export function listSuratJalan(params: { status?: string; date?: string; locationId?: string; driverId?: string; page?: number } = {}) {
  const qs = new URLSearchParams({ page: String(params.page ?? 1) });
  if (params.status) qs.set('status', params.status);
  if (params.date) qs.set('date', params.date);
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.driverId) qs.set('driverId', params.driverId);
  return api.get<Paginated<SuratJalan>>(`/delivery/surat-jalan?${qs.toString()}`);
}

export function getSuratJalan(id: string) {
  return api.get<SuratJalan>(`/delivery/surat-jalan/${id}`);
}

export function createSuratJalan(body: {
  shipmentType: 'frozen' | 'dry';
  driverId: string;
  vehicleId: string;
  plannedDate: string;
  drops: { locationId: string; replenishmentRequestId?: string; lines: { itemId: string; qty: string; unitId: string; requestLineId?: string }[] }[];
  notes?: string;
}) {
  return api.post<SuratJalan>('/delivery/surat-jalan', body);
}

export function patchSuratJalan(id: string, body: Partial<{ driverId: string; vehicleId: string; plannedDate: string; notes: string }>) {
  return api.patch<SuratJalan>(`/delivery/surat-jalan/${id}`, body);
}

export function readySuratJalan(id: string) {
  return api.post<SuratJalan>(`/delivery/surat-jalan/${id}/ready`);
}

export function loadSuratJalan(id: string, body: { seals: { sealNumber: string }[]; tempC?: string }) {
  return api.post<SuratJalan>(`/delivery/surat-jalan/${id}/load`, body);
}

export function dispatchSuratJalan(id: string) {
  return api.post<SuratJalan>(`/delivery/surat-jalan/${id}/dispatch`);
}

export function cancelSuratJalan(id: string, body: { reason: string }) {
  return api.post<SuratJalan>(`/delivery/surat-jalan/${id}/cancel`, body);
}

export function getDrivers(active = true) {
  return api.get<Driver[]>(`/delivery/drivers?active=${active}`);
}

export function getVehicles(active = true) {
  return api.get<Vehicle[]>(`/delivery/vehicles?active=${active}`);
}

export function getDailyRecap(date: string) {
  return api.get<DailyRecap>(`/delivery/recap/daily?date=${date}`);
}

/** The warehouse work queue (§4.9) filtered to `approved` — the SJ-create picker's request source, same endpoint `warehouse`'s own builder reads. */
export function listApprovedRequests() {
  return api.get<Paginated<Replenishment>>(`/replenishment/queue/warehouse?status=approved`);
}
