/**
 * Typed REST calls for the in-app notification inbox (W5-08).
 *
 * The backend has had `GET /notifications`, `POST /notifications/:id/read` and
 * `POST /notifications/read-all` all along — nothing in the frontend had ever
 * called them, so the header bell was decorative and every notification the
 * system produced was written to a table nobody could read.
 */
import { api } from '@/lib/api';
import type { Paginated } from '@/lib/shared-types';

/** Mirrors the backend's `InAppNotificationRow` (kernel/notification). */
export interface AppNotification {
  id: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  /** Free-form per-type context. `refType`/`refId` are used, when present, to
   * link a notification to the document it is about. */
  payload: Record<string, unknown>;
  locationId: string | null;
  readAt: string | null;
  createdAt: string;
}

export function listNotifications(opts: { unreadOnly?: boolean } = {}) {
  const qs = opts.unreadOnly ? '?unreadOnly=true' : '';
  return api.get<Paginated<AppNotification>>(`/notifications${qs}`);
}

export function markNotificationRead(id: string) {
  return api.post<{ ok: true }>(`/notifications/${id}/read`);
}

export function markAllNotificationsRead() {
  return api.post<{ ok: true; updated: number }>(`/notifications/read-all`);
}
