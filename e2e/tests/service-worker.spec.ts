import { test, expect } from '@playwright/test';
import { assertAppIsUp, login, USERS } from './support/app';

/**
 * B-6 / W6-02 — the service-worker half of the offline adversarial suite.
 *
 * ## Why this could not exist until now
 *
 * Browsers gate service workers, geolocation and PWA install behind a SECURE
 * CONTEXT. The demo box served plain HTTP on `:8080`, so `navigator
 * .serviceWorker` was literally `undefined` there: `public/sw.js` had never
 * registered, in any environment, ever. `docs/ACCEPTANCE.md` recorded the whole
 * area as `NONE`, blocked on B-14, and it stayed that way for weeks because the
 * assumed fix was a domain and a trusted certificate.
 *
 * It was not. A secure context is a property of the SCHEME, not the port or the
 * certificate's provenance — `https://<ip>:8443` with a self-signed cert is one.
 * That is now live, so this file is the first time the service worker is
 * exercised at all.
 *
 * ## Why it skips instead of failing on the HTTP origin
 *
 * Run against `http://…:8080` these APIs do not exist, and a red test would be
 * reporting the browser working correctly. The skip is deliberate and the
 * reason is asserted (`isSecureContext`), so a plain-HTTP run says "not
 * applicable" rather than quietly passing.
 */

/** True when the origin under test is one where these APIs can exist at all. */
async function isSecureContext(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => window.isSecureContext);
}

test.describe('service worker + offline shell (B-6, needs a secure context)', () => {
  test('the origin under test is a secure context, or this whole area is not applicable', async ({
    page,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    const secure = await isSecureContext(page);

    // Not an assertion that it IS secure — that depends on which origin the
    // run targets. It is a recorded fact, so a green suite on the HTTP origin
    // cannot be mistaken for evidence that the SW works.
    test.info().annotations.push({
      type: 'secure-context',
      description: `${baseURL} → isSecureContext=${secure}`,
    });
    expect(typeof secure).toBe('boolean');
  });

  test('the service worker registers and reaches "activated"', async ({ page, baseURL }) => {
    await assertAppIsUp(page, baseURL);
    test.skip(!(await isSecureContext(page)), 'insecure origin — serviceWorker is undefined here');

    await login(page, USERS.owner);

    // `AppShell` calls `registerServiceWorker(runtime)` once the local runtime
    // resolves, so registration follows login rather than the first paint.
    const state = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return 'no-registration';
      const worker = reg.active ?? reg.waiting ?? reg.installing;
      if (!worker) return 'no-worker';
      if (worker.state === 'activated') return 'activated';
      await new Promise<void>((resolve) => {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') resolve();
        });
        setTimeout(resolve, 10_000);
      });
      return worker.state;
    });

    expect(state).toBe('activated');
  });

  test('the shell still renders after a reload with the network cut — the point of precaching it', async ({
    page,
    context,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    test.skip(!(await isSecureContext(page)), 'insecure origin — serviceWorker is undefined here');

    await login(page, USERS.owner);
    await page.evaluate(() => navigator.serviceWorker.ready);
    // One warm navigation so the shell is actually in the cache; the worker
    // precaches `/` opportunistically on fetch, not at install.
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    await context.setOffline(true);
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });

      // The bar is deliberately low and specific: SOMETHING of ours rendered,
      // rather than Chromium's own ERR_INTERNET_DISCONNECTED page. Asserting on
      // particular app content would be asserting that the API answered, which
      // offline it cannot.
      const html = await page.content();
      expect(html).not.toContain('ERR_INTERNET_DISCONNECTED');
      expect(await page.locator('body').count()).toBe(1);
      expect(html.length).toBeGreaterThan(200);
    } finally {
      await context.setOffline(false);
    }
  });

  test('a mutating request is never served from cache — exactly-once depends on it', async ({
    page,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    test.skip(!(await isSecureContext(page)), 'insecure origin — serviceWorker is undefined here');

    await login(page, USERS.owner);
    await page.evaluate(() => navigator.serviceWorker.ready);

    // `sw.js` states this as an invariant: non-GET `/api/**` and everything
    // under `/sync/v1/**` must reach the network verbatim. Serving a mutation
    // from cache — or caching its response — would silently break the
    // exactly-once semantics SYNC-PROTOCOL §2.2 exists to guarantee. Asserted
    // by checking the caches directly, since a cached mutation is the artefact
    // that would prove the violation.
    const cachedMutations = await page.evaluate(async () => {
      const names = await caches.keys();
      const offenders: string[] = [];
      for (const name of names) {
        const cache = await caches.open(name);
        for (const req of await cache.keys()) {
          const url = new URL(req.url);
          if (req.method !== 'GET' || url.pathname.startsWith('/sync/v1')) {
            offenders.push(`${req.method} ${url.pathname}`);
          }
        }
      }
      return offenders;
    });

    expect(cachedMutations).toEqual([]);
  });

  test('the PWA manifest is reachable, which is what makes it installable at all', async ({
    page,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    const res = await page.request.get('/manifest.json');
    expect(res.status()).toBe(200);
    const manifest = await res.json();
    // Chromium refuses to offer installation without these three.
    expect(manifest.name ?? manifest.short_name).toBeTruthy();
    expect(manifest.start_url).toBeTruthy();
    expect(Array.isArray(manifest.icons) && manifest.icons.length > 0).toBe(true);
  });
});
