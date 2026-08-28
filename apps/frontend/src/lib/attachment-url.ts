'use client';

import { api } from '@/lib/api';

/**
 * Turning an `attachments.id` into a URL an `<img src>` can use, with a cache.
 *
 * Lives in `lib/` rather than in `components/documents/` because it has two
 * unrelated callers on opposite sides of the app: the document layer (a
 * template background, a logo on every printed sheet) and `lib/brand` (the
 * favicon and the logo the running UI shows). Putting it under the document
 * components would have made `lib/brand` import from `components/**`, which is
 * backwards — `lib` is the layer components are built ON.
 */

interface CachedUrl {
  url: string;
  /** Epoch ms after which we stop handing this out. */
  goodUntil: number;
}

/**
 * Presign results, cached per attachment id for the life of the page.
 *
 * WHY CACHE AT ALL. A Surat Jalan copy set is drops × 3 sheets, and a voucher
 * batch can be 200 cards — every one of them carries the SAME
 * `logoAttachmentId`. Without a cache that is 600 authenticated round trips to
 * `/attachments/:id/url` before a single page renders, on a tablet on mobile
 * data. With it, one.
 *
 * WHY IT EXPIRES EARLY. The presign is short-lived and the server tells us
 * when (`expiresAt`). We retire our copy 60s BEFORE that, because the gap
 * between "the URL is still valid" and "the browser has finished fetching the
 * image with it" is exactly where a logo silently fails to print. A skew of
 * one minute is cheap; a letterhead-less invoice is not.
 *
 * WHY IT IS NOT AN LRU. The set of attachment ids a print session touches is
 * two (a logo and a background), and the map is discarded on navigation.
 */
const urlCache = new Map<string, CachedUrl>();

/** In-flight presigns, so N sheets asking for one logo issue one request. */
const inFlight = new Map<string, Promise<string | null>>();

const EXPIRY_SAFETY_MS = 60_000;

/**
 * Resolve one attachment id to a URL the renderer can put in an `<img src>`.
 *
 * Returns `null` on ANY failure rather than throwing. A print path that throws
 * because a logo could not be presigned produces a blank page; one that
 * returns null produces the document without its logo, which is the outcome
 * every party in the room would choose. The failure is still visible — the
 * designer draws a placeholder box for a missing logo.
 */
export async function resolveAttachmentUrl(attachmentId: string | null): Promise<string | null> {
  if (!attachmentId) return null;

  const cached = urlCache.get(attachmentId);
  if (cached && cached.goodUntil > Date.now()) return cached.url;

  const existing = inFlight.get(attachmentId);
  if (existing) return existing;

  const request = api
    .get<{ url: string; expiresAt: string }>(`/attachments/${attachmentId}/url`)
    .then((res) => {
      const expiresAtMs = Date.parse(res.expiresAt);
      const goodUntil = Number.isFinite(expiresAtMs)
        ? expiresAtMs - EXPIRY_SAFETY_MS
        : Date.now() + 5 * 60_000;
      urlCache.set(attachmentId, { url: res.url, goodUntil });
      return res.url;
    })
    .catch(() => null)
    .finally(() => {
      inFlight.delete(attachmentId);
    });

  inFlight.set(attachmentId, request);
  return request;
}

/** Test/HMR seam — the cache is process-global, so a test that stubs `api` needs to clear it. */
export function clearAttachmentUrlCache(): void {
  urlCache.clear();
  inFlight.clear();
}
