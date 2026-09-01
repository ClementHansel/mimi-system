import { test, expect, type Page } from '@playwright/test';
import { login, USERS } from './support/app';
import {
  assertNoLoadFailure,
  assertNoTechnicalError,
  collectConsoleErrors,
} from './support/errors';

/**
 * OPEN EVERY DIALOG IN THE APP. Sixty-eight components render one and, until
 * this file, no test had opened a single one.
 *
 * Why dialogs specifically: they are where the app's real work is started, and
 * they are the least-looked-at surface in it. Every bug found in this codebase
 * over the last two days was of a kind a dialog can hide just as easily as a
 * page — a crash on render, an unresolved i18n key, a raw UUID, a screen that
 * calls something the role may not call. A route sweep never sees any of it,
 * because the dialog is behind a click.
 *
 * SAFE BY CONSTRUCTION, and this is the part to preserve if it is edited:
 *
 *  1. It only clicks buttons whose label is on `SAFE_OPENERS`. Never
 *     "Nonaktifkan", "Hapus", "Batalkan", "Setujui", "Tolak", "Proses" — a
 *     sweep that clicks a destructive action to see what happens is not a
 *     test, it is an incident.
 *  2. It NEVER SUBMITS. It opens, reads, and closes. So it can run against any
 *     box, including production, and writes nothing — which is also why it is
 *     not gated on `E2E_ALLOW_WRITES`.
 *  3. It closes by Escape and asserts the dialog actually went away, so one
 *     stuck dialog cannot cascade into every later click missing its target.
 *
 * What it deliberately does NOT check: that a form VALIDATES. That needs a
 * submit, which needs to know per-form what a safe submission is, and belongs
 * in the flow specs (`ops-*`) where the intent is explicit.
 */

/**
 * Labels that open something rather than doing something.
 *
 * Matched as a whole-word prefix on the button's accessible name: "Tambah
 * Supplier", "Buat Permintaan", "Impor CSV". Deliberately conservative —
 * a missed dialog costs coverage, a wrongly-clicked one costs data.
 */
const SAFE_OPENERS = ['Tambah', 'Buat', 'Impor', 'Ubah', 'Detail', 'Lihat', 'Atur'];

/**
 * "Ajukan" is deliberately NOT a safe opener, even though it opens the leave
 * form on `/me/cuti`. On other screens the same word SUBMITS — a draft
 * purchase request's row carries "Ajukan", and clicking it sends a real
 * document for approval. Missing one dialog is cheaper than submitting
 * somebody's paperwork, so that one is covered by a flow spec instead.
 */

/** Never clicked, even if a label starts with a safe word. */
const NEVER_CLICK = [
  /Nonaktif/i,
  /Hapus/i,
  /Batal/i,
  /Setujui/i,
  /Tolak/i,
  /Proses/i,
  /Kirim/i,
  /Terima/i,
  /Void/i,
  /Selesaikan/i,
  /Jadikan/i,
  /Keluar/i,
  /Sinkron/i,
];

/**
 * Every route with an action surface worth opening. `/pos` is absent on
 * purpose: its buttons ring sales rather than opening dialogs, and
 * `ops-pos-day` drives it properly.
 */
const ROUTES = [
  '/purchasing',
  '/finance',
  '/hr',
  '/assets',
  '/vouchers',
  '/admin',
  '/topology',
  '/delivery',
  '/outlet',
  '/outlet/opname',
  '/outlet/waste',
  '/outlet/retur',
  '/outlet/kas-kecil',
  '/outlet/jadwal',
  '/warehouse/stock',
  '/warehouse/receiving',
  '/me/cuti',
  '/me/pinjaman',
];

function isSafeOpener(label: string): boolean {
  const name = label.trim();
  if (name.length === 0 || name.length > 40) return false;
  if (NEVER_CLICK.some((p) => p.test(name))) return false;
  return SAFE_OPENERS.some((word) => new RegExp(`^${word}\\b`).test(name));
}

/**
 * Accessible names of every safe opener currently on screen, deduped.
 *
 * WAITS FOR THE PAGE TO HAVE BUTTONS FIRST. `networkidle` is not enough on its
 * own: the first run of this sweep collected its list straight after it and
 * reported "0 dialogs" for `/topology`, `/delivery` and ten other routes whose
 * openers exist and work — the buttons simply had not rendered yet. Twelve
 * routes silently covered nothing and the file still passed, which is the
 * exact failure mode this suite keeps having to design against.
 */
async function safeOpeners(page: Page): Promise<string[]> {
  await page
    .locator('button')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => {});
  // One more settle: the shell's own buttons paint before a panel's do, so
  // "some button exists" can still be too early for the panel's toolbar.
  await page.waitForTimeout(1_500);

  const labels = await page
    .locator('button')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
  return [...new Set(labels.filter(isSafeOpener))];
}

test.describe('Every dialog opens, reads clean, and closes', () => {
  for (const route of ROUTES) {
    test(`${route} — its dialogs`, async ({ page }) => {
      // Each route may hold several dialogs, each with its own fetches.
      test.setTimeout(240_000);
      const console_ = collectConsoleErrors(page);
      await login(page, USERS.owner);
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});

      // Tabs first: on a tabbed area most dialogs live behind a tab that is
      // not the default one, so sweeping only the landing tab would miss them.
      const tabs = page.getByRole('tab');
      const tabCount = await tabs.count().catch(() => 0);
      const panels = tabCount > 0 ? tabCount : 1;

      // OUTLET SCREENS NEED AN OUTLET. As owner (every location in scope)
      // `/outlet/*` renders a location PICKER and no work surface, so the sweep
      // found nothing to open on six routes. Choosing the first one puts the
      // screen into the state a supervisor always sees.
      if (route.startsWith('/outlet')) {
        const picker = page.getByRole('button', { name: /^Mimi Chicken / }).first();
        if (await picker.count()) {
          await picker.click().catch(() => {});
          await page.waitForLoadState('networkidle').catch(() => {});
        }
      }

      const opened: string[] = [];
      const problems: string[] = [];

      for (let t = 0; t < panels; t++) {
        if (tabCount > 0) {
          await tabs
            .nth(t)
            .click()
            .catch(() => {});
          await page.waitForLoadState('networkidle').catch(() => {});
        }

        for (const label of await safeOpeners(page)) {
          const button = page.getByRole('button', { name: label, exact: true }).first();
          if ((await button.count()) === 0) continue;
          await button.click().catch(() => {});

          const dialog = page.getByRole('dialog');
          // Not every safe-looking label opens a dialog — "Detail" may expand a
          // drawer, "Atur" may navigate. Nothing to inspect, nothing to report.
          if (
            !(await dialog
              .first()
              .waitFor({ state: 'visible', timeout: 4000 })
              .then(() => true)
              .catch(() => false))
          ) {
            await page.keyboard.press('Escape').catch(() => {});
            continue;
          }

          opened.push(`${route}${tabCount > 0 ? ` [tab ${t}]` : ''} → ${label}`);
          try {
            // A dialog with no accessible name is a dialog a screen-reader user
            // cannot identify, and usually a sign the title was forgotten.
            await expect(dialog.first()).not.toBeEmpty();
            await assertNoLoadFailure(page, `${route} → ${label}`);
            await assertNoTechnicalError(page, `${route} → ${label}`);
          } catch (err) {
            problems.push(`${route} → "${label}": ${(err as Error).message.split('\n')[0]}`);
          }

          await page.keyboard.press('Escape').catch(() => {});
          // A dialog that will not close leaves every later click hitting its
          // overlay, so this is reported rather than silently worked around.
          const closed = await dialog
            .first()
            .waitFor({ state: 'hidden', timeout: 5000 })
            .then(() => true)
            .catch(() => false);
          if (!closed) {
            problems.push(`${route} → "${label}": the dialog would not close on Escape`);
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle').catch(() => {});
          }
        }
      }

      // Reported, not asserted: a route may legitimately offer no dialog to the
      // owner, and failing on that would only encourage deleting the route from
      // the list. What the run should make visible is what it actually opened.
      console.log(
        `[form-sweep] ${route}: opened ${opened.length} dialog(s)` +
          (opened.length > 0 ? ` — ${opened.map((o) => o.split('→ ')[1]).join(', ')}` : ''),
      );

      expect(problems, `broken dialogs on ${route}:\n  ${problems.join('\n  ')}`).toEqual([]);
      expect(console_.errors, `console errors while opening dialogs on ${route}`).toEqual([]);
    });
  }
});
