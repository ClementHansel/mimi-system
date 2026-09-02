import { test, expect, type Page } from '@playwright/test';
import { login, USERS } from './support/app';
import { ALLOW_WRITES } from './support/crew';
import { assertNoLoadFailure, assertNoTechnicalError, collectApiFailures } from './support/errors';
import { choose } from './support/dialogs';

/**
 * THE OFFICE'S BUYING CHAIN: a purchase request becomes a purchase order.
 *
 * This is how money actually leaves the business — a PR is raised, approved,
 * and converted into a PO that a supplier fills. It is also the last of the
 * three flows the owner authorised for live testing that had never been driven
 * end to end, and the one with the most steps between "someone asked" and
 * "someone will be paid".
 *
 * The read-only half always runs: that the buyer's two tabs load, list real
 * document numbers, and speak Indonesian is worth asserting on every box.
 * Creating a PR and converting one to a PO are real writes — a PO is an order
 * a supplier can be sent — so they are gated on `E2E_ALLOW_WRITES=1` and live
 * on the ephemeral CI stack.
 */

/** Opens `/purchasing` and selects a tab by its visible name. */
async function openTab(page: Page, name: RegExp): Promise<void> {
  await page.goto('/purchasing', { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.getByRole('tab', { name }).first().click();
  await page.waitForLoadState('networkidle').catch(() => {});
  // The panel's own table paints after the tab does.
  await page.waitForTimeout(1_500);
}

test.describe('The buyer opens their tabs', () => {
  test('purchase requests list real numbers and statuses', async ({ page }) => {
    const api = collectApiFailures(page);
    await login(page, USERS.owner);
    await openTab(page, /Permintaan Pembelian/);

    const rows = page.locator('table tbody tr');
    if ((await rows.count()) > 0) {
      // A PR without its own number is a document nobody can refer to in a
      // conversation with a supplier.
      await expect(rows.first().locator('td').first()).toHaveText(/^PR\//, { timeout: 30_000 });
    }

    await assertNoLoadFailure(page, '/purchasing → Permintaan Pembelian');
    await assertNoTechnicalError(page, '/purchasing → Permintaan Pembelian');
    expect(api.failures, 'the PR tab called something forbidden').toEqual([]);
  });

  test('purchase orders list real numbers', async ({ page }) => {
    const api = collectApiFailures(page);
    await login(page, USERS.owner);
    await openTab(page, /Purchase Order/);

    const rows = page.locator('table tbody tr');
    if ((await rows.count()) > 0) {
      await expect(rows.first().locator('td').first()).toHaveText(/^PO\//, { timeout: 30_000 });
    }

    await assertNoLoadFailure(page, '/purchasing → Purchase Order');
    await assertNoTechnicalError(page, '/purchasing → Purchase Order');
    expect(api.failures, 'the PO tab called something forbidden').toEqual([]);
  });
});

test.describe('Raising a request and turning it into an order (opt-in)', () => {
  test.skip(!ALLOW_WRITES, 'writes disabled — a PO is an order a supplier can be sent');

  test('a purchase request can be raised from the office', async ({ page }) => {
    test.setTimeout(240_000);
    const api = collectApiFailures(page);
    await login(page, USERS.owner);
    await openTab(page, /Permintaan Pembelian/);

    await page.getByRole('button', { name: 'Buat Permintaan', exact: true }).click();
    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // Forms here mix TWO kinds of picker — native `<select>` and the custom
    // `SearchableSelect` combobox — and both fetch their options. `choose`
    // handles either and waits for the list, which is what a flow spec should
    // not have to know or re-learn per form.
    expect(
      await choose(dialog, /Tujuan Pengiriman/),
      'the form offered no warehouse to deliver to',
    ).toBeTruthy();
    expect(await choose(dialog, 'Item'), 'the form offered no item to request').toBeTruthy();

    // `QtyInput`/`MoneyInput` commit on BLUR, not on keystroke — fill then blur
    // or the form's state stays empty and Simpan stays disabled.
    const qty = dialog.getByLabel('Jumlah').first();
    await qty.fill('2');
    await qty.blur();

    const price = dialog.getByLabel(/Estimasi Harga/).first();
    await price.fill('15000');
    await price.blur();

    const save = dialog.getByRole('button', { name: 'Simpan', exact: true });
    await expect(save, 'the PR form would not accept a warehouse, an item and a price').toBeEnabled(
      { timeout: 30_000 },
    );
    await save.click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    // The new request is at the top of the list, with a number of its own.
    const firstCell = page.locator('table tbody tr').first().locator('td').first();
    await expect(firstCell).toHaveText(/^PR\//, { timeout: 30_000 });
    const prNumber = (await firstCell.innerText()).trim();
    console.log(`[e2e] created purchase request ${prNumber}`);

    await assertNoLoadFailure(page, 'after creating a PR');
    await assertNoTechnicalError(page, 'after creating a PR');
    expect(
      api.failures.filter((f) => /^5\d\d /.test(f)),
      'creating a PR caused a server error',
    ).toEqual([]);
  });

  test('an approved request converts into a purchase order', async ({ page }) => {
    test.setTimeout(240_000);
    const api = collectApiFailures(page);
    await login(page, USERS.owner);
    await openTab(page, /Permintaan Pembelian/);

    // Only an APPROVED request may become an order — buying against one nobody
    // has agreed to is the whole reason the approval step exists. A box with
    // none is a legitimate state of the seed, not a regression.
    const approved = page.locator('table tbody tr', { hasText: 'Disetujui' }).first();
    const count = await approved.count();
    test.skip(count === 0, 'no approved purchase request on this box to convert');

    const prNumber = (await approved.locator('td').first().innerText()).trim();
    await approved.locator('td').first().click();

    const convert = page.getByRole('button', { name: 'Buat PO dari PR ini', exact: true });
    await expect(convert, `${prNumber} offered no way to become an order`).toBeVisible({
      timeout: 30_000,
    });
    await convert.click();

    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 30_000 });

    // THE POINT OF THE CONVERSION: the order arrives carrying the request's own
    // lines, so nobody retypes them. Asserting the link back to the PR is what
    // makes "which request is this order answering" answerable afterwards.
    await expect(dialog, 'the order does not say which request it came from').toContainText(
      prNumber,
    );
    await expect(
      dialog.getByLabel('Harga Satuan').first(),
      'the order arrived with no priced line — the request lines did not carry over',
    ).toBeVisible();

    // Supplier is the one thing a PR does not decide, so it is the one thing
    // the buyer must choose here.
    expect(
      await choose(dialog, 'Supplier'),
      'no supplier could be chosen for the order',
    ).toBeTruthy();

    const save = dialog.getByRole('button', { name: 'Simpan', exact: true });
    await expect(save).toBeEnabled({ timeout: 30_000 });
    await save.click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    await assertNoLoadFailure(page, 'after converting a PR to a PO');
    await assertNoTechnicalError(page, 'after converting a PR to a PO');

    // And the order really exists, on the tab where orders live.
    await openTab(page, /Purchase Order/);
    const poCell = page.locator('table tbody tr').first().locator('td').first();
    await expect(poCell, 'no purchase order appeared after the conversion').toHaveText(/^PO\//, {
      timeout: 30_000,
    });
    console.log(`[e2e] converted ${prNumber} into ${(await poCell.innerText()).trim()}`);

    expect(
      api.failures.filter((f) => /^5\d\d /.test(f)),
      'converting a PR caused a server error',
    ).toEqual([]);
  });
});
