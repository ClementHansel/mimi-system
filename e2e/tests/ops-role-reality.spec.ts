import { test, expect, type Page } from '@playwright/test';
import { login } from './support/app';
import { CREW } from './support/crew';
import {
  assertNoLoadFailure,
  assertNoTechnicalError,
  collectApiFailures,
  collectConsoleErrors,
} from './support/errors';

/**
 * WHAT EACH REAL PERSON ACTUALLY SEES, in their own account.
 *
 * `surface-sweep.spec.ts` opens every route as OWNER, who is all-access — so it
 * proves a screen is not broken, and nothing about whether the person whose job
 * it is can reach it. This file is the other half: log in as the supervisor, the
 * kasir, the cook, the warehouse head, the driver, the manager, finance and HR,
 * and walk what THEIR sidebar actually offers.
 *
 * That distinction is not academic. The PIN bug found on 2026-08-31 was
 * invisible to every owner-run test and locked finance, hr_admin and driver out
 * of the product entirely — three whole roles, on a box that looked healthy.
 *
 * Read-only. It clicks nothing that writes; the writing simulations live in the
 * `ops-*` flow specs. What it asserts, per role:
 *
 *   1. they can log in and land somewhere real (not `/login`, not a 404),
 *   2. their sidebar offers at least one place to work,
 *   3. every entry in that sidebar opens without an error state,
 *   4. nothing on any of those screens speaks machine.
 *
 * A role that lands on an empty shell with nothing to click is a failure here
 * even though every individual page "works" — that is exactly what being
 * locked out looks like from the inside.
 */

interface RoleExpectation {
  who: string;
  username: string;
  /** Human name for failure messages — "kasir", not "kasir_bpp01_p". */
  job: string;
  /**
   * The least this role must be able to reach. Deliberately a MINIMUM, not an
   * exact list: an exact sidebar is `role-journeys.spec.ts`'s job (it asserts
   * the RBAC surface), and duplicating it here would make both files fail for
   * one permission change. What this asserts is weaker and more important —
   * the person can get to the thing they are employed to do.
   */
  mustReach: string[];
}

const ROLES: RoleExpectation[] = [
  {
    who: CREW.supervisor,
    username: CREW.supervisor,
    job: 'Supervisor Cabang',
    // Raises and approves outlet requests, runs the outlet's day.
    mustReach: ['/outlet'],
  },
  {
    who: CREW.kasir,
    username: CREW.kasir,
    job: 'Kasir',
    mustReach: ['/pos'],
  },
  {
    who: CREW.koki,
    username: CREW.koki,
    job: 'Juru Masak',
    // The narrowest role in the matrix: own record plus the kitchen floor.
    mustReach: ['/me'],
  },
  {
    who: CREW.kepalaGudang,
    username: CREW.kepalaGudang,
    job: 'Kepala Gudang',
    mustReach: ['/warehouse'],
  },
  {
    who: CREW.driver,
    username: CREW.driver,
    job: 'Driver',
    mustReach: ['/driver'],
  },
  {
    who: CREW.manager,
    username: CREW.manager,
    job: 'Manager',
    mustReach: ['/dashboard'],
  },
  {
    who: CREW.finance,
    username: CREW.finance,
    job: 'Finance',
    mustReach: ['/finance'],
  },
  {
    who: CREW.hrAdmin,
    username: CREW.hrAdmin,
    job: 'HR Admin',
    mustReach: ['/hr'],
  },
  {
    who: CREW.owner,
    username: CREW.owner,
    job: 'Pemilik',
    mustReach: ['/dashboard'],
  },
];

/**
 * Every distinct in-app link this role is offered, deduped and ordered.
 *
 * `main` as well as `nav`/`aside`, and that is the whole subtlety: the HUB
 * (`/`) has no sidebar — it renders one card per INTERFACE inside `main`, which
 * is why `support/app.ts` has a `mainLinks()` helper at all. Reading only
 * `nav`/`aside` reported "NO navigation at all" for all nine roles on the first
 * run, because most of them land on the hub. The app was fine; the query was
 * looking in the wrong element.
 */
async function offeredLinks(page: Page): Promise<string[]> {
  const hrefs = await page
    .locator('nav a[href], aside a[href], main a[href]')
    .evaluateAll((els) =>
      els.map((e) => e.getAttribute('href') ?? '').filter((h) => h.startsWith('/')),
    );
  return [...new Set(hrefs)].sort();
}

for (const role of ROLES) {
  test.describe(`${role.job} (${role.username})`, () => {
    test(`can log in, lands somewhere real, and is offered work to do`, async ({ page }) => {
      const console_ = collectConsoleErrors(page);
      const api = collectApiFailures(page);
      await login(page, role.username);

      const landed = new URL(page.url()).pathname;
      expect(landed, `${role.job} was bounced back to the login page`).not.toBe('/login');
      await expect(page.locator('body')).not.toBeEmpty();

      const links = await offeredLinks(page);
      // The "locked out" assertion. A role that lands on a shell with nothing
      // to click has no product, however healthy each page is on its own.
      expect(
        links.length,
        `${role.job} landed on ${landed} with NO navigation at all — they cannot do their job`,
      ).toBeGreaterThan(0);

      // "Can they reach their workplace" is answered by GOING there, not by
      // looking for a link on the landing screen. Two reasons, both learned
      // from this test's first run: the hub redirects onward in an effect, so
      // reading its links straight after login races that redirect (the race
      // `expectLandsOn` exists for); and `/finance` and `/hr` are areas INSIDE
      // the dashboard interface, so they are legitimately absent from the hub
      // while being exactly where those two roles work. Both roles were
      // reported as locked out of their own jobs, and both were fine.
      for (const required of role.mustReach) {
        await page.goto(required, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});
        const at = new URL(page.url()).pathname;
        expect(at, `${role.job} was bounced off ${required} to ${at}`).not.toBe('/login');
        expect(
          at === required || at.startsWith(`${required}/`),
          `${role.job} asked for ${required} and was sent to ${at} instead`,
        ).toBe(true);
        await assertNoLoadFailure(page, `${role.job} at ${required}`);
        await assertNoTechnicalError(page, `${role.job} at ${required}`);
      }

      await assertNoLoadFailure(page, `${role.job} landing (${landed})`);
      await assertNoTechnicalError(page, `${role.job} landing (${landed})`);

      // The UI must not call endpoints this role is forbidden from calling.
      // Reported with the route, because "a 403 happened" is not actionable and
      // `403 GET /api/pos/shifts` is.
      expect(
        api.failures,
        `${role.job}'s landing screen calls endpoints they are not allowed to call`,
      ).toEqual([]);
      expect(console_.errors, `console errors on ${role.job}'s landing`).toEqual([]);
    });

    test(`every screen their own sidebar offers actually opens`, async ({ page }) => {
      // A role's sidebar is a promise. This walks all of it, which is the
      // cheapest way to find a screen that 500s for one job and nobody else's —
      // the shape of most of the bugs found so far.
      test.setTimeout(240_000);
      const console_ = collectConsoleErrors(page);
      const api = collectApiFailures(page);
      await login(page, role.username);

      const links = await offeredLinks(page);
      const broken: string[] = [];

      for (const href of links) {
        // `/` is the hub and is covered by the landing test above; skipping it
        // here keeps the loop to real destinations.
        if (href === '/') continue;
        await page.goto(href, { waitUntil: 'domcontentloaded' });
        await page.waitForLoadState('networkidle').catch(() => {});

        const where = `${role.job} → ${href}`;
        try {
          expect(new URL(page.url()).pathname, `${where} bounced to login`).not.toBe('/login');
          await assertNoLoadFailure(page, where);
          await assertNoTechnicalError(page, where);
        } catch (err) {
          // Collect rather than throw: one broken screen should not hide the
          // other six, and the report a person acts on is "these three are
          // broken", not "the first one is".
          broken.push(`${href}: ${(err as Error).message.split('\n')[0]}`);
        }
      }

      expect(
        broken,
        `${role.job} has broken screens in their own sidebar:\n  ${broken.join('\n  ')}`,
      ).toEqual([]);
      // Same rule as the landing test: a screen must not call endpoints the
      // signed-in role is forbidden from calling. Reported with the route,
      // because `403 GET /api/dashboard/ops-status` names the bug — that is
      // literally how the Kepala Gudang warehouse defect was identified — and
      // "a 403 happened somewhere" does not.
      expect(
        api.failures,
        `${role.job}'s own screens call endpoints they are not allowed to call:\n  ${api.failures.join('\n  ')}`,
      ).toEqual([]);
      expect(console_.errors, `console errors while walking ${role.job}'s sidebar`).toEqual([]);
    });
  });
}
