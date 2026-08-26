'use client';

/**
 * Offline-durable cache for menu product photos (FR-POS-01).
 *
 * WHY THIS EXISTS AT ALL. The POS catalog is precached and served for as long as
 * the till stays offline, so a product photo has to survive the same outage the
 * rest of the catalog does. Three things this could NOT have been:
 *
 *  - a presigned MinIO url (`Product.photoUrl`): expires in 10 minutes, i.e.
 *    precisely when the outlet loses connectivity and reloads from cache. This
 *    is why `PosCatalogService` sent `photoUrl: null` for years.
 *  - base64 in `localStorage` alongside the catalog json: a 100-product menu is
 *    megabytes, against a ~5MB origin quota shared with the catalog itself and
 *    the shift state. Filling it would break the SALE path to render a picture.
 *  - the outbound IndexedDB attachment store (`lib/local/attachments`): that
 *    holds evidence the device OWNS and must upload. A menu photo is inbound,
 *    read-only, and disposable — mixing them would put droppable cache entries
 *    in the store whose whole job is never losing a wajib-foto capture.
 *
 * So: the Cache API, which is the browser mechanism actually designed for
 * "keep these HTTP responses for offline". Entries are keyed by the stable
 * `Product.photoPath` url, survive reloads, are evictable by the browser under
 * pressure (correct — a missing photo degrades to a placeholder tile, it never
 * blocks a sale), and need no quota bookkeeping here.
 *
 * NOTE ON `caches` AVAILABILITY: it is a secure-context API, so it is absent on
 * a plain-http origin that is not localhost. Every function here degrades to
 * "fetch each time, cache nothing" in that case rather than throwing — a
 * deployment served over http would show photos while online and placeholders
 * while offline, which is a strictly better failure than a crashed grid.
 */
import { API_BASE_URL } from '@/lib/api';
import { getAccessToken } from '@/stores/session-store';

/**
 * Bumping the version is how a breaking change to the thumbnail format is
 * rolled out: the old cache is simply abandoned and swept by
 * `dropStaleProductPhotoCaches()` on next load, rather than every device
 * serving mixed formats forever.
 */
const CACHE_NAME = 'mimi-pos-product-photos-v1';

/** In-memory map so one photo is fetched and object-url'd once per page life, not once per re-render. */
const objectUrlByPath = new Map<string, string>();
const inFlight = new Map<string, Promise<string | null>>();

function cachesAvailable(): boolean {
  return typeof window !== 'undefined' && 'caches' in window;
}

function absoluteUrl(photoPath: string): string {
  const base = API_BASE_URL.endsWith('/') ? API_BASE_URL.slice(0, -1) : API_BASE_URL;
  const path = photoPath.startsWith('/') ? photoPath : `/${photoPath}`;
  return `${base}${path}`;
}

/**
 * The photo bytes, from cache when possible and from the network otherwise.
 *
 * The network response is stored WITHOUT its `Authorization` request header
 * mattering: `cache.put` is keyed on the url alone, which is what lets a later
 * offline read succeed with no token handling at all. The bytes are already
 * behind a bearer token to obtain in the first place, and they are a picture of
 * fried chicken on a menu — this is not sensitive data being widened.
 */
async function fetchPhotoBlob(photoPath: string): Promise<Blob | null> {
  const url = absoluteUrl(photoPath);
  const cache = cachesAvailable() ? await caches.open(CACHE_NAME).catch(() => null) : null;

  if (cache) {
    const hit = await cache.match(url).catch(() => undefined);
    if (hit?.ok) return hit.blob();
  }

  const token = getAccessToken();
  try {
    const res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    // A 404 means the product genuinely has no photo — cache nothing and let the
    // caller render its placeholder. Anything else (401 after a token expiry,
    // 5xx, offline) is also just "no photo right now".
    if (!res.ok) return null;
    if (cache) await cache.put(url, res.clone()).catch(() => {});
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * A `blob:` url for a product photo, or `null` when there is none to be had.
 *
 * Object urls are kept for the lifetime of the page deliberately: the grid
 * mounts and unmounts tiles constantly as the cashier flicks between
 * categories, and revoking per unmount would re-decode the same image on every
 * flick. They are released together by `releaseProductPhotoUrls()` when the POS
 * surface itself goes away.
 */
export async function getProductPhotoUrl(photoPath: string): Promise<string | null> {
  const existing = objectUrlByPath.get(photoPath);
  if (existing) return existing;

  // Collapse concurrent requests for the same photo — an 80-tile grid mounting
  // at once would otherwise fire 80 fetches for the same few images.
  const pending = inFlight.get(photoPath);
  if (pending) return pending;

  const promise = (async () => {
    const blob = await fetchPhotoBlob(photoPath);
    if (!blob || blob.size === 0) return null;
    const objectUrl = URL.createObjectURL(blob);
    objectUrlByPath.set(photoPath, objectUrl);
    return objectUrl;
  })().finally(() => {
    inFlight.delete(photoPath);
  });

  inFlight.set(photoPath, promise);
  return promise;
}

/**
 * Warms the cache for a whole catalog WHILE THE DEVICE IS STILL ONLINE.
 *
 * This is the function that actually makes photos work offline — lazy per-tile
 * loading would only ever cache what a cashier happened to look at before the
 * link dropped. Called right after a successful catalog fetch.
 *
 * Sequential, not `Promise.all`: this runs in the background behind a till that
 * is about to be used, and firing a hundred parallel image requests would
 * compete with the sale path for the same thin connection. Failures are ignored
 * individually — a photo that does not warm just renders a placeholder later.
 */
export async function prefetchProductPhotos(photoPaths: readonly (string | null)[]): Promise<void> {
  if (!cachesAvailable()) return;
  const unique = [...new Set(photoPaths.filter((p): p is string => Boolean(p)))];
  for (const path of unique) {
    await fetchPhotoBlob(path).catch(() => null);
  }
}

/** Releases every object url this module handed out. Call when the POS surface unmounts. */
export function releaseProductPhotoUrls(): void {
  for (const url of objectUrlByPath.values()) URL.revokeObjectURL(url);
  objectUrlByPath.clear();
}

/** Deletes caches from earlier `CACHE_NAME` versions so a format change does not leak storage forever. */
export async function dropStaleProductPhotoCaches(): Promise<void> {
  if (!cachesAvailable()) return;
  try {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((n) => n.startsWith('mimi-pos-product-photos-') && n !== CACHE_NAME)
        .map((n) => caches.delete(n)),
    );
  } catch {
    // Storage inspection is a housekeeping nicety; never let it break the till.
  }
}
