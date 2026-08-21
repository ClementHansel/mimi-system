/**
 * Typed REST calls for F-PO `purchasing` (CONTRACTS.md §4.11) plus the M06
 * `supplier` endpoints this surface reads (§4.6). Thin wrappers over
 * `@/lib/api`'s `api` client — every path/body is transcribed from
 * CONTRACTS.md and cross-checked against the live DTOs in
 * `apps/backend/src/modules/purchasing/dto/*.dto.ts`. Plain online REST
 * (D-05 back-office laptop surface) — PR/PO/receiving are sync class X,
 * never routed through the offline `LocalRuntime`.
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type {
  Item,
  StorageArea,
  LocationOption,
  Supplier,
  SupplierDirectoryEntry,
  SupplierItem,
  SupplierWriteBody,
  SupplierTransaction,
  PriceHistoryEntry,
  PurchaseRequestListRow,
  PurchaseRequestDetail,
  PurchaseRequestHistoryEntry,
  PurchaseOrderListRow,
  PurchaseOrderDetail,
} from './types';

// ── lookups ──────────────────────────────────────────────────────────────────

export function getItems(q?: string) {
  const qs = new URLSearchParams({ page: '1', pageSize: '200' });
  if (q) qs.set('q', q);
  return api.get<Paginated<Item>>(`/items?${qs.toString()}`);
}

export function getStorageAreas(locationId: string) {
  return api.get<StorageArea[]>(`/locations/${locationId}/storage-areas?active=true`);
}

export function getLocations() {
  return api.get<Paginated<LocationOption>>(`/locations?active=true&pageSize=200`);
}

// ── §4.6 supplier ────────────────────────────────────────────────────────────

/** Full shape (pricing/termin/bank) — `supplier.read`; outlet roles get 403, use `getSupplierDirectory` instead. */
export function getSuppliers(q?: string) {
  const qs = new URLSearchParams({ page: '1', pageSize: '200' });
  if (q) qs.set('q', q);
  return api.get<Paginated<Supplier>>(`/suppliers?${qs.toString()}`);
}

/** Name/contact-only projection, outlet-visible (FR-SUP-06) — `supplier.directory.read`. */
export function getSupplierDirectory(q?: string) {
  const qs = new URLSearchParams({ page: '1', pageSize: '200' });
  if (q) qs.set('q', q);
  return api.get<Paginated<SupplierDirectoryEntry>>(`/suppliers/directory?${qs.toString()}`);
}

export function getSupplierItems(supplierId: string) {
  return api.get<SupplierItem[]>(`/suppliers/${supplierId}/items`);
}

/** FR-SUP-01 — `supplier.manage`. `code` is unique and immutable in practice; the API rejects a duplicate. */
export function createSupplier(body: SupplierWriteBody) {
  return api.post<Supplier>('/suppliers', body);
}

export function updateSupplier(id: string, body: Partial<SupplierWriteBody>) {
  return api.patch<Supplier>(`/suppliers/${id}`, body);
}

/** Soft-delete: the row stays and goes `isActive: false`, because purchase orders reference it. */
export function deactivateSupplier(id: string) {
  return api.delete<{ id: string; deactivated: true }>(`/suppliers/${id}`);
}

/** FR-SUP-03/04 — upsert. A CHANGED price appends to `supplier_price_history` server-side; nothing here needs to write that. */
export function upsertSupplierItem(
  supplierId: string,
  itemId: string,
  body: {
    supplierSku?: string | null;
    currentPrice: string;
    leadTimeDays?: number;
    isPreferred?: boolean;
  },
) {
  return api.put<SupplierItem>(`/suppliers/${supplierId}/items/${itemId}`, body);
}

export function deleteSupplierItem(supplierId: string, itemId: string) {
  return api.delete<{ ok: true }>(`/suppliers/${supplierId}/items/${itemId}`);
}

/** FR-SUP-02/05 — the supplier's PO history. */
export function getSupplierTransactions(
  supplierId: string,
  params: { page?: number; pageSize?: number } = {},
) {
  const qs = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  return api.get<Paginated<SupplierTransaction>>(
    `/suppliers/${supplierId}/transactions?${qs.toString()}`,
  );
}

/** FR-SUP-04 — append-only price history, role-locked behind `supplier.price.read` (D-20). */
export function getSupplierPriceHistory(
  supplierId: string,
  params: { itemId?: string; page?: number; pageSize?: number } = {},
) {
  const qs = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  if (params.itemId) qs.set('itemId', params.itemId);
  return api.get<Paginated<PriceHistoryEntry>>(
    `/suppliers/${supplierId}/price-history?${qs.toString()}`,
  );
}

// ── §4.11 purchase requests (F-PUR-01) ──────────────────────────────────────

export function listPurchaseRequests(
  params: { locationId?: string; status?: string; page?: number; pageSize?: number } = {},
) {
  const qs = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  if (params.locationId) qs.set('locationId', params.locationId);
  if (params.status) qs.set('status', params.status);
  return api.get<Paginated<PurchaseRequestListRow>>(`/purchasing/requests?${qs.toString()}`);
}

export function getPurchaseRequest(id: string) {
  return api.get<PurchaseRequestDetail>(`/purchasing/requests/${id}`);
}

/** Edit a draft or rejected PR (owner, 2026-08-21: "PR should be editable"). */
export function updatePurchaseRequest(
  id: string,
  body: {
    locationId?: string;
    neededBy?: string;
    notes?: string;
    lines?: {
      itemId: string;
      qty: string;
      unitId: string;
      estPrice?: string;
      suggestedSupplierId?: string;
    }[];
  },
) {
  return api.patch<PurchaseRequestDetail>(`/purchasing/requests/${id}`, body);
}

/** The PR's audit trail: who created, edited, approved or rejected it, when. */
export function getPurchaseRequestHistory(id: string) {
  return api.get<PurchaseRequestHistoryEntry[]>(`/purchasing/requests/${id}/history`);
}

/** Convert an outlet's replenishment request into a draft PR. */
export function createPurchaseRequestFromReplenishment(body: {
  replenishmentId: string;
  locationId: string;
  neededBy?: string;
  notes?: string;
}) {
  return api.post<PurchaseRequestDetail>('/purchasing/requests/from-replenishment', body);
}

export function createPurchaseRequest(body: {
  locationId: string;
  neededBy?: string;
  lines: {
    itemId: string;
    qty: string;
    unitId: string;
    estPrice?: string;
    suggestedSupplierId?: string;
  }[];
}) {
  return api.post<PurchaseRequestDetail>('/purchasing/requests', body);
}

export function submitPurchaseRequest(id: string) {
  return api.post<PurchaseRequestDetail>(`/purchasing/requests/${id}/submit`);
}

export function approvePurchaseRequest(id: string, body: { note?: string } = {}) {
  return api.post<PurchaseRequestDetail>(`/purchasing/requests/${id}/approve`, body);
}

export function rejectPurchaseRequest(id: string, body: { reason: string }) {
  return api.post<PurchaseRequestDetail>(`/purchasing/requests/${id}/reject`, body);
}

// ── §4.11 purchase orders + receiving (FR-PO-01..04) ────────────────────────

export function listPurchaseOrders(
  params: {
    supplierId?: string;
    status?: string;
    from?: string;
    to?: string;
    page?: number;
    pageSize?: number;
  } = {},
) {
  const qs = new URLSearchParams({
    page: String(params.page ?? 1),
    pageSize: String(params.pageSize ?? 25),
  });
  if (params.supplierId) qs.set('supplierId', params.supplierId);
  if (params.status) qs.set('status', params.status);
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  return api.get<Paginated<PurchaseOrderListRow>>(`/purchasing/orders?${qs.toString()}`);
}

export function getPurchaseOrder(id: string) {
  return api.get<PurchaseOrderDetail>(`/purchasing/orders/${id}`);
}

export function createPurchaseOrder(body: {
  supplierId: string;
  locationId: string;
  prId?: string;
  orderDate: string;
  expectedDate?: string;
  lines: { itemId: string; qtyOrdered: string; unitId: string; unitPrice: string }[];
  notes?: string;
}) {
  return api.post<PurchaseOrderDetail>('/purchasing/orders', body);
}

export function submitPurchaseOrder(id: string) {
  return api.post<PurchaseOrderDetail>(`/purchasing/orders/${id}/submit`);
}

export function approvePurchaseOrder(id: string, body: { note?: string } = {}) {
  return api.post<PurchaseOrderDetail>(`/purchasing/orders/${id}/approve`, body);
}

export function rejectPurchaseOrder(id: string, body: { reason: string }) {
  return api.post<PurchaseOrderDetail>(`/purchasing/orders/${id}/reject`, body);
}

export function issuePurchaseOrder(id: string) {
  return api.post<PurchaseOrderDetail>(`/purchasing/orders/${id}/issue`);
}

export function receivePurchaseOrder(
  id: string,
  body: {
    lines: {
      poLineId: string;
      qtyReceived: string;
      storageAreaId: string;
      conditionNotes?: string;
    }[];
    photoAttachmentIds: string[];
    notes?: string;
  },
) {
  return api.post<PurchaseOrderDetail>(`/purchasing/orders/${id}/receipts`, body);
}

export function cancelPurchaseOrder(id: string, body: { reason: string }) {
  return api.post<PurchaseOrderDetail>(`/purchasing/orders/${id}/cancel`, body);
}

export function closePurchaseOrder(id: string) {
  return api.post<PurchaseOrderDetail>(`/purchasing/orders/${id}/close`);
}
