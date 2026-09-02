import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';
import { assertNoTechnicalError } from './support/errors';

/**
 * THE GUARD ITSELF, ON TRIAL.
 *
 * `assertNoTechnicalError` is the assertion most of this suite leans on, so a
 * fault in it is silent across every spec at once — either everything passes
 * while a leak is on screen, or a working screen fails and gets muted. Both
 * happened within one afternoon:
 *
 *  - Widening the i18n rule to all 47 namespaces made it match the app's real
 *    PERMISSION KEYS (`auth.pin.set`, `purchasing.po.create`), which the audit
 *    log renders on purpose. `/admin → Jejak Audit` failed CI and blocked a
 *    production deploy over a screen that was working perfectly.
 *  - The same rule could never match `finance.refType.employee_loan` — its tail
 *    excluded `_` and then failed a word boundary — so the guard had never been
 *    able to catch the very leak it was written for. That one was found by eye.
 *
 * Hence a test whose subject is the guard: the audit screen must pass, and a
 * genuine leak must still be caught even when a permission key sits beside it.
 */
test('audit excused; real leaks still caught', async ({ page }) => {
  await login(page, USERS.owner);
  await page.goto('/admin', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page
    .getByRole('tab', { name: /Jejak Audit/ })
    .first()
    .click();
  await page.waitForTimeout(4000);
  await assertNoTechnicalError(page, '/admin audit');
  console.log('@@@ audit passes');

  for (const [what, html, needle] of [
    ['unresolved i18n key', '<main>finance.refType.employee_loan</main>', /refType/],
    [
      'SQL beside a permission key',
      '<main>auth.pin.set duplicate key value violates unique constraint</main>',
      /duplicate key/,
    ],
    [
      'UUID beside a permission key',
      '<main>auth.pin.set 2e75a93f-40f6-45a3-a177-bf20ff4e7c9c</main>',
      /2e75a93f/,
    ],
  ] as [string, string, RegExp][]) {
    await page.setContent(html);
    await expect(assertNoTechnicalError(page)).rejects.toThrow(needle);
    console.log('@@@ still caught: ' + what);
  }
});
