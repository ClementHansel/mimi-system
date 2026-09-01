/**
 * Typed REST calls for F04 `outlet` (CONTRACTS.md §4.7–§4.12). Thin wrappers
 * over `@/lib/api`'s `api` client — every path/shape here is transcribed
 * verbatim from CONTRACTS, nothing invented.
 *
 * NOTE on offline-first (see report to senior-fe/architect): `lib/api.ts`'s
 * module doc lists F04 as an offline-first surface that should enqueue
 * mutations through `@/lib/local`'s `LocalRuntime` instead of calling this
 * client directly (the pattern F02/F13 use). `LocalRuntime`
 * (`src/lib/local/api/local-runtime.ts`) only exposes named commit helpers
 * for POS and driver entities though — there is no `SyncEntity`/op mapping
 * defined yet for `replenishment_requests`, `stock_opname`, `waste_records`,
 * `returns`, `petty_cash` or the receiving flow's `goods_receipts`, and every
 * CONTRACTS §4.7–4.12 endpoint below is a plain online REST call, not a
 * `commitFact`-shaped envelope. Inventing that mapping is a sync-protocol
 * decision, not a screen decision, so this module calls the online client
 * directly (works correctly against the live backend today) and the gap is
 * flagged for W2-E/architect follow-up rather than silently worked around.
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';
import type {
  Balance,
  StorageArea,
  Item,
  Opname,
  OpnameDetail,
  Replenishment,
  SuratJalan,
  PettyCash,
  SupplierDirectoryEntry,
  WasteRecord,
  ReturnDoc,
} from './types';

// ── inventory (§4.7) ─────────────────────────────────────────────────────────

/**
 * The server's hard cap on `pageSize` for every paginated list (its DTO
 * rejects anything larger with a 400). Named rather than inlined because the
 * bug this constant exists to prevent was a magic `500`.
 */
const MAX_PAGE_SIZE = 200;

/** Refuses to loop forever if `total` and the returned rows ever disagree. */
const MAX_BALANCE_PAGES = 25;

/**
 * EVERY balance for a location, fetched across as many pages as it takes.
 *
 * This asked for `pageSize=500` — over the server's cap of 200 — so
 * `GET /api/inventory/balances` answered 400 EVERY TIME and the outlet's Stok
 * screen showed "Gagal memuat data" to every role that opened it. Found
 * 2026-09-01 by walking each role's own screens; it had been failing for
 * everyone, not just the cook it was found on.
 *
 * Paging rather than simply lowering the number to 200, because `StockPanel`
 * and its export are built on "every balance is already held client-side" —
 * that is why the Ekspor button can offer "everything" without a request. A
 * flat 200 would have made this screen work and silently truncated the export
 * the day an outlet carried its 201st item, which is a worse bug than the one
 * being fixed: it would look correct.
 */
export async function getBalances(params: {
  locationId: string;
  storageAreaId?: string;
  q?: string;
}): Promise<Paginated<Balance>> {
  const rows: Balance[] = [];
  let page = 1;
  let total = 0;

  for (; page <= MAX_BALANCE_PAGES; page++) {
    const qs = new URLSearchParams({ locationId: params.locationId, page: String(page) });
    if (params.storageAreaId) qs.set('storageAreaId', params.storageAreaId);
    if (params.q) qs.set('q', params.q);
    qs.set('pageSize', String(MAX_PAGE_SIZE));

    const res = await api.get<Paginated<Balance>>(`/inventory/balances?${qs.toString()}`);
    rows.push(...res.rows);
    total = res.total;

    // Stop on a short page as well as on the count: a page that comes back
    // smaller than the limit is the last one, and trusting only `total` would
    // spin if the two ever disagreed.
    if (res.rows.length < MAX_PAGE_SIZE || rows.length >= total) break;
  }

  return { rows, total, page: 1, pageSize: rows.length };
}

export function getStorageAreas(locationId: string) {
  return api.get<StorageArea[]>(`/locations/${locationId}/storage-areas?active=true`);
}

export function getItems(q?: string) {
  const qs = new URLSearchParams({ page: '1', pageSize: '200' });
  if (q) qs.set('q', q);
  return api.get<Paginated<Item>>(`/items?${qs.toString()}`);
}

// ── stock opname (§4.8) ──────────────────────────────────────────────────────

export function listOpname(locationId: string, status?: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  if (status) qs.set('status', status);
  return api.get<Paginated<Opname>>(`/stock-opname?${qs.toString()}`);
}

export function getOpname(id: string) {
  return api.get<OpnameDetail>(`/stock-opname/${id}`);
}

export function createOpname(locationId: string, storageAreaId?: string) {
  return api.post<Opname>('/stock-opname', { locationId, storageAreaId });
}

export function putOpnameLines(
  opnameId: string,
  lines: { storageAreaId: string; itemId: string; countedQty: string; varianceReason?: string }[],
) {
  return api.put(`/stock-opname/${opnameId}/lines`, { lines });
}

export function submitOpname(id: string) {
  return api.post<Opname>(`/stock-opname/${id}/submit`);
}

export function cancelOpname(id: string) {
  return api.delete<{ id: string; status: string }>(`/stock-opname/${id}`);
}

// ── replenishment (§4.9) ─────────────────────────────────────────────────────

export function listReplenishment(locationId: string, status?: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  if (status) qs.set('status', status);
  return api.get<Paginated<Replenishment>>(`/replenishment?${qs.toString()}`);
}

export function getReplenishment(id: string) {
  return api.get<Replenishment>(`/replenishment/${id}`);
}

export function createReplenishment(body: {
  locationId: string;
  neededBy?: string;
  lines: { itemId: string; qtyRequested: string; unitId: string }[];
}) {
  return api.post<Replenishment>('/replenishment', body);
}

export function submitReplenishment(id: string) {
  return api.post<Replenishment>(`/replenishment/${id}/submit`);
}

export function deleteReplenishment(id: string) {
  return api.delete<{ id: string; deleted: true }>(`/replenishment/${id}`);
}

// ── delivery / receiving (§4.10) ─────────────────────────────────────────────
//
// NOTE: there is no `receiveDrop` REST wrapper here on purpose. Receiving
// (FR-LOG-14/15/16) commits through `LocalRuntime.commitDropReceived`
// instead (`ReceivingPanel.tsx` + `lib/outlet-runtime.ts`) — it's one of the
// two outlet flows (alongside POS) the offline runtime already has a named
// helper for, so it goes through the outbox, not this online client. The
// drop LIST below stays a plain online read (no local SJ cache exists yet).

export function listIncomingSuratJalan(locationId: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  return api.get<Paginated<SuratJalan>>(`/delivery/surat-jalan?${qs.toString()}`);
}

// ── petty cash (§4.11) ───────────────────────────────────────────────────────

export function listPettyCash(locationId: string, status?: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  if (status) qs.set('status', status);
  return api.get<Paginated<PettyCash>>(`/purchasing/petty-cash?${qs.toString()}`);
}

export function createPettyCash(body: {
  locationId: string;
  purchaseDate: string;
  storeName: string;
  lines: {
    description: string;
    itemId?: string;
    storageAreaId?: string;
    qty?: string;
    amount: string;
    expenseCategory: string;
  }[];
  paymentProofAttachmentId: string;
  goodsPhotoAttachmentId: string;
}) {
  return api.post<PettyCash>('/purchasing/petty-cash', body);
}

export function getSupplierDirectory(q?: string) {
  const qs = new URLSearchParams({ page: '1', pageSize: '50' });
  if (q) qs.set('q', q);
  return api.get<Paginated<SupplierDirectoryEntry>>(`/suppliers/directory?${qs.toString()}`);
}

// ── waste / return (§4.12) ───────────────────────────────────────────────────

export function listWaste(locationId: string, status?: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  if (status) qs.set('status', status);
  return api.get<Paginated<WasteRecord>>(`/waste?${qs.toString()}`);
}

export function createWaste(body: {
  locationId: string;
  items: {
    storageAreaId: string;
    itemId: string;
    qty: string;
    reason: string;
    reasonDetail?: string;
  }[];
  photoAttachmentIds: string[];
}) {
  return api.post('/waste', body);
}

export function listReturns(locationId: string, direction?: string) {
  const qs = new URLSearchParams({ locationId, page: '1' });
  if (direction) qs.set('direction', direction);
  return api.get<Paginated<ReturnDoc>>(`/returns?${qs.toString()}`);
}

export function createReturn(body: {
  direction: string;
  fromLocationId: string;
  toLocationId?: string;
  lines: {
    itemId: string;
    storageAreaId: string;
    qty: string;
    condition: string;
    reason: string;
  }[];
  photoAttachmentIds: string[];
}) {
  return api.post<ReturnDoc>('/returns', body);
}

export function submitReturn(id: string) {
  return api.post<ReturnDoc>(`/returns/${id}/submit`);
}
