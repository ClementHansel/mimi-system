/**
 * Typed REST calls for F13 `driver` (CONTRACTS.md §4.10). Thin wrappers over
 * `@/lib/api`'s `api` client — same convention as `components/outlet/lib/outlet-api.ts`.
 *
 * Only the READ path and the two ops with no offline schema mapping
 * (`fail`, ad-hoc storage-area lookup for the serah-terima form) go through
 * this client. Every mutating drop/temperature action a driver actually
 * performs on the road (`depart`, `arrive`, `receive`, a mid-route temp
 * check) is queued through `driver-runtime.ts`'s `LocalRuntime` instead —
 * see that file's doc comment.
 */
import { api } from '@/lib/api';
import type { SuratJalan, StorageArea } from './types';

/** "F13 pre-departure cache" per CONTRACTS §4.10 — full SJ + drop + seal + temp-log detail for the authenticated driver's day. */
export function getMyJobs(date?: string, driverId?: string) {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  // Honoured by the server only for owner/superadmin. Sending it as any other
  // role is not an error — the server simply returns that caller's own run.
  if (driverId) params.set('driverId', driverId);
  const qs = params.toString();
  return api.get<SuratJalan[]>(`/delivery/my-jobs${qs ? `?${qs}` : ''}`);
}

/** The fleet, for the owner's driver picker. Gated on `delivery.read`. */
export function getDrivers() {
  return api.get<{ id: string; name: string; isActive: boolean }[]>(
    '/delivery/drivers?active=true',
  );
}

/** Needed by the serah-terima form to pick which area at the RECEIVING location the goods land in — the same endpoint `outlet`'s screens call, wrapped locally rather than reaching into `components/outlet/**`. */
export function getStorageAreas(locationId: string) {
  return api.get<StorageArea[]>(`/locations/${locationId}/storage-areas?active=true`);
}

/**
 * `sj_drops.failed` has no entry in `@mimi/sync-protocol`'s schema registry
 * (only `departed`/`arrived`/`received` do) — inventing that mapping is a
 * sync-protocol decision, not a screen decision (same discipline
 * `outlet-api.ts` documents for its own unmapped ops), so "outlet tutup /
 * gagal kirim" stays a plain online call. It requires connectivity; the
 * button surfaces a clear error (via the existing `table.error` toast) when
 * offline instead of silently pretending to queue.
 */
export function failDrop(dropId: string, reason: string, photoAttachmentId?: string) {
  return api.post<{ id: string; status: string }>(`/delivery/drops/${dropId}/fail`, {
    reason,
    ...(photoAttachmentId ? { photoAttachmentId } : {}),
  });
}

/**
 * "Lewati dulu" — defer this drop to the end of the route.
 *
 * Online-only for the same reason as `failDrop`: no schema-registry mapping
 * exists for it, and inventing one is a sync-protocol decision rather than a
 * screen decision. The cost of that is lower here than for `fail`, because a
 * skip is a convenience — a driver with no signal simply drives on and the
 * route order is cosmetic until they reconnect.
 *
 * A skip moves NO stock and closes nothing. The drop returns to `pending` at
 * the back of the queue and is still deliverable today.
 */
export function skipDrop(dropId: string, reason: string) {
  return api.post<{ id: string; status: string }>(`/delivery/drops/${dropId}/skip`, { reason });
}
