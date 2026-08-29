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
 * ## The two origins, and what each one can prove
 *
 * MEASURED 2026-08-23, and the results are not what the blocker predicted:
 *
 * | Origin                        | isSecureContext | SW registration  |
 * | ----------------------------- | --------------- | ---------------- |
 * | `http://127.0.0.1:8080`       | **true**        | **activated**    |
 * | `https://<public-ip>:8443`    | **true**        | `untrusted-cert` |
 * | `http://<public-ip>:8080`     | false           | unsupported      |
 *
 * `127.0.0.1` is a secure context even over plain HTTP — browsers exempt
 * loopback — so running this suite ON the box proves the worker, the offline
 * shell and the no-cached-mutations invariant genuinely work. They do. That is
 * the first time any of it has been exercised anywhere.
 *
 * The self-signed `:8443` origin is ALSO a secure context (a scheme property,
 * not a certificate-trust one) and unblocks geolocation, camera and PWA
 * install — but NOT service workers: Chromium refuses to fetch a worker script
 * over an untrusted certificate, and `ignoreHTTPSErrors` does not extend to
 * that fetch.
 *
 * So the code is proven and the remaining gap is purely certificate trust for
 * REMOTE users, which is the `aire-nginx` / `:80`-`:443` decision. The
 * registration test asserts the outcome is one of those two known values
 * rather than skipping quietly, so the day a trusted cert lands it fails and
 * says so.
 */

/** True when the origin under test is one where these APIs can exist at all. */
async function isSecureContext(page: import('@playwright/test').Page): Promise<boolean> {
  return page.evaluate(() => window.isSecureContext);
}

/**
 * Attempts registration once and reports what actually happened.
 *
 * Returns `'unsupported'` on a plain-HTTP origin, `'untrusted-cert'` when
 * Chromium refuses to FETCH the worker script because the certificate is not
 * trusted, or the worker's own state. See the note on `untrusted-cert` in the
 * describe block below — it is the current state of the demo box and it is a
 * finding, not a flake.
 */
async function registrationOutcome(page: import('@playwright/test').Page): Promise<string> {
  return page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    try {
      const reg = await navigator.serviceWorker.register('/sw.js');
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
    } catch (err) {
      const message = String(err);
      if (/SSL certificate|SecurityError/i.test(message)) return 'untrusted-cert';
      return `threw: ${message.slice(0, 120)}`;
    }
  });
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

  test('the service worker registers — or says exactly why it cannot', async ({
    page,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    test.skip(!(await isSecureContext(page)), 'insecure origin — serviceWorker is undefined here');

    await login(page, USERS.owner);
    const outcome = await registrationOutcome(page);
    test.info().annotations.push({ type: 'sw-registration', description: outcome });

    // MEASURED on the demo box 2026-08-29 against
    // `https://150-109-15-108.sslip.io`: **`activated`**.
    //
    // This closes B-14, which `docs/ACCEPTANCE.md` had carried for weeks as
    // "service workers cannot register over HTTP" and treated as blocked on a
    // domain purchase. It was not: sslip.io resolves a wildcard hostname to the
    // embedded IP, so a normal trusted certificate could be issued for it, and
    // the offline shell now works for REMOTE users rather than only on
    // loopback.
    //
    // The earlier reading was `untrusted-cert` on the self-signed `:8443`
    // origin, and the distinction is worth keeping: `isSecureContext` is TRUE
    // there and `navigator.serviceWorker` exists, but registration throws
    // `SecurityError` because Chromium will not FETCH a worker script over an
    // untrusted certificate — and Playwright's `ignoreHTTPSErrors` does not
    // extend to that fetch, it only lets the page load. So self-signed unblocks
    // geolocation, camera and PWA install, but never the offline shell.
    //
    // Now asserted as EXACTLY 'activated' rather than "one of two known
    // values". Accepting `untrusted-cert` made sense while it was the live
    // state; leaving it in now would let a certificate regression pass as
    // green, which is the whole thing this test exists to catch.
    expect(
      outcome,
      'the trusted-cert origin must register the worker — anything else is a regression in TLS, not a limitation',
    ).toBe('activated');
  });

  test('the shell still renders after a reload with the network cut — the point of precaching it', async ({
    page,
    context,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    test.skip(!(await isSecureContext(page)), 'insecure origin — serviceWorker is undefined here');

    await login(page, USERS.owner);
    const outcome = await registrationOutcome(page);
    test.skip(
      outcome !== 'activated',
      `service worker did not activate (${outcome}) — nothing to exercise`,
    );

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
    const outcome = await registrationOutcome(page);
    test.skip(
      outcome !== 'activated',
      `service worker did not activate (${outcome}) — no caches to inspect`,
    );

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
