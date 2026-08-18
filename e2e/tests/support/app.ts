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

/** Seeded usernames, by the role each one exercises. */
export const USERS = {
  superadmin: 'superadmin',
  owner: 'owner',
  kepalaGudang: 'kepalagudang1',
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
  await page.locator('input[name="username"], input[type="text"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(DEMO_PASSWORD);

  // Wait for hydration before submitting. The page disables the submit button
  // until React has attached `onSubmit`, precisely so a pre-hydration click
  // cannot fall through to the browser's native submission — which is how this
  // suite originally found the password being written into the URL. Waiting on
  // the enabled state tests that guard rather than working around it.
  const submit = page.locator('button[type="submit"]').first();
  await expect(submit).toBeEnabled({ timeout: 30_000 });
  await submit.click();

  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });

  if (page.url().includes('/set-pin')) {
    const pinInputs = page.locator('input[type="password"], input[inputmode="numeric"]');
    const count = await pinInputs.count();
    // Set + confirm; some builds render one field, some two.
    for (let i = 0; i < Math.min(count, 2); i++) await pinInputs.nth(i).fill(DEMO_PIN);
    await page.locator('button[type="submit"]').first().click();
    await page.waitForURL((url) => !url.pathname.includes('/set-pin'), { timeout: 30_000 });
  }

  // The hub and every shell route render only after the session store has
  // hydrated; without this the first assertion races an empty DOM.
  await expect(page.locator('body')).not.toBeEmpty();
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
