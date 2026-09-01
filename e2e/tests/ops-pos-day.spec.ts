import { test, expect } from '@playwright/test';
import { login } from './support/app';
import { ALLOW_WRITES, CREW, CREW_OUTLET } from './support/crew';
import { assertNoLoadFailure, assertNoTechnicalError, collectApiFailures } from './support/errors';

/**
 * A CASHIER'S DAY AT THE TILL, in the cashier's own account.
 *
 * The till is the one screen in this product that a customer stands in front
 * of, and the one where a defect costs money the same minute it appears. It is
 * also the least like the rest of the app: its own layout (no `main`, no
 * sidebar), its own shift lifecycle, and an offline story none of the office
 * screens have.
 *
 * The read-only half always runs, because "can the cashier open the till at
 * all" is worth asserting on every box including production. Opening a shift
 * and ringing a sale are real writes — a fake sale lands in a real day's
 * takings and a shift left open blocks the next one — so those are gated on
 * `E2E_ALLOW_WRITES=1` and belong to the demo box.
 *
 * A NOTE ON `MoneyInput`, learned the hard way: it commits its value on BLUR,
 * not on keystroke (`ui/MoneyInput.tsx` parses `draft` in `onBlur`). Filling
 * the field and clicking submit in the same breath leaves the form's state
 * empty and the button disabled, which reads exactly like a broken button. A
 * real cashier taps away from the field before reaching for the button, so the
 * blur below is not a workaround — it is what actually happens.
 */

test.describe('The till, as the cashier finds it', () => {
  test('opens on the right outlet and asks for the opening float', async ({ page }) => {
    const api = collectApiFailures(page);
    await login(page, CREW.kasir);
    await page.goto('/pos', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // The cashier must be looking at THEIR outlet. A till bound to the wrong
    // branch would post a real sale to the wrong branch's takings, which no
    // amount of later reporting can unpick.
    await expect(page.getByText(CREW_OUTLET).first()).toBeVisible();

    // Before a shift exists there is exactly one thing to do, and the screen
    // should say so rather than showing an empty sales surface.
    await expect(page.getByLabel(/Modal Awal Kas/i)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Buka Kasir' })).toBeVisible();

    await assertNoLoadFailure(page, 'kasir /pos');
    await assertNoTechnicalError(page, 'kasir /pos');
    expect(api.failures, 'the till calls endpoints the cashier may not call').toEqual([]);
  });

  test('will not open a shift without a float, and says so by disabling the button', async ({
    page,
  }) => {
    // A shift opened with an unknown float makes the close-of-day variance
    // meaningless, so the guard matters. Asserted as BEHAVIOUR, not as a
    // styling detail: the button is unusable until a number is committed.
    await login(page, CREW.kasir);
    await page.goto('/pos', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    await expect(page.getByRole('button', { name: 'Buka Kasir' })).toBeDisabled();
  });
});

test.describe('Opening the till for real (opt-in: E2E_ALLOW_WRITES=1)', () => {
  test.skip(!ALLOW_WRITES, 'writes disabled — this opens a real shift on the target box');

  test('a float, entered and committed, opens the shift and reveals the sales screen', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const api = collectApiFailures(page);
    await login(page, CREW.kasir);
    await page.goto('/pos', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    const openButton = page.getByRole('button', { name: 'Buka Kasir' });

    // If a shift is already open on this box (someone else's run, or a real
    // one), there is nothing to open and this test has no subject. Skip rather
    // than force-close someone's till.
    if ((await openButton.count()) === 0) {
      test.skip(true, 'a shift is already open on this outlet');
    }

    const float = page.getByLabel(/Modal Awal Kas/i);
    await float.fill('200000');
    // The blur that commits it — see this file's header.
    await float.blur();
    await expect(openButton, 'the float did not commit, so the till stayed shut').toBeEnabled();

    await openButton.click();

    // The shift is open when the opening form is gone. Asserting on what
    // REPLACED it (a product grid, a cart) would tie this test to the sales
    // screen's layout; asserting the till moved on is the durable claim.
    await expect(float).toBeHidden({ timeout: 60_000 });
    await assertNoLoadFailure(page, 'kasir after opening the shift');
    await assertNoTechnicalError(page, 'kasir after opening the shift');
    expect(api.failures, 'opening a shift called something forbidden').toEqual([]);

    // And it survives a reload — a shift that only exists in React state would
    // strand the cashier on the next refresh, mid-queue.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await expect(
      page.getByLabel(/Modal Awal Kas/i),
      'after a reload the till asked to be opened again — the shift did not persist',
    ).toBeHidden();
  });
});
