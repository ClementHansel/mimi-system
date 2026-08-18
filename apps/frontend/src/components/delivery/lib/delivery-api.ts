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
import type { LiveDelivery, Paginated, SjPosition, SuratJalan } from '@/lib/shared-types';
import type { Driver, Vehicle, DailyRecap, Replenishment } from './types';

export function listSuratJalan(
  params: {
    status?: string;
    date?: string;
    locationId?: string;
    driverId?: string;
    page?: number;
  } = {},
) {
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
  drops: {
    locationId: string;
    replenishmentRequestId?: string;
    lines: { itemId: string; qty: string; unitId: string; requestLineId?: string }[];
  }[];
  notes?: string;
}) {
  return api.post<SuratJalan>('/delivery/surat-jalan', body);
}

export function patchSuratJalan(
  id: string,
  body: Partial<{ driverId: string; vehicleId: string; plannedDate: string; notes: string }>,
) {
  return api.patch<SuratJalan>(`/delivery/surat-jalan/${id}`, body);
}

export function readySuratJalan(id: string) {
  return api.post<SuratJalan>(`/delivery/surat-jalan/${id}/ready`);
}

export function loadSuratJalan(
  id: string,
  body: { seals: { sealNumber: string }[]; tempC?: string },
) {
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

// ── Route planning (gudang) + live tracking, migration 221 ──────────────────

/** Replace the stop order wholesale. Array position IS the sequence — the
 * client never sends `dropSeq`, so there is only one source of truth for
 * "which stop is third". `deliveryInstructions` is optional per stop: omit to
 * leave an existing brief untouched, send '' to clear it. */
export function planRoute(
  sjId: string,
  stops: { dropId: string; deliveryInstructions?: string }[],
) {
  return api.put<{ sjId: string; stops: number }>(`/delivery/surat-jalan/${sjId}/route`, { stops });
}

/** Update one stop's brief without touching the order — allowed later in the
 * lifecycle than a reorder, so dispatch can warn a driver already on the road. */
export function setDropInstructions(dropId: string, deliveryInstructions: string | null) {
  return api.patch<{ dropId: string; deliveryInstructions: string | null }>(
    `/delivery/surat-jalan/drops/${dropId}/instructions`,
    { deliveryInstructions },
  );
}

/** Every truck in transit plus its latest fix — the live board's poll target. */
export function getLiveBoard() {
  return api.get<LiveDelivery[]>(`/delivery/live`);
}

/** Breadcrumb trail for one trip. `since` returns only the tail so the live
 * view polls cheaply instead of refetching the whole day each tick. */
export function getTrail(sjId: string, since?: string) {
  const qs = since ? `?${new URLSearchParams({ since }).toString()}` : '';
  return api.get<SjPosition[]>(`/delivery/surat-jalan/${sjId}/positions${qs}`);
}
