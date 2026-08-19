import { test, expect } from '@playwright/test';
import { expectLandsOn, login } from './support/app';

/**
 * W6-01 — one journey per role.
 *
 * `hub.spec.ts` already covers owner, superadmin and kepala_gudang, and
 * `driver.spec.ts` covers the driver. This file covers the remaining six
 * business roles, and asserts the thing that actually matters about a role:
 * **where it lands, and what it can and cannot reach.**
 *
 * The SEES/HIDDEN lists below are not invented. They were computed from the
 * real `@mimi/shared` RBAC matrix crossed with `lib/nav.ts`'s permission
 * gates, then written down here on purpose rather than recomputed at runtime —
 * a test that derives its expectations from the same source it is testing
 * proves nothing. If someone widens a permission, this file fails and names
 * the surface that moved, which is exactly what a CONTRACTS §3 change should
 * do.
 *
 * That makes this a genuine RBAC surface sweep as well as a smoke journey
 * (a slice of W6-03), though only at nav level — the server, not the sidebar,
 * remains the real authorization boundary.
 */

interface RoleJourney {
  role: string;
  username: string;
  /** Where `(auth)/landing.ts` should put them after login. */
  landing: string;
  sees: string[];
  hidden: string[];
}

const JOURNEYS: RoleJourney[] = [
  {
    role: 'manager',
    username: 'manager1',
    landing: '/dashboard',
    sees: [
      '/approvals',
      '/pos',
      '/dashboard',
      '/warehouse',
      '/delivery',
      '/purchasing',
      '/finance',
      '/hr',
      '/assets',
      '/me',
      '/admin',
      '/topology',
    ],
    // A manager is head-office: no outlet-staff create surface, and not a driver.
    hidden: ['/outlet', '/driver'],
  },
  {
    role: 'finance',
    username: 'finance1',
    landing: '/finance',
    // /approvals is visible: finance holds `payment.verify`, one of the 11
    // approve keys that entry accepts. Getting this wrong the first time is
    // why the lists are transcribed from nav.ts's real arrays, not summarised.
    sees: ['/approvals', '/purchasing', '/finance', '/hr', '/assets', '/me', '/admin'],
    hidden: ['/pos', '/dashboard', '/outlet', '/driver', '/warehouse', '/delivery', '/topology'],
  },
  {
    role: 'supervisor',
    username: 'spv_bjm01',
    landing: '/outlet',
    sees: [
      '/approvals',
      '/pos',
      '/dashboard',
      '/outlet',
      '/warehouse',
      '/delivery',
      '/purchasing',
      '/hr',
      '/assets',
      '/me',
    ],
    hidden: ['/driver', '/finance', '/admin', '/topology'],
  },
  {
    role: 'leader_outlet',
    username: 'ldr_bjm01',
    landing: '/outlet',
    sees: ['/pos', '/outlet', '/warehouse', '/delivery', '/assets', '/me'],
    hidden: [
      '/approvals',
      '/dashboard',
      '/driver',
      '/purchasing',
      '/finance',
      '/hr',
      '/admin',
      '/topology',
    ],
  },
  {
    role: 'kasir',
    username: 'kasir1_bjm01',
    landing: '/pos',
    // The narrowest role in the system: a till and their own payslip.
    sees: ['/pos', '/me'],
    hidden: [
      '/approvals',
      '/dashboard',
      '/outlet',
      '/driver',
      '/warehouse',
      '/delivery',
      '/purchasing',
      '/finance',
      '/hr',
      '/assets',
      '/admin',
      '/topology',
    ],
  },
  {
    role: 'hr_admin',
    username: 'hradmin1',
    landing: '/hr',
    // /approvals visible via `hr.leave.approve`.
    sees: ['/approvals', '/hr', '/me', '/admin'],
    hidden: [
      '/pos',
      '/dashboard',
      '/outlet',
      '/driver',
      '/warehouse',
      '/delivery',
      '/purchasing',
      '/finance',
      '/assets',
      '/topology',
    ],
  },
];

for (const journey of JOURNEYS) {
  test.describe(`role journey — ${journey.role}`, () => {
    test(`lands on ${journey.landing} and sees only its own surfaces`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await login(page, journey.username);

      // Every non-all-access role is redirected past the hub to its own work.
      await expectLandsOn(page, journey.landing);

      // The sidebar only exists on a chrome route; the landing route is one
      // for every role here (POS is chromeless, so kasir is checked from /me).
      const navHost = journey.landing === '/pos' ? '/me' : journey.landing;
      if (navHost !== journey.landing) await page.goto(navHost);

      await expect(page.locator('nav a[href], aside a[href]').first()).toBeVisible({
        timeout: 20_000,
      });
      const hrefs = await page
        .locator('nav a[href], aside a[href]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('href')!));

      for (const href of journey.sees) {
        expect(hrefs, `${journey.role} should be able to reach ${href}`).toContain(href);
      }
      for (const href of journey.hidden) {
        expect(hrefs, `${journey.role} must NOT see ${href}`).not.toContain(href);
      }

      expect(errors, `${journey.role} hit a JS error on ${journey.landing}`).toEqual([]);
    });

    test('their landing surface renders real content, not an error state', async ({ page }) => {
      await login(page, journey.username);
      await page.goto(journey.landing);

      const body = page.locator('body');
      // Something rendered...
      await expect(body).not.toBeEmpty();
      // ...and it is not the generic failure copy. An empty state is fine —
      // a role with no data yet is legitimate — but "Terjadi kesalahan" is not.
      await expect(body).not.toContainText(/Terjadi kesalahan|Application error/i);
    });
  });
}
