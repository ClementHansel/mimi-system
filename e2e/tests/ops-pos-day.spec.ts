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

  test('rings one small cash sale, end to end', async ({ page }) => {
    // THE SMALLEST REAL TRANSACTION the menu allows (Kerupuk, Rp3.000), because
    // this can be pointed at a live outlet: a test sale lands in that day's
    // takings and in that outlet's stock, and the cashier closing the shift
    // will see it. One cheap line keeps the footprint as small as a real
    // transaction can be, and the spec prints the receipt total so a person can
    // find and void it.
    test.setTimeout(240_000);

    // NO BLUETOOTH PRINTER on this till — and this line is the whole reason
    // the test works at all.
    //
    // `printReceipt` (`pos/receipt-printer.ts`) calls
    // `navigator.bluetooth.requestDevice()`, which opens the browser's printer
    // CHOOSER. Headless Chromium exposes `navigator.bluetooth` and reports a
    // secure context, but has no UI to show a chooser in — so that promise
    // never settles, `handleSubmit` never reaches `clearCart()`, and the till
    // sits with a full basket and no toast. That looks exactly like a
    // double-charge bug (the sale IS already in the outbox by then) and it
    // cost an hour to rule out: on a real device the chooser appears, and a
    // cashier who cancels it hits the `NotFoundError` path, gets the
    // "printer unavailable" warning, and the cart clears.
    //
    // Deleting the API models a REAL configuration — a till with no BLE
    // printer paired — rather than papering over anything: `printReceipt`
    // then returns `{ ok: false, reason: 'unsupported' }` immediately, which
    // is the branch that till takes in production too.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    });

    const api = collectApiFailures(page);
    await login(page, CREW.kasir);
    await page.goto('/pos', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});

    // Open the shift only if there isn't one. On a live box a real cashier may
    // already be trading, and this must use their shift rather than fight it.
    const float = page.getByLabel(/Modal Awal Kas/i);
    if ((await float.count()) > 0) {
      await float.fill('100000');
      await float.blur();
      await page.getByRole('button', { name: 'Buka Kasir' }).click();
      await expect(float).toBeHidden({ timeout: 60_000 });
    }

    // ── the order ─────────────────────────────────────────────────────────
    const item = page.getByRole('button', { name: /^Kerupuk/ });
    await expect(item, 'the product grid never loaded, so nothing can be sold').toBeVisible({
      timeout: 60_000,
    });
    await item.click();

    // The cart has to show the line and a total, or "Lanjut ke Pembayaran"
    // would be taking an empty basket to the payment screen.
    await expect(page.getByRole('button', { name: 'Lanjut ke Pembayaran' })).toBeEnabled({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Lanjut ke Pembayaran' }).click();

    // ── the payment ───────────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Tunai' }).click();
    const received = page.getByLabel(/Uang Diterima/i);
    await expect(received).toBeVisible({ timeout: 30_000 });
    // Exact money, so "Kembalian" is Rp0 and no change has to be accounted for.
    await received.fill('3000');
    await received.blur();

    const finish = page.getByRole('button', { name: /Selesaikan/ });
    await expect(
      finish,
      'the sale cannot be completed — the finish button is not usable',
    ).toBeEnabled({ timeout: 30_000 });
    await finish.click();

    // ── it went through ───────────────────────────────────────────────────
    // AN EMPTY BASKET is the cashier's own signal that the sale is done and the
    // next customer can be served — `handleSubmit` calls `clearCart()` last,
    // after the fact is committed.
    //
    // NOT "the payment button disappeared", which is what this asserted first
    // and which cost an hour: that button stays rendered and merely goes
    // disabled once the cart empties, so the assertion failed on a sale that
    // had actually succeeded. The outbox had the fact in it the whole time.
    //
    // NOT "a row appeared in `sales`" either. This till is OFFLINE-FIRST: the
    // sale is committed to the local IndexedDB outbox and syncs afterwards, so
    // a database check straight after the click legitimately finds nothing and
    // would call a working till broken.
    // The basket is empty, so the payment button has nothing to take forward.
    // `handleSubmit` clears the cart LAST — after the fact is committed and the
    // receipt attempted — so an empty basket is the till's own confirmation.
    await expect(
      page.getByRole('button', { name: 'Lanjut ke Pembayaran' }),
      'the basket still holds the sale — the transaction did not complete',
    ).toBeDisabled({ timeout: 60_000 });

    await assertNoLoadFailure(page, 'kasir after completing a sale');
    await assertNoTechnicalError(page, 'kasir after completing a sale');
    expect(api.failures, 'completing a sale called something forbidden or failed').toEqual([]);

    // WHAT THIS HAS AND HAS NOT PROVEN, because the distinction matters when
    // this is pointed at a live outlet.
    //
    // PROVEN: the till accepted the order, took payment, committed a
    // `sales/completed` fact to its local outbox, and cleared the basket. That
    // is the cashier's whole interaction and every failure mode they can see.
    //
    // NOT PROVEN: that a row reached the server. This POS is offline-first —
    // the fact sits in IndexedDB until the sync engine pushes it — and each
    // Playwright run is a FRESH browser profile that is thrown away seconds
    // later. Run against production on 2026-09-01, the sale was committed
    // locally and the profile closed before sync; the dashboard's Sales tab
    // still read "Belum ada penjualan pada periode ini", i.e. nothing entered
    // the real books. Reassuring for a test, and a real gap in coverage:
    // asserting the server side needs this spec to wait for the outbox to
    // drain and then check as the owner. Until it does, do not read a pass
    // here as "a sale exists".
    console.log('[e2e] till accepted one cash sale of Rp3.000 (Kerupuk x1) into its local outbox');
  });
});
