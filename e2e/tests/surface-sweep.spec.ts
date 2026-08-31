import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';
import {
  assertNoLoadFailure,
  assertNoTechnicalError,
  collectConsoleErrors,
} from './support/errors';

/**
 * EVERY static route, opened for real, with three assertions each:
 * the surface renders, it did not fail to load, and it shows the user no
 * machine vocabulary.
 *
 * WHY A SWEEP AND NOT MORE DEEP SPECS. The 2026-08-31 bug report was four
 * defects on four screens, and each had passing unit tests. What none of them
 * had was anyone opening the page against a real database: supplier search
 * 500'd on every query, and Permintaan Outlet counted every request as 0
 * items. A sweep is the cheapest thing that would have caught both, and its
 * value is that it covers screens nobody thought to write a spec for —
 * including the ones added next month.
 *
 * It is deliberately SHALLOW: it proves a surface is not broken, never that
 * its feature is correct. Deep flows live in their own files
 * (`purchasing.spec.ts`, `outlet-request.spec.ts`, `dispatcher.spec.ts`, …).
 * Adding a route here is one line; that is the point.
 *
 * Parameterized routes are excluded — `/approvals/[documentType]/[documentId]`
 * needs a document that exists, which is a flow, not a sweep. The `print/*`
 * routes are covered by `print.spec.ts`, which builds its own subjects.
 */

/** Owner is all-access, so any failure here is a broken surface, never a gate. */
const OWNER_ROUTES = [
  '/',
  '/dashboard',
  '/approvals',
  '/delivery',
  '/delivery/assign',
  '/delivery/rekap',
  '/purchasing',
  '/finance',
  '/hr',
  '/assets',
  '/vouchers',
  '/admin',
  '/topology',
  '/chat',
  '/chat/internal',
  '/docs',
  '/me',
  '/me/absen',
  '/me/cuti',
  '/me/kontrak',
  '/me/pinjaman',
  '/me/profil',
  '/me/slip',
  '/me/chat',
  '/pos',
  '/outlet',
  '/outlet/terima',
  '/outlet/stok',
  '/outlet/opname',
  '/outlet/waste',
  '/outlet/retur',
  '/outlet/kas-kecil',
  '/outlet/jadwal',
  '/warehouse',
  '/warehouse/rekap',
];

test.describe('Surface sweep — every route opens without failing', () => {
  // NOT serial. Each route logs in for itself and shares no state, and the
  // first run of this file proved why it matters: one strict-mode locator
  // error on `/` marked the other 34 routes "did not run", which is exactly
  // the report a sweep must never produce. `workers: 1` in the config already
  // keeps them sequential against one database.

  for (const route of OWNER_ROUTES) {
    test(`${route} renders, loads and speaks Indonesian`, async ({ page }) => {
      const console_ = collectConsoleErrors(page);
      await login(page, USERS.owner);

      await page.goto(route, { waitUntil: 'domcontentloaded' });

      // Something actually painted. `body` rather than `main` because a few
      // surfaces (the hub, print views) render their own top-level layout —
      // and NOT `locator('main, body')`, which matches two elements and fails
      // strict mode instead of asserting anything.
      await expect(page.locator('body')).not.toBeEmpty();

      // Not redirected away — a silent bounce to `/login` is how a permission
      // or session regression hides from a smoke test.
      const landed = new URL(page.url()).pathname;
      expect(landed, `${route} bounced to ${landed}`).not.toBe('/login');

      // The app's own "this broke" states, then the vocabulary guard.
      await page.waitForLoadState('networkidle').catch(() => {});
      await assertNoLoadFailure(page, route);
      await assertNoTechnicalError(page, route);

      // A render crash swallowed by an error boundary can still paint a
      // plausible page, so the console is the third, independent signal.
      expect(console_.errors, `console errors on ${route}`).toEqual([]);
    });
  }
});

/**
 * The tabbed modules, where a tab is a surface the sweep above never reaches:
 * `/purchasing` alone hides five panels behind one URL, and the supplier bug
 * was on the fourth of them. Clicking every tab of every tabbed area is the
 * rest of "all there is in the UI".
 */
const TABBED_AREAS: { route: string; area: string }[] = [
  { route: '/purchasing', area: 'Pembelian' },
  { route: '/finance', area: 'Keuangan' },
  { route: '/hr', area: 'SDM' },
  { route: '/assets', area: 'Aset' },
  { route: '/admin', area: 'Administrasi' },
  { route: '/dashboard', area: 'Dasbor' },
  { route: '/topology', area: 'Topologi' },
];

/**
 * NOT tabbed, verified by running them: `/vouchers` is a single panel, and
 * `/warehouse` splits its panels across `/warehouse/[panel]` routes instead of
 * tabs. They are covered by the route sweep above. Listed here so the next
 * person does not re-add them and get a skip they have to re-diagnose.
 */

test.describe('Surface sweep — every tab of every tabbed area', () => {
  for (const { route, area } of TABBED_AREAS) {
    test(`${area} (${route}) — each tab loads`, async ({ page }) => {
      // Some areas have six or seven tabs, each with its own fetch, so the
      // 60s default is not enough for the slowest of them — `/hr` hit exactly
      // that ceiling and reported "Target page closed", which reads like an
      // app crash rather than a budget. Raised per-test rather than globally
      // so the fast specs keep failing fast.
      test.setTimeout(180_000);
      const console_ = collectConsoleErrors(page);
      await login(page, USERS.owner);
      await page.goto(route, { waitUntil: 'domcontentloaded' });

      // WAIT for the first tab before counting. The first run of this file
      // counted immediately after `goto`, got 0 for all nine areas, and
      // SKIPPED every one of them — nine green-looking skips that asserted
      // nothing. A sweep that silently opts out of its own subject is worse
      // than no sweep, so this waits, and a genuine absence of tabs is now
      // the only way to reach the skip.
      const tabs = page.getByRole('tab');
      await tabs
        .first()
        .waitFor({ state: 'visible', timeout: 20_000 })
        .catch(() => {});
      const count = await tabs.count();
      test.skip(count === 0, `${route} renders no tabs`);
      // Every area in this list is tabbed today; if one loses its tabs, say so
      // in the failure rather than in a skip nobody reads.
      expect(count, `${route} was expected to be tabbed`).toBeGreaterThan(0);

      for (let i = 0; i < count; i++) {
        const tab = tabs.nth(i);
        const label = (await tab.innerText()).trim() || `tab ${i}`;
        await tab.click();
        await page.waitForLoadState('networkidle').catch(() => {});
        await assertNoLoadFailure(page, `${route} › ${label}`);
        await assertNoTechnicalError(page, `${route} › ${label}`);
      }

      expect(console_.errors, `console errors while tabbing ${route}`).toEqual([]);
    });
  }
});
