import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';
import {
  assertNoLoadFailure,
  assertNoTechnicalError,
  collectConsoleErrors,
} from './support/errors';
import {
  chooseOutletIfAsked,
  closeDialog,
  DIALOG_ROUTES,
  openDialog,
  panelCount,
  safeOpeners,
  selectPanel,
} from './support/dialogs';

/**
 * OPEN EVERY DIALOG IN THE APP. Sixty-eight components render one and, until
 * this file, no test had opened a single one.
 *
 * Why dialogs specifically: they are where the app's real work is started, and
 * they are the least-looked-at surface in it. Every bug found in this codebase
 * has been of a kind a dialog hides as easily as a page — a crash on render, an
 * unresolved i18n key, a raw UUID, a screen calling something the role may not
 * call. A route sweep never sees any of it, because the dialog is behind a
 * click. On its first run this file found duplicate React keys in the supplier
 * price history, where React's own remedy is to duplicate or omit rows.
 *
 * SAFE AGAINST PRODUCTION, and that is the property to preserve: it opens,
 * reads, and closes. It NEVER SUBMITS, so it needs no write gate.
 * `form-validation-sweep` is the variant that submits (empty) and is gated,
 * because an all-optional form would accept that and create a row.
 *
 * Which dialogs exist, how to reach them, and which labels are safe to click
 * all live in `support/dialogs.ts`, shared with that sibling so the two cannot
 * drift into covering different sets.
 */

/** First line of an error message — a full Playwright message buries the point. */
function firstLine(err: unknown): string {
  return String((err as Error).message).split(/\r?\n/)[0] ?? '';
}

test.describe('Every dialog opens, reads clean, and closes', () => {
  for (const route of DIALOG_ROUTES) {
    test(`${route} — its dialogs`, async ({ page }) => {
      // Each route may hold several dialogs, each with its own fetches.
      test.setTimeout(240_000);
      const console_ = collectConsoleErrors(page);
      await login(page, USERS.owner);
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await chooseOutletIfAsked(page, route);

      const opened: string[] = [];
      const problems: string[] = [];

      // Tabs first: on a tabbed area most dialogs live behind a tab that is not
      // the default one, so sweeping only the landing tab misses them.
      for (let panel = 0; panel < (await panelCount(page)); panel++) {
        await selectPanel(page, panel);

        for (const label of await safeOpeners(page)) {
          const dialog = await openDialog(page, label);
          if (!dialog) continue;

          opened.push(label);
          const where = `${route} → ${label}`;
          try {
            await expect(dialog).not.toBeEmpty();
            await assertNoLoadFailure(page, where);
            await assertNoTechnicalError(page, where);
          } catch (err) {
            problems.push(`${where}: ${firstLine(err)}`);
          }

          if (!(await closeDialog(page))) {
            problems.push(`${where}: the dialog would not close on Escape`);
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle').catch(() => {});
            await chooseOutletIfAsked(page, route);
          }
        }
      }

      // Reported, not asserted: a route may legitimately offer the owner no
      // dialog, and failing on that would only encourage deleting the route
      // from the list. What a run must make visible is what it actually opened.
      console.log(
        `[form-sweep] ${route}: opened ${opened.length} dialog(s)` +
          (opened.length > 0 ? ` — ${opened.join(', ')}` : ''),
      );

      expect(problems, `broken dialogs on ${route}: ${problems.join(' | ')}`).toEqual([]);
      expect(console_.errors, `console errors while opening dialogs on ${route}`).toEqual([]);
    });
  }
});
