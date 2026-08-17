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
export function getMyJobs(date?: string) {
  const qs = date ? `?${new URLSearchParams({ date }).toString()}` : '';
  return api.get<SuratJalan[]>(`/delivery/my-jobs${qs}`);
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
export function failDrop(dropId: string, reason: string) {
  return api.post<{ id: string; status: string }>(`/delivery/drops/${dropId}/fail`, { reason });
}
