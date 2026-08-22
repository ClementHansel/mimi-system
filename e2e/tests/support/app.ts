import { expect, type Page } from '@playwright/test';

/**
 * Shared helpers for the e2e suite. Everything here drives the REAL UI —
 * no API shortcuts to set up state — because the point of this suite is the
 * parts unit tests cannot reach: routing, permission-gated rendering, and the
 * session/redirect behaviour that produced a blank white page in production.
 */

/** Demo credentials from `database/seed.ts`. Overridable for a non-demo box. */
export const DEMO_PASSWORD = process.env.E2E_PASSWORD ?? 'password123';
export const DEMO_PIN = process.env.E2E_PIN ?? '123456';

/**
 * Seeded usernames, by the role each one exercises.
 *
 * These follow `database/simulate-org.ts`'s scheme, which is the org the
 * business actually runs: crew usernames read `<slot>_<outlet>_<shift>`
 * (`spv_bpp01_p`, `kasir_smd03_m`), warehouse staff are `gudang1`/`gudang2`,
 * and there are exactly two drivers. Before that, this file named
 * `seed.ts`'s raw output (`kepalagudang1`) and the whole suite failed the first
 * time the org was reshaped — against a perfectly healthy box.
 */
export const USERS = {
  superadmin: 'superadmin',
  owner: 'owner',
  kepalaGudang: 'gudang1',
  driver: 'driver1',
} as const;

/**
 * Signs in and settles on whatever the app decides is this role's home.
 *
 * Handles the forced PIN setup. `seed.ts` gives a PIN only to the roles that
 * need one offline (`withPin`), so roles without one are legitimately sent to
 * `/set-pin` on first login — a real first-login step, not a bug. Completing
 * it here is a one-time write against demo data; without it, no spec for those
 * roles could reach its own surface.
 */
export async function login(page: Page, username: string): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });

  // Wait for hydration BEFORE touching the fields, not just before submitting.
  //
  // These are controlled inputs backed by `useState('')`. Text typed into the
  // server-rendered DOM before React attaches is discarded the moment it
  // hydrates and re-asserts state — the field silently empties. That produced
  // a login posting an EMPTY username and the page answering "Gagal masuk",
  // intermittently, depending on how fast the box served the JS.
  //
  // The submit button is disabled until hydrated (a real guard against
  // pre-hydration submits leaking credentials into the URL), so waiting for it
  // to enable is an honest hydration signal rather than an arbitrary sleep.
  const submit = page.locator('button[type="submit"]').first();
  await expect(submit).toBeEnabled({ timeout: 30_000 });

  const usernameField = page.locator('input[name="username"], input[type="text"]').first();
  const passwordField = page.locator('input[type="password"]').first();
  await usernameField.fill(username);
  await passwordField.fill(DEMO_PASSWORD);
  // Re-assert after filling: if a late re-render ever clears them again, fail
  // here naming the cause instead of 30s later on a navigation timeout.
  await expect(usernameField).toHaveValue(username);
  await expect(passwordField).toHaveValue(DEMO_PASSWORD);

  await submit.click();

  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

  if (page.url().includes('/set-pin')) {
    // THREE fields, in order: current password, new PIN, confirm PIN. Filling
    // the PIN into the first two (and leaving confirm empty) silently fails
    // validation and the page simply never navigates.
    const setPinSubmit = page.locator('button[type="submit"]').first();
    await expect(setPinSubmit).toBeEnabled({ timeout: 30_000 });

    const fields = page.locator('input[type="password"]');
    await expect(fields).toHaveCount(3);
    await fields.nth(0).fill(DEMO_PASSWORD);
    await fields.nth(1).fill(DEMO_PIN);
    await fields.nth(2).fill(DEMO_PIN);

    await setPinSubmit.click();
    await page.waitForURL((url) => !url.pathname.includes('/set-pin'), { timeout: 30_000 });
  }

  // The hub and every shell route render only after the session store has
  // hydrated; without this the first assertion races an empty DOM.
  await expect(page.locator('body')).not.toBeEmpty();
}

/**
 * Waits for the app to settle on `expected`.
 *
 * Non-all-access roles land on `/` first and are redirected onward by the hub
 * in an effect, so reading the path straight after `login()` races that
 * redirect and sees `/`. Waiting for the destination tests the behaviour;
 * asserting immediately tests the scheduler.
 */
export async function expectLandsOn(page: Page, expected: string): Promise<void> {
  await page.waitForURL((url) => url.pathname === expected, { timeout: 30_000 });
  expect(pathOf(page)).toBe(expected);
}

/** Path only — assertions should never depend on host or query string. */
export function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

/**
 * Every `href` rendered inside `<main>`, which on the hub is exactly one per
 * interface. Read from the DOM rather than a fixture list so the suite tracks
 * `lib/nav.ts` instead of duplicating it.
 */
export async function mainLinks(page: Page): Promise<string[]> {
  return page
    .locator('main a[href]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href')!).filter(Boolean));
}

/**
 * Fails the calling spec if the app under test is unreachable, with a message
 * that says so — rather than every spec dying on an opaque navigation
 * timeout, which is how a suite gets dismissed as "flaky" and ignored.
 */
export async function assertAppIsUp(page: Page, baseURL: string | undefined): Promise<void> {
  const res = await page.goto('/login', { waitUntil: 'domcontentloaded' }).catch(() => null);
  if (!res || !res.ok()) {
    throw new Error(
      `The app is not answering at ${baseURL ?? '(no baseURL)'} — start it, or set E2E_BASE_URL. ` +
        `This suite deliberately has no webServer; see playwright.config.ts.`,
    );
  }
}
