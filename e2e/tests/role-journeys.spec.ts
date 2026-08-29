import { test, expect } from '@playwright/test';
import { expectLandsOn, login } from './support/app';

/**
 * W6-01 — one journey per role.
 *
 * `hub.spec.ts` already covers owner, superadmin and kepala_gudang, and
 * `driver.spec.ts` covers the driver. This file covers the remaining six
 * business roles, and asserts the thing that actually matters about a role:
 * **where it lands, which INTERFACES it can reach, and what it sees inside the
 * dashboard.**
 *
 * Reworked for the two-level nav (owner's rulings, 2026-08-21). There is no
 * longer one flat sidebar of fourteen routes per role: the sidebar belongs to
 * the interface you are in (`lib/nav.ts` `INTERFACES`) and to nothing else —
 * switching interfaces is the hub's job, reached by the Beranda row. So each
 * journey asserts the sidebar of the interface it LANDS in, plus (for roles
 * that reach the dashboard) the areas they hold once inside it.
 *
 * The lists below are not invented. They were computed from the real
 * `@mimi/shared` RBAC matrix crossed with `lib/nav.ts`'s permission gates, then
 * written down on purpose rather than recomputed at runtime — a test that
 * derives its expectations from the same source it is testing proves nothing.
 * If someone widens a permission, this file fails and names the surface that
 * moved, which is exactly what a CONTRACTS §3 change should do.
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
  /** Interfaces this role can reach — asserted on the HUB, not the sidebar. */
  interfaces: string[];
  /** Interfaces this role must never be offered, on the hub or anywhere else. */
  hiddenInterfaces: string[];
  /** Dashboard areas visible in the dashboard's sidebar — omit if unreachable. */
  dashboardAreas?: string[];
  /** Dashboard areas that must stay hidden even inside the dashboard. */
  hiddenAreas?: string[];
}

/** Every interface, so "hidden" can be asserted as the complement of "seen". */
const ALL_INTERFACES = ['/dashboard', '/pos', '/outlet', '/warehouse', '/driver', '/me', '/docs'];

const JOURNEYS: RoleJourney[] = [
  {
    role: 'manager',
    username: 'manager1',
    landing: '/dashboard',
    // Head office: no outlet-staff create surface, and not a driver.
    interfaces: ['/dashboard', '/pos', '/warehouse', '/me', '/docs'],
    hiddenInterfaces: ['/outlet', '/driver'],
    dashboardAreas: [
      '/dashboard',
      '/approvals',
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
    role: 'finance',
    username: 'finance1',
    landing: '/finance',
    // `/finance` IS the dashboard interface — finance simply lands on its own
    // area inside it rather than on the overview, which they cannot see
    // (no `dashboard.view`; asserted in `hiddenAreas`).
    interfaces: ['/dashboard', '/me', '/docs'],
    hiddenInterfaces: ['/pos', '/outlet', '/warehouse', '/driver'],
    // /approvals is visible: finance holds `payment.verify`, one of the 11
    // approve keys that entry accepts. Getting this wrong the first time is
    // why these lists are transcribed from nav.ts's real arrays, not summarised.
    dashboardAreas: ['/approvals', '/purchasing', '/finance', '/hr', '/assets', '/admin'],
    hiddenAreas: ['/dashboard', '/delivery', '/topology'],
  },
  {
    role: 'supervisor',
    // `<slot>_<outlet>_<shift>` — the shift suffix arrived with the org
    // reshape into crews. `spv_bjm01` has not existed since; this journey had
    // been timing out on the login page ever since, unnoticed, because the
    // post-deploy smoke does not run this spec.
    username: 'spv_bjm01_p',
    landing: '/outlet',
    interfaces: ['/outlet', '/pos', '/dashboard', '/warehouse', '/me', '/docs'],
    hiddenInterfaces: ['/driver'],
    dashboardAreas: ['/dashboard', '/approvals', '/delivery', '/purchasing', '/hr', '/assets'],
    hiddenAreas: ['/finance', '/admin', '/topology'],
  },
  // NO `leader_outlet` JOURNEY — the role is retired, not broken.
  //
  // The org was reshaped into the crews the business actually runs (supervisor
  // + cashier + two cooks) and NO employee holds `leader_outlet` any more. The
  // backend fixtures already know this: `waste-return/test-support/live-db.ts`
  // substitutes `koki`/`kasir` for it and treats an unstaffed role as skippable
  // rather than fatal, with the reshape written up in its own comment.
  //
  // This spec never got the same update, so it kept logging in as `ldr_bjm01` —
  // a user that does not exist in any seed — and timing out on the login page.
  // Removed rather than re-pointed at a substitute user: a journey asserting
  // which interfaces `leader_outlet` sees, driven by a cashier's session, would
  // be testing the cashier and reporting on a role nobody holds.
  //
  // `RoleKey.LEADER_OUTLET` still exists in the RBAC matrix, so if the role is
  // ever staffed again this journey should come back with a real user.
  {
    role: 'kasir',
    // The morning cashier at BJM01 — `<slot>_<outlet>_<shift>`, see support/app.ts.
    username: 'kasir_bjm01_p',
    landing: '/pos',
    // The narrowest role in the system: a till, the manual, and their own
    // payslip (`/me` — a dashboard AREA reached from the header's account
    // menu on any chrome route, not an interface of its own).
    interfaces: ['/pos', '/me', '/docs'],
    hiddenInterfaces: ['/outlet', '/warehouse', '/driver'],
  },
  {
    role: 'hr_admin',
    username: 'hradmin1',
    landing: '/hr',
    interfaces: ['/dashboard', '/me', '/docs'],
    hiddenInterfaces: ['/pos', '/outlet', '/warehouse', '/driver'],
    // /approvals visible via `hr.leave.approve`.
    dashboardAreas: ['/approvals', '/hr', '/admin'],
    hiddenAreas: ['/dashboard', '/delivery', '/purchasing', '/finance', '/assets', '/topology'],
  },
];

/** Every href the sidebar (desktop rail or mobile drawer) currently offers. */
async function sidebarLinks(page: import('@playwright/test').Page): Promise<string[]> {
  await expect(page.locator('nav a[href], aside a[href]').first()).toBeVisible({
    timeout: 20_000,
  });
  return page
    .locator('nav a[href], aside a[href]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href')!));
}

for (const journey of JOURNEYS) {
  test.describe(`role journey — ${journey.role}`, () => {
    test(`lands on the hub and is offered only its own interfaces`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await login(page, journey.username);

      // EVERY role lands on the hub, including this one.
      //
      // This used to assert `expectLandsOn(page, journey.landing)` — that a
      // non-all-access role is redirected past the hub straight into its own
      // work. That was the behaviour until the owner replaced it: login now
      // "always redirects to the home hub (`/`, F-BRAND) — the owner asked for
      // an AIRE-style 'where do you want to work today' launchpad instead of
      // dropping straight into one module" (see the login page's own note).
      // `app/page.tsx` still redirects past the hub, but only for someone who
      // can reach a single interface, and since `employee` became an interface
      // of its own nobody is in that position: everyone has their work plus
      // Akun Saya. So the old assertion could not pass for any role, and it
      // failed for all five.
      //
      // The role-appropriate landing route is not abandoned, it moved: the hub
      // uses `getLandingRoute` to pick which card is the role's primary job,
      // and the hub-link assertions further down are what check each role is
      // offered its own destinations and no one else's.
      await expectLandsOn(page, '/');

      // The sidebar only exists on a chrome route, so go to one. POS is
      // chromeless, so kasir is checked from /me instead.
      const navHost = journey.landing === '/pos' ? '/me' : journey.landing;
      await page.goto(navHost);

      const hrefs = await sidebarLinks(page);

      // The sidebar belongs to ONE interface now. Everyone gets the Beranda
      // row (the hub is the switcher), and no other interface's entry leaks in.
      expect(hrefs, `${journey.role} needs the way back to the hub`).toContain('/');
      for (const href of journey.hiddenInterfaces) {
        expect(hrefs, `${journey.role} must NOT see ${href}`).not.toContain(href);
      }

      // And the hub itself offers exactly the interfaces this role can reach.
      await page.goto('/');
      const hubLinks = await page
        .locator('main a[href]')
        .evaluateAll((els) => els.map((e) => e.getAttribute('href')!));
      for (const href of journey.interfaces) {
        expect(hubLinks, `${journey.role} should be able to reach ${href}`).toContain(href);
      }
      for (const href of ALL_INTERFACES) {
        if (journey.interfaces.includes(href)) continue;
        expect(hubLinks, `${journey.role} must NOT be offered ${href}`).not.toContain(href);
      }

      expect(errors, `${journey.role} hit a JS error on ${journey.landing}`).toEqual([]);
    });

    if (journey.dashboardAreas) {
      test('sees only its own areas inside the dashboard', async ({ page }) => {
        await login(page, journey.username);
        // Enter the dashboard through an area this role really holds, so a
        // role without `dashboard.view` is still exercised.
        await page.goto(journey.dashboardAreas![0]!);

        const hrefs = await sidebarLinks(page);

        for (const href of journey.dashboardAreas!) {
          expect(hrefs, `${journey.role} should reach ${href} in the dashboard`).toContain(href);
        }
        for (const href of journey.hiddenAreas ?? []) {
          expect(hrefs, `${journey.role} must NOT see ${href} in the dashboard`).not.toContain(
            href,
          );
        }
      });
    }

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
