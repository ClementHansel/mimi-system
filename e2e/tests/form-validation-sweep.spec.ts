import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';
import { ALLOW_WRITES } from './support/crew';
import { assertNoLoadFailure, assertNoTechnicalError, collectApiFailures } from './support/errors';
import {
  chooseOutletIfAsked,
  closeDialog,
  DIALOG_ROUTES,
  openDialog,
  isPrefilled,
  panelCount,
  primaryAction,
  safeOpeners,
  selectPanel,
} from './support/dialogs';

/**
 * SUBMIT EVERY DIALOG EMPTY, and see whether the app refuses it like a product
 * or like a stack trace.
 *
 * `form-sweep` proves each dialog opens and reads clean. This is the other
 * half: an empty submit is the single most common thing a real user does by
 * accident, and it is the path that produced two of this project's worst
 * user-visible bugs — the supplier form printing
 * `duplicate key value violates unique constraint "suppliers_code_key"`, and
 * the payments screen rendering a raw i18n key. Both were on a refusal path.
 *
 * WHAT COUNTS AS PASSING. Either is fine, and the difference is the form's
 * choice, not this test's business:
 *   - the submit button is DISABLED while the form is empty ("Tambah Pengguna"
 *     does this), or
 *   - it submits and the app answers with a human sentence.
 *
 * WHAT FAILS: a crash, an error state, or any machine vocabulary — SQL, a bare
 * UUID, an `ERR_*` code, an unresolved i18n key, "Internal server error".
 *
 * WHY IT IS WRITE-GATED even though it only ever submits nothing: a form whose
 * fields are all optional would accept an empty submit and create a row. That
 * is a legitimate design, and this sweep cannot know in advance which forms
 * they are — so it must never run against a live business. It belongs on the
 * ephemeral CI stack, where the database is minutes old and about to be
 * deleted. `form-sweep` is the variant that is safe against production.
 *
 * A dialog that ACCEPTS an empty submit is reported rather than failed. It may
 * be perfectly correct, and it is the caller's judgement whether "you can
 * create a blank one of these" is intended.
 */

test.describe('Every dialog refuses an empty submit like a product', () => {
  test.skip(!ALLOW_WRITES, 'writes disabled — an all-optional form would create a row');

  for (const route of DIALOG_ROUTES) {
    test(`${route} — empty submits`, async ({ page }) => {
      test.setTimeout(300_000);
      const api = collectApiFailures(page);
      await login(page, USERS.owner);
      await page.goto(route, { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      await chooseOutletIfAsked(page, route);

      const problems: string[] = [];
      const gatedByButton: string[] = [];
      const prefilled: string[] = [];
      const accepted: string[] = [];
      const refused: string[] = [];

      for (let panel = 0; panel < (await panelCount(page)); panel++) {
        await selectPanel(page, panel);

        for (const label of await safeOpeners(page)) {
          const dialog = await openDialog(page, label);
          if (!dialog) continue;

          // An EDIT form is pre-filled, so "submit it empty" is not a probe of
          // anything — it is a no-op update that legitimately succeeds, and the
          // first run of this sweep reported exactly that as a finding (and
          // performed a real supplier update to do so).
          if (await isPrefilled(dialog)) {
            prefilled.push(label);
            await closeDialog(page);
            continue;
          }

          // Scoped INSIDE the dialog, so the page's toolbar button that opened
          // it cannot be clicked again.
          const submit = await primaryAction(dialog);

          if (!submit) {
            // A dialog with no submit is a viewer (a detail drawer, a preview).
            // Nothing to refuse.
            await closeDialog(page);
            continue;
          }

          const where = `${route} → "${label}"`;

          if (await submit.isDisabled()) {
            // The form gates itself. This is the strongest possible answer and
            // needs no round trip to the server.
            gatedByButton.push(label);
          } else {
            await submit.click().catch(() => {});
            // Give the refusal time to arrive — it may be client-side
            // validation (instant) or a server 422 (a round trip).
            await page.waitForTimeout(2_500);

            try {
              await assertNoLoadFailure(page, where);
              await assertNoTechnicalError(page, where);
            } catch (err) {
              problems.push(`${where}: ${(err as Error).message.split('\n')[0]}`);
            }

            // Did it refuse, or did it go through? A dialog still on screen
            // means it refused; a closed one means the submit was accepted.
            const stillOpen = await page
              .getByRole('dialog')
              .first()
              .isVisible()
              .catch(() => false);
            (stillOpen ? refused : accepted).push(label);
          }

          if (!(await closeDialog(page))) {
            problems.push(`${where}: the dialog would not close on Escape`);
            await page.goto(route, { waitUntil: 'domcontentloaded' });
            await page.waitForLoadState('networkidle').catch(() => {});
            await chooseOutletIfAsked(page, route);
          }
        }
      }

      console.log(
        `[validation-sweep] ${route}: ` +
          `${gatedByButton.length} gated by a disabled button` +
          (gatedByButton.length ? ` (${gatedByButton.join(', ')})` : '') +
          `, ${refused.length} refused after submitting` +
          (refused.length ? ` (${refused.join(', ')})` : '') +
          `, ${accepted.length} ACCEPTED an empty submit` +
          (accepted.length ? ` (${accepted.join(', ')})` : '') +
          `, ${prefilled.length} skipped as pre-filled edit forms` +
          (prefilled.length ? ` (${prefilled.join(', ')})` : ''),
      );

      expect(
        problems,
        `these dialogs answered an empty submit badly on ${route}:\n  ${problems.join('\n  ')}`,
      ).toEqual([]);

      // A 5xx on a refusal path is always wrong: refusing bad input is the
      // server's job, and it should do it with a 4xx and a code. 4xx responses
      // are EXPECTED here, so only server faults are asserted on.
      const faults = api.failures.filter((f) => /^5\d\d /.test(f));
      expect(
        faults,
        `empty submits caused server errors on ${route}:\n  ${faults.join('\n  ')}`,
      ).toEqual([]);
    });
  }
});
