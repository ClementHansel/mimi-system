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

/**
 * The requests a Surat Jalan may be built from: `approved` AND `processing`.
 *
 * BOTH, deliberately. `ReplenishmentRepository.listWarehouseQueue` says it in
 * its own header — "`approved`+`processing` feed SJ building (M10)" — and this
 * asked for `approved` alone, so the moment a Kepala Gudang pressed "Mulai
 * Pemrosesan" in their own approval queue (the obvious next thing to do, and
 * the only button that row offers) the request vanished from this picker and
 * could never be put on a truck. `approved → processing → shipped` is the
 * documented order; picking the stock is not supposed to make it unshippable.
 *
 * Two calls rather than one, because `WarehouseQueueQueryDto.status` takes a
 * single value — a repeated query parameter would be a contract change, and
 * this needs none. Merged by id in case the statuses ever overlap.
 *
 * EVERY PAGE OF EACH, and NEWEST FIRST. Both parts are load-bearing:
 *
 *  - This used to send no `page`/`pageSize`, so it got the endpoint's defaults:
 *    page 1, fifty rows, `ORDER BY submitted_at ASC NULLS LAST` — the OLDEST
 *    fifty. That ordering is right for the queue it was written for (the Kepala
 *    Gudang's approval list is FIFO work), and wrong for this one. A request
 *    leaves `approved`/`processing` only when its Surat Jalan is dispatched, so
 *    the open set is a backlog that grows; the first time it passed fifty rows,
 *    every NEWLY approved request would have sorted past the cut and simply not
 *    appeared in this picker — approve it, come here, and it is not on the list.
 *    Paging to the end is the only honest fix: this picker may not silently show
 *    a subset of what can be shipped.
 *  - Sorted newest-first for DISPLAY, because the request a dispatcher is
 *    looking for is almost always the one just approved. The server's order is
 *    left alone; this is a client-side presentation choice for one screen.
 */
const SJ_PICKER_PAGE_SIZE = 200; // `WarehouseQueueQueryDto.pageSize`'s own @Max.
/**
 * A hard stop, not a limit anyone should reach: 40,000 simultaneously open
 * replenishment requests means something upstream is broken, and a runaway
 * loop against the API is a worse way to find that out than a short list.
 */
const SJ_PICKER_MAX_PAGES = 200;

async function fetchWholeWarehouseQueue(status: string): Promise<Replenishment[]> {
  const collected: Replenishment[] = [];
  for (let page = 1; page <= SJ_PICKER_MAX_PAGES; page += 1) {
    const res = await api.get<Paginated<Replenishment>>(
      `/replenishment/queue/warehouse?status=${status}&page=${page}&pageSize=${SJ_PICKER_PAGE_SIZE}`,
    );
    collected.push(...res.rows);
    // A short page is the end. `total` is checked too so a server that returns
    // a full last page still terminates on the next-to-nothing round trip.
    if (res.rows.length < SJ_PICKER_PAGE_SIZE || collected.length >= res.total) break;
  }
  return collected;
}

/** Newest request first — `submittedAt` descending, never-submitted last, request number as the tie-break. */
function newestFirst(a: Replenishment, b: Replenishment): number {
  if (a.submittedAt !== b.submittedAt) {
    if (!a.submittedAt) return 1;
    if (!b.submittedAt) return -1;
    return a.submittedAt < b.submittedAt ? 1 : -1;
  }
  return b.requestNumber.localeCompare(a.requestNumber);
}

export async function listApprovedRequests(): Promise<Paginated<Replenishment>> {
  const [approved, processing] = await Promise.all([
    fetchWholeWarehouseQueue('approved'),
    fetchWholeWarehouseQueue('processing'),
  ]);
  const byId = new Map([...approved, ...processing].map((r) => [r.id, r]));
  const rows = [...byId.values()].sort(newestFirst);
  return { rows, total: rows.length, page: 1, pageSize: rows.length };
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
