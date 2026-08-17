/* eslint-disable no-undef -- runs in the ServiceWorkerGlobalScope, not linted by `pnpm lint` (which
   only globs `src/`); this file's globals (`self`, `caches`, `fetch`, `Response`, `URL`) are all
   standard SW-scope APIs, not missing imports. */
/**
 * Mimi Chicken OS — service worker (SYNC-PROTOCOL D-12, NFR-07 installable
 * PWA). Plain JS, no build step (served as a static file from `public/`, per
 * Next.js convention) — this file intentionally does NOT reimplement the
 * `src/lib/local` sync runtime; that logic owns IndexedDB directly from page
 * context (`getBrowserLocalRuntime()`), which is where §2.2's atomic-outbox
 * transaction has to live regardless of whether a service worker is present.
 * This worker's job is narrower and still load-bearing:
 *
 *  1. Precache the app shell + catalog/master-data assets so the PWA OPENS
 *     with zero network (the brief's "installable... and usable with no
 *     network" requirement) — the `/` shell + Next's build manifest chunks
 *     are cached opportunistically as they're fetched (see the fetch
 *     handler), because this static file cannot know next.js's per-build
 *     content hashes ahead of time; `/_next/static/**` responses are
 *     immutable and cache-first from the first successful fetch onward.
 *  2. Serve navigations from cache when the network is down, so reloading a
 *     route (or opening the installed app cold) while offline still renders
 *     the shell instead of the browser's own error page.
 *  3. `sync` event: wake any open client(s) to run `LocalRuntime.syncNow()`
 *     immediately on reconnect, per §4.3 ("push resumes automatically on
 *     connect and on service-worker sync events"). LIMITATION (flagged in
 *     the package report): true background execution while the app has NO
 *     open tab would require bundling the IndexedDB-owning sync engine
 *     itself into this worker, which needs a build step this static file
 *     doesn't have — out of scope here; the outbox still drains the moment
 *     the app is next opened or brought to the foreground regardless.
 *
 * Mutating requests (`/api/**` non-GET, `/sync/v1/**`) are NEVER intercepted
 * — they must reach the network (or fail loudly to the page's own outbox
 * logic) verbatim. Caching a mutation response, or serving one from cache,
 * would silently violate the exactly-once semantics §2.2 exists to guarantee.
 */

const SW_VERSION = 'v1';
const SHELL_CACHE = `mimi-shell-${SW_VERSION}`;
const STATIC_CACHE = `mimi-static-${SW_VERSION}`;
const API_CACHE = `mimi-api-${SW_VERSION}`;
const ALL_CACHES = [SHELL_CACHE, STATIC_CACHE, API_CACHE];

// Known at write time — everything else (hashed Next.js chunks, per-outlet
// catalog reads) is cached opportunistically on first fetch instead.
const PRECACHE_URLS = ['/', '/manifest.json'];

// GET-only, cacheable master/catalog data (SYNC-PROTOCOL class M — read-only
// offline, safe to serve stale-while-revalidate). Anything else under /api is
// left to the network / the page's own fetch logic.
const CACHEABLE_API_PREFIXES = [
  '/api/items',
  '/api/products',
  '/api/locations',
  '/api/settings',
  '/api/units',
  '/api/item-categories',
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => cache.addAll(PRECACHE_URLS).catch(() => undefined)),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => Promise.all(keys.filter((k) => !ALL_CACHES.includes(k)).map((k) => caches.delete(k)))),
      self.clients.claim(),
    ]),
  );
});

function isNextStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/');
}

function isCacheableApiGet(request, url) {
  return request.method === 'GET' && CACHEABLE_API_PREFIXES.some((p) => url.pathname.startsWith(p));
}

/** Content-hashed and immutable — safe to serve cache-first forever once fetched. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

/** Serve the cache immediately if present, refresh it in the background — the read path stays fast AND eventually consistent. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => undefined);
  return cached ?? (await network) ?? new Response(JSON.stringify({ offline: true }), { status: 503, headers: { 'Content-Type': 'application/json' } });
}

/** Network-first for navigations; falls back to the cached shell so an offline reload still renders the app instead of the browser's own error page. */
async function navigationFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      cache.put('/', response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(SHELL_CACHE);
    const shell = await cache.match('/');
    if (shell) return shell;
    return new Response(
      '<!doctype html><html lang="id"><body style="font-family:sans-serif;padding:2rem"><h1>Offline</h1><p>Aplikasi belum pernah dimuat saat online di perangkat ini.</p></body></html>',
      { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // Never intercept sync transport or any non-GET /api call — those belong
  // exclusively to the page's own outbox/idempotency logic (see file header).
  if (url.pathname.startsWith('/sync/v1/')) return;
  if (url.pathname.startsWith('/api/') && request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(navigationFallback(request));
    return;
  }

  if (isNextStaticAsset(url)) {
    event.respondWith(cacheFirst(request, STATIC_CACHE));
    return;
  }

  if (isCacheableApiGet(request, url)) {
    event.respondWith(staleWhileRevalidate(request, API_CACHE));
    return;
  }

  if (PRECACHE_URLS.includes(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});

self.addEventListener('sync', (event) => {
  if (event.tag !== 'mimi-outbox-drain') return;
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const client of clients) client.postMessage({ type: 'MIMI_SYNC_NOW' });
    }),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'MIMI_SKIP_WAITING') self.skipWaiting();
});
