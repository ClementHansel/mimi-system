/**
 * Typed REST calls for F05 `warehouse` (CONTRACTS.md §4.7, §4.9, §4.10,
 * §4.11, §4.12). Thin wrappers over `@/lib/api`'s `api` client — every
 * path/shape here is transcribed verbatim from CONTRACTS, nothing invented.
 * This surface is laptop-first back-office work (D-05), not the offline-first
 * pattern F02/F04/F13 use, so plain online REST calls are the correct
 * default here (no `LocalRuntime` gap to flag, unlike outlet's receiving
 * flow).
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type {
  Balance, StorageArea, Item, Movement, Replenishment, SuratJalan, Driver, Vehicle,
  DailyRecap, PurchaseOrder, SupplierDirectoryEntry, ReturnDoc, ReturnDetail,
} from './types';

// ── inventory (§4.7) ─────────────────────────────────────────────────────────

export function getBalances(params: { locationId: string; storageAreaId?: string; q?: string }) {
  const qs = new URLSearchParams({ locationId: params.locationId, page: '1', pageSize: '500' });
  if (params.storageAreaId) qs.set('storageAreaId', params.storageAreaId);
  if (params.q) qs.set('q', params.q);
  return api.get<Paginated<Balance>>(`/inventory/balances?${qs.toString()}`);
}

export function getStorageAreas(locationId: string) {
  return api.get<StorageArea[]>(`/locations/${locationId}/storage-areas?active=true`);
}

export function getItems(q?: string) {
  const qs = new URLSearchParams({ page: '1', pageSize: '200' });
  if (q) qs.set('q', q);
  return api.get<Paginated<Item>>(`/items?${qs.toString()}`);
}

export function getMovements(params: { locationId: string; itemId?: string; storageAreaId?: string; from?: string; to?: string }) {
  const qs = new URLSearchParams({ locationId: params.locationId, page: '1' });
  if (params.itemId) qs.set('itemId', params.itemId);
  if (params.storageAreaId) qs.set('storageAreaId', params.storageAreaId);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  return api.get<Paginated<Movement>>(`/inventory/movements?${qs.toString()}`);
}

// ── replenishment (§4.9) — the warehouse approval + shipping work queue ────

export function listWarehouseQueue(status?: string) {
  const qs = new URLSearchParams();
  if (status) qs.set('status', status);
  return api.get<Paginated<Replenishment>>(`/replenishment/queue/warehouse?${qs.toString()}`);
}

export function getReplenishment(id: string) {
  return api.get<Replenishment>(`/replenishment/${id}`);
}

export function approveReplenishment(
  id: string,
  body: { note?: string; amendments?: { lineId: string; qtyApproved: string; reason: string }[] },
) {
  return api.post<Replenishment>(`/replenishment/${id}/approve`, body);
}

export function rejectReplenishment(id: string, body: { reason: string }) {
  return api.post<Replenishment>(`/replenishment/${id}/reject`, body);
}

export function processReplenishment(id: string) {
  return api.post<Replenishment>(`/replenishment/${id}/process`);
}

// ── delivery / Surat Jalan (§4.10) ──────────────────────────────────────────

export function listSuratJalan(params: { status?: string; date?: string; locationId?: string; driverId?: string } = {}) {
  const qs = new URLSearchParams({ page: '1' });
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

export function patchSuratJalan(
  id: string,
  body: Partial<{ driverId: string; vehicleId: string; plannedDate: string; notes: string }>,
) {
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

// ── purchasing / PO receiving (§4.11) ───────────────────────────────────────

export function listPurchaseOrders(params: { status?: string; supplierId?: string; from?: string; to?: string } = {}) {
  const qs = new URLSearchParams({ page: '1' });
  if (params.status) qs.set('status', params.status);
  if (params.supplierId) qs.set('supplierId', params.supplierId);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  return api.get<Paginated<PurchaseOrder>>(`/purchasing/orders?${qs.toString()}`);
}

export function getPurchaseOrder(id: string) {
  return api.get<PurchaseOrder>(`/purchasing/orders/${id}`);
}

export function receivePurchaseOrder(
  id: string,
  body: { lines: { poLineId: string; qtyReceived: string; storageAreaId: string; conditionNotes?: string }[]; photoAttachmentIds: string[]; notes?: string },
) {
  return api.post<PurchaseOrder>(`/purchasing/orders/${id}/receipts`, body);
}

export function getSupplierDirectory(q?: string) {
  const qs = new URLSearchParams({ page: '1', pageSize: '50' });
  if (q) qs.set('q', q);
  return api.get<Paginated<SupplierDirectoryEntry>>(`/suppliers/directory?${qs.toString()}`);
}

// ── waste-return — retur to supplier + retur received from outlet (§4.12) ──

export function listReturns(params: { direction?: string; locationId?: string; status?: string } = {}) {
  const qs = new URLSearchParams({ page: '1' });
  if (params.direction) qs.set('direction', params.direction);
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.status) qs.set('status', params.status);
  return api.get<Paginated<ReturnDoc>>(`/returns?${qs.toString()}`);
}

export function getReturn(id: string) {
  return api.get<ReturnDetail>(`/returns/${id}`);
}

export function createReturn(body: {
  direction: string;
  fromLocationId: string;
  toLocationId?: string;
  supplierId?: string;
  lines: { itemId: string; storageAreaId: string; qty: string; condition: string; reason: string }[];
  photoAttachmentIds: string[];
}) {
  return api.post<ReturnDoc>('/returns', body);
}

export function submitReturn(id: string) {
  return api.post<ReturnDoc>(`/returns/${id}/submit`);
}

export function shipReturn(id: string, body: { proofAttachmentIds: string[] }) {
  return api.post<ReturnDoc>(`/returns/${id}/ship`, body);
}

export function receiveReturnDoc(id: string, body: { lines: { lineId: string; qtyReceived: string; storageAreaId: string }[]; proofAttachmentIds: string[] }) {
  return api.post<ReturnDoc>(`/returns/${id}/receive`, body);
}
