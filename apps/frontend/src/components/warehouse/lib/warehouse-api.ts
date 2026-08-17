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
import type { Paginated, Opname, OpnameLine } from '@/lib/shared-types';
import type {
  Balance, StorageArea, Item, Movement, Replenishment, SuratJalan,
  DailyRecap, PurchaseOrder, PurchaseOrderListRow, SupplierDirectoryEntry, ReturnDoc, ReturnDetail, WasteRecord,
} from './types';

// ── inventory (§4.7) ─────────────────────────────────────────────────────────

export function getBalances(params: { locationId: string; storageAreaId?: string; q?: string }) {
  // `pageSize` is capped at 200 backend-wide (CONTRACTS.md's pagination
  // rule, `ListBalancesQueryDto`'s `@Max(200)`) — 500 here 400'd with
  // ERR_VALIDATION on every call (FIX-LOADS #1: "Stok Gudang" tab always
  // showed "Gagal memuat data"). 200 matches the documented ceiling; a
  // warehouse with more than 200 distinct item/storage-area balance rows
  // would need real pagination here, which this ticket does not add.
  const qs = new URLSearchParams({ locationId: params.locationId, page: '1', pageSize: '200' });
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

// ── delivery / Surat Jalan (§4.10) — READ ONLY from this surface ───────────
//
// F-DELIVERY: the create/manage lifecycle (create, patch, ready, load,
// dispatch, cancel, drivers/vehicles pickers) now lives at `/delivery`
// (`components/delivery/**`, which reuses this surface's `SjCreateForm` by
// direct import — do not edit that path from here). Two places to create
// and manage the same document was the thing to avoid, so only the reads
// this surface's own `OutboundPanel` rollup needs stay here; every mutation
// wrapper that used to live here (createSuratJalan/patchSuratJalan/
// readySuratJalan/loadSuratJalan/dispatchSuratJalan/cancelSuratJalan) plus
// the driver/vehicle pickers moved with `SuratJalanPanel.tsx`'s removal —
// `components/delivery/lib/delivery-api.ts` carries its own copies.

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
  // `PurchaseOrderListRow`, not the full `PurchaseOrder` detail — the list
  // endpoint never returns `lines`/`subtotal`/`tax` (see `lib/types.ts`'s
  // header comment on the two interfaces).
  return api.get<Paginated<PurchaseOrderListRow>>(`/purchasing/orders?${qs.toString()}`);
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

// ── stock opname (§4.8) — the central warehouse runs its own counts against
// its own location, same endpoints outlet's `lib/outlet-api.ts` calls ─────

export function listOpname(locationId: string, status?: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  if (status) qs.set('status', status);
  return api.get<Paginated<Opname>>(`/stock-opname?${qs.toString()}`);
}

export function getOpname(id: string) {
  return api.get<Opname & { lines: OpnameLine[] }>(`/stock-opname/${id}`);
}

export function createOpname(locationId: string, storageAreaId?: string) {
  return api.post<Opname & { lines: OpnameLine[] }>('/stock-opname', { locationId, storageAreaId });
}

export function putOpnameLines(
  opnameId: string,
  lines: { storageAreaId: string; itemId: string; countedQty: string; varianceReason?: string }[],
) {
  return api.put<OpnameLine[]>(`/stock-opname/${opnameId}/lines`, { lines });
}

export function submitOpname(id: string) {
  return api.post<Opname & { lines: OpnameLine[] }>(`/stock-opname/${id}/submit`);
}

export function cancelOpname(id: string) {
  return api.delete<{ id: string; status: string }>(`/stock-opname/${id}`);
}

// ── waste (§4.12) — expired/damaged/spoiled stock written off at the
// central warehouse itself (distinct from `ReturnPanel`'s retur-to-supplier
// and retur-from-outlet flows) ──────────────────────────────────────────────

export function listWaste(locationId: string, status?: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  if (status) qs.set('status', status);
  return api.get<Paginated<WasteRecord>>(`/waste?${qs.toString()}`);
}

export function createWaste(body: {
  locationId: string;
  items: { storageAreaId: string; itemId: string; qty: string; reason: string; reasonDetail?: string }[];
  photoAttachmentIds: string[];
}) {
  return api.post<WasteRecord[]>('/waste', body);
}
