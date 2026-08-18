import { test, expect } from '@playwright/test';
import { expectLandsOn, login, mainLinks, pathOf, USERS } from './support/app';

/**
 * The hub contract, per the owner's 2026-08-18 ruling: owner and superadmin
 * see EVERY interface; every other account is redirected past the hub to its
 * own surface.
 *
 * `app/page.test.tsx` already covers the component with a mocked router. What
 * only a browser proves is that the permissions the SERVER actually issues for
 * these accounts produce the intended cards — the original complaint ("I don't
 * see that menu") was an RBAC fact, not a rendering one, so a test that mocks
 * permissions could never have caught it.
 */

/** Surfaces the all-access roles must be able to reach from the hub. */
const EXPECTED_INTERFACES = [
  '/approvals',
  '/pos',
  '/dashboard',
  '/outlet',
  '/driver',
  '/warehouse',
  '/delivery',
  '/purchasing',
  '/finance',
  '/hr',
  '/assets',
  '/me',
  '/admin',
  '/topology',
  '/docs',
];

test.describe('home hub', () => {
  for (const role of ['owner', 'superadmin'] as const) {
    test(`${role} lands on the hub with a card for every interface`, async ({ page }) => {
      await login(page, USERS[role]);

      await expectLandsOn(page, '/');

      const links = await mainLinks(page);
      for (const href of EXPECTED_INTERFACES) {
        expect(links, `${role} is missing the ${href} card`).toContain(href);
      }

      // /outlet and /driver are named explicitly because their ABSENCE was the
      // reported bug: owner held none of the permissions gating them.
      expect(links).toContain('/outlet');
      expect(links).toContain('/driver');
    });
  }

  test('a hub card navigates to its interface', async ({ page }) => {
    await login(page, USERS.owner);
    await page.locator('main a[href="/delivery"]').first().click();
    await page.waitForURL(/\/delivery$/);
    await expect(page.locator('body')).toContainText('Surat Jalan');
  });

  test('kepala gudang is redirected past the hub to the warehouse', async ({ page }) => {
    await login(page, USERS.kepalaGudang);

    // Redirected off the hub, not merely away from /login.
    await expectLandsOn(page, '/warehouse');

    // Visiting the hub directly must bounce too — the redirect belongs to the
    // page, not to the login flow.
    await page.goto('/');
    await page.waitForURL(/\/warehouse$/);
    expect(pathOf(page)).toBe('/warehouse');
  });

  test('the sidebar and the hub agree on what a role can reach', async ({ page }) => {
    // Both are derived from `lib/nav.ts` + `usePermissions`. If they ever
    // disagree, one of them is hand-listed again — the exact regression the
    // hub rewrite was meant to make impossible.
    await login(page, USERS.owner);
    const hubLinks = (await mainLinks(page)).filter((h) => h !== '/docs');

    await page.goto('/dashboard');
    await expect(page.locator('nav a, aside a').first()).toBeVisible();
    const navLinks = await page
      .locator('nav a[href], aside a[href]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')!));

    for (const href of hubLinks) {
      expect(navLinks, `${href} is on the hub but not in the sidebar`).toContain(href);
    }
  });
});
