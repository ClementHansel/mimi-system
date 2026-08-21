import { test, expect } from '@playwright/test';
import { expectLandsOn, login, mainLinks, pathOf, USERS } from './support/app';

/**
 * The hub contract, per the owner's 2026-08-21 rulings: the system has SEVEN
 * interfaces, the hub shows exactly the ones you can reach, and it is for
 * EVERYONE — `employee` (`/me`) is an interface of its own, so even a Kasir has
 * more than one place to be and gets the chooser. Only an account that can
 * reach a single interface is redirected past it.
 *
 * `app/page.test.tsx` already covers the component with a mocked router. What
 * only a browser proves is that the permissions the SERVER actually issues for
 * these accounts produce the intended cards — the original complaint ("I don't
 * see that menu") was an RBAC fact, not a rendering one, so a test that mocks
 * permissions could never have caught it.
 */

/** The seven interfaces (`lib/nav.ts` `INTERFACES`). */
const INTERFACES = ['/dashboard', '/pos', '/outlet', '/warehouse', '/driver', '/me', '/docs'];

/**
 * Areas INSIDE the dashboard. The old hub listed each of these as a peer card;
 * they must now appear only in the dashboard's sidebar.
 */
const DASHBOARD_AREAS = [
  '/approvals',
  '/chat',
  '/delivery',
  '/purchasing',
  '/finance',
  '/hr',
  '/assets',
  '/admin',
  '/topology',
];

/** Interfaces every signed-in account reaches: neither is a privileged read. */
const UNIVERSAL_INTERFACES = ['/me', '/docs'];

test.describe('home hub', () => {
  for (const role of ['owner', 'superadmin'] as const) {
    test(`${role} lands on the hub with exactly the seven interfaces`, async ({ page }) => {
      await login(page, USERS[role]);

      await expectLandsOn(page, '/');

      const links = await mainLinks(page);
      for (const href of INTERFACES) {
        expect(links, `${role} is missing the ${href} card`).toContain(href);
      }
      for (const href of DASHBOARD_AREAS) {
        expect(links, `${href} is a dashboard area, not a hub card`).not.toContain(href);
      }
    });
  }

  test('a hub card navigates to its interface', async ({ page }) => {
    await login(page, USERS.owner);
    await page.locator('main a[href="/warehouse"]').first().click();
    await page.waitForURL(/\/warehouse$/);
    await expect(page.locator('body')).toContainText('Gudang Pusat');
  });

  test('kepala gudang still LANDS on the warehouse, but may return to the hub', async ({
    page,
  }) => {
    await login(page, USERS.kepalaGudang);

    // Landing is unchanged: you start in your work, not in a menu.
    await expectLandsOn(page, '/warehouse');

    // But the hub no longer bounces them: they can reach Gudang Pusat, their
    // own account, and the manual, so a chooser is meaningful.
    await page.goto('/');
    await page.waitForURL((url) => url.pathname === '/');
    expect(pathOf(page)).toBe('/');
    const links = await mainLinks(page);
    expect(links).toContain('/warehouse');
    for (const href of UNIVERSAL_INTERFACES) {
      expect(links, `every account reaches ${href}`).toContain(href);
    }
  });

  test('a Home link back to the hub exists inside an interface', async ({ page }) => {
    await login(page, USERS.owner);

    await page.goto('/dashboard');
    const home = page.locator('nav a[href="/"], aside a[href="/"]').first();
    await expect(home).toBeVisible();
    await home.click();
    await page.waitForURL((url) => url.pathname === '/');

    // And from a non-dashboard interface too — the way home must not be a
    // dashboard-only affordance.
    await page.goto('/warehouse');
    await expect(page.locator('nav a[href="/"], aside a[href="/"]').first()).toBeVisible();
  });

  test('a non-owner role gets the Home link too, now that the hub is theirs', async ({ page }) => {
    // The inverse of the old assertion, and deliberately so: with `employee` an
    // interface, a Kepala Gudang has somewhere to switch TO, so hiding the way
    // home would strand them in the warehouse.
    await login(page, USERS.kepalaGudang);
    await page.goto('/warehouse');
    await expect(page.locator('nav a[href="/"], aside a[href="/"]').first()).toBeVisible();
  });

  test("the dashboard sidebar carries the dashboard's areas, and only those", async ({ page }) => {
    // The hub is the interface switcher; the sidebar is what you navigate
    // WITHIN an interface. If the sidebar on /dashboard starts listing POS or
    // the driver screen again, the two levels have collapsed back into one.
    await login(page, USERS.owner);

    await page.goto('/dashboard');
    await expect(page.locator('nav a, aside a').first()).toBeVisible();
    const navLinks = await page
      .locator('nav a[href], aside a[href]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')!));

    for (const href of DASHBOARD_AREAS) {
      expect(navLinks, `${href} is missing from the dashboard sidebar`).toContain(href);
    }
    for (const href of ['/pos', '/outlet', '/warehouse', '/driver', '/me']) {
      expect(navLinks, `${href} is its own interface, not a dashboard entry`).not.toContain(href);
    }
  });
});
