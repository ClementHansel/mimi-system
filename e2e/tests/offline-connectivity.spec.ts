import { test, expect } from '@playwright/test';
import { assertAppIsUp, login, USERS } from './support/app';

/**
 * W6-02 — the offline/sync adversarial suite, the real-browser slice.
 *
 * `docs/ACCEPTANCE.md` F4 records this whole area as `NONE` and flags it
 * "partly blocked by B-14" (service workers do not register on the HTTP-only
 * demo box). Most of W6-02's brief (kill network mid-sale, duplicate submit,
 * clock skew, 24h backlog, two tablets diverging, node up/down) is proven
 * deterministically against `FakeCloud`/`FakeRelayNode` in
 * `apps/frontend/src/lib/local/**` instead — a browser adds nothing to those,
 * only nondeterminism.
 *
 * What a browser DOES add, and what B-14 does NOT block: does the actual UI
 * (`OfflineBanner`, `SyncStatusPill`, the "Coba Sinkron" retry action) react
 * correctly, in real time, when the network genuinely disappears mid-session
 * — the visible half of "kill network mid-sale" a cashier actually sees.
 * None of this touches `navigator.serviceWorker` or geolocation; it is plain
 * `page.route` request interception plus `LocalRuntime`'s already-real
 * `idb`-backed IndexedDB (which works fine over HTTP — only the SW and geo
 * APIs are refused on an insecure origin, per B-14). Full offline POS-sale
 * flows (catalog load, shift-open, payment) are NOT exercised here — wiring
 * those through Playwright needs a seeded catalog/shift for whichever role
 * the suite runs as, which is `e2e/tests/support/app.ts`'s territory, not
 * this file's per the W6-02 brief's path restriction. That gap is called out
 * in the W6-02 report rather than guessed at.
 *
 * Executed against the live demo box 2026-08-19. First run failed both tests:
 * the suite asserted on the header immediately after `login()`, but `owner`
 * now lands on the chromeless hub, which has no header to assert on — see the
 * navigation note in the first test.
 *   E2E_BASE_URL=<url> npx playwright test e2e/tests/offline-connectivity.spec.ts
 */

test.describe('offline connectivity UI reacts to a real network kill (W6-02)', () => {
  test('cutting every /sync/v1 request flips the header pill to Offline and surfaces the degraded banner, in real time', async ({
    page,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    await login(page, USERS.owner);

    // `owner` lands on `/`, which is a CHROMELESS route (`AppShell`'s
    // `CHROMELESS_EXACT_ROUTES`) — the hub is a launcher and mounts neither
    // `Header` nor `OfflineBanner`, so the connectivity UI does not exist
    // there at all. Navigate to a full-chrome route before asserting on it.
    // (POS would also work: it supplies its own banner + pill from
    // `app/pos/layout.tsx`. `/dashboard` is used because the header's
    // always-mounted `SyncRetryButton` is what forces the re-probe below.)
    await page.goto('/dashboard');

    // Kill the network the same way it dies for real: every request to the
    // sync origin fails, nothing else about the page changes. This is
    // deliberately NOT `context.setOffline(true)` (which would also break the
    // login/navigation requests this test still needs) — it targets exactly
    // the sync surface, the same "the sale itself is local; only the PUSH is
    // network-dependent" boundary `PaymentPanel`/`SyncEngine` are built on.
    await page.route('**/sync/v1/**', (route) => route.abort('internetdisconnected'));

    // `SyncStatusPill` is always in the header (`Header.tsx`); force the
    // immediate re-probe rather than waiting out `UPSTREAM_PROBE_INTERVAL_MS`
    // — same "Coba Sinkron" affordance a cashier would actually reach for the
    // moment they notice the pill hasn't updated.
    // NB `Header` renders the pill and this button `hidden sm:inline-flex`,
    // so this suite is meaningful only on a >=640px project (`desktop`).
    // Scoped to the header: once the tier degrades, `OfflineBanner` mounts a
    // SECOND "Coba Sinkron" (that is the point of it), so an unscoped locator
    // is a strict-mode violation from the first assertion onwards.
    const retryButton = page.getByRole('banner').getByRole('button', { name: 'Coba Sinkron' });
    await expect(retryButton).toBeVisible({ timeout: 15_000 });
    await retryButton.click();

    await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The degraded-tier banner (`OfflineBanner`, `role="status"`) must also
    // appear — the pill alone is easy to miss; the banner is the loud version
    // for exactly this moment.
    const banner = page.getByRole('status').filter({ hasText: 'Offline' });
    await expect(banner).toBeVisible({ timeout: 15_000 });

    // The page must still be usable — a network kill must never blank the
    // app (the same class of regression `session-recovery.spec.ts` guards
    // against for a poisoned session).
    await expect(page.locator('body')).not.toBeEmpty();
  });

  test('network recovery: unblocking /sync/v1 and retrying returns the pill to Online without a page reload', async ({
    page,
    baseURL,
  }) => {
    await assertAppIsUp(page, baseURL);
    await login(page, USERS.owner);
    await page.goto('/dashboard'); // see the note in the first test — `/` has no header

    let blocked = true;
    await page.route('**/sync/v1/**', (route) => {
      if (blocked) return route.abort('internetdisconnected');
      return route.continue();
    });

    const retryButton = page.getByRole('banner').getByRole('button', { name: 'Coba Sinkron' });
    await expect(retryButton).toBeVisible({ timeout: 15_000 });
    await retryButton.click();
    await expect(page.getByText('Offline', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });

    // The network "comes back" — nothing about the page itself is torn down
    // or reloaded, exactly like `SyncEngine.recheckConnectivity()`'s own
    // no-restart guarantee (`sync-engine.connectivity.test.ts`).
    blocked = false;
    await retryButton.click();

    await expect(page.getByText('Online', { exact: true }).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
