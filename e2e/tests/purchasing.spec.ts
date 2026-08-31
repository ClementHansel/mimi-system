import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';
import {
  assertNoLoadFailure,
  assertNoTechnicalError,
  TECHNICAL_VOCABULARY,
} from './support/errors';

/**
 * The four defects the owner found by hand on mimichicken.my.id on
 * 2026-08-31, one test each. Every one lived on a screen with unit-test
 * coverage and passed CI, because each needed a real Postgres and a real
 * click to show itself:
 *
 *  1. Supplier search 500'd on every query — the SQL built a `$0` placeholder,
 *     which Postgres has no such thing as. The tab said "Gagal memuat data".
 *  2. A duplicate supplier code toasted the driver's own words:
 *     `duplicate key value violates unique constraint "suppliers_code_key"`.
 *  3. Permintaan Outlet listed a real request as "0 item"…
 *  4. …and its "Jadikan PR" modal said «Permintaan ini tidak punya item.»,
 *     so a request that existed could not be converted.
 *
 * These run as OWNER because owner is all-access: a failure here is the
 * feature being broken, never a permission gate. `role-journeys.spec.ts` is
 * where gates are asserted.
 */

test.describe('Pembelian — the surfaces the 2026-08-31 bug report covered', () => {
  test.beforeEach(async ({ page }) => {
    await login(page, USERS.owner);
    await page.goto('/purchasing', { waitUntil: 'domcontentloaded' });
  });

  test('searching suppliers returns rows, not "Gagal memuat data"', async ({ page }) => {
    await page
      .getByRole('tab', { name: /Supplier/ })
      .first()
      .click();

    const search = page.getByPlaceholder(/Cari kode atau nama supplier/i);
    await expect(search).toBeVisible();

    // The demo data seeds suppliers whose names all contain "CV"/"PT"/"Toko";
    // 'a' is the least assuming query that still has to match something, and
    // the bug fired on ANY non-empty `q`, so the term barely matters.
    await search.fill('a');

    // The failure mode was an error empty-state where the table should be.
    // Asserting the absence of that is the regression; asserting a specific
    // supplier name would couple this spec to seed contents.
    await expect(page.getByText('Gagal memuat data')).toHaveCount(0);
    await expect(page.locator('table tbody tr').first()).toBeVisible();

    // And a query that genuinely matches nothing must say "empty", never "failed".
    await search.fill('zzzzzzzznotasupplier');
    await expect(page.getByText('Gagal memuat data')).toHaveCount(0);
  });

  // A WRITE ATTEMPT, so it is opt-in like every other write in this suite.
  // It is meant to be REFUSED — nothing should be created — but that is
  // precisely the thing under test: if the refusal ever regresses, this test
  // creates a junk supplier on whatever box it is pointed at, and one of those
  // boxes is production. `E2E_ALLOW_WRITES=1` is set for the demo box, not prod.
  test('a duplicate supplier code is refused in Indonesian, naming the field', async ({ page }) => {
    test.skip(
      process.env.E2E_ALLOW_WRITES !== '1',
      'writes disabled — a regressed refusal would create a supplier on the target box',
    );

    await page
      .getByRole('tab', { name: /Supplier/ })
      .first()
      .click();

    // Read an EXISTING code off the table rather than hardcoding one — the
    // point is "a code already in use", which the first row always is.
    //
    // Wait for the cell to have TEXT, not merely to exist. Reading it straight
    // after the tab click returned '' on the first run of this spec: the row
    // was mounted and empty for an instant while the fetch settled, so the
    // test failed against a perfectly healthy app. `toHaveText(/\S/)` retries
    // until it is populated, which is the difference between testing the app
    // and testing the scheduler.
    const codeCell = page.locator('table tbody tr td').first();
    await expect(codeCell).toHaveText(/\S/, { timeout: 30_000 });
    const existingCode = (await codeCell.innerText()).trim();
    expect(existingCode).not.toBe('');

    await page.getByRole('button', { name: /Tambah Supplier/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/Kode Supplier/i).fill(existingCode);
    await dialog.getByLabel(/Nama Supplier/i).fill('Duplikat E2E');
    await dialog.getByRole('button', { name: /^Simpan$/ }).click();

    // The refusal has to arrive, say which field, and contain no schema words.
    const toast = page.getByText(/sudah dipakai/i).first();
    await expect(toast).toBeVisible();
    await expect(toast).toContainText(/Kode/i);
    await assertNoTechnicalError(page);
  });

  test('Permintaan Outlet shows the real item count, not 0', async ({ page }) => {
    await page
      .getByRole('tab', { name: /Permintaan Outlet/ })
      .first()
      .click();

    const firstRow = page.locator('table tbody tr').first();
    // Skip rather than fail on a box with no submitted requests: an empty
    // Permintaan Outlet is a legitimate state of the demo data, and a spec
    // that fails on it would be reporting the seed, not the bug.
    const rowCount = await page.locator('table tbody tr').count();
    test.skip(rowCount === 0, 'no submitted outlet requests on this box to count items for');

    // `Jumlah Item` is the column that read 0 for every request, because the
    // list endpoint returned each row with no lines at all.
    const itemCountCell = firstRow.locator('td').nth(2);
    await expect(itemCountCell).not.toHaveText('0');
  });

  test('"Jadikan PR" lists the items it is about to copy', async ({ page }) => {
    await page
      .getByRole('tab', { name: /Permintaan Outlet/ })
      .first()
      .click();

    const rowCount = await page.locator('table tbody tr').count();
    test.skip(rowCount === 0, 'no submitted outlet requests on this box to convert');

    await page
      .getByRole('button', { name: /Jadikan PR/i })
      .first()
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    // The exact sentence from the owner's screenshot. Its presence meant a
    // real request could not be converted at all.
    await expect(dialog.getByText('Permintaan ini tidak punya item.')).toHaveCount(0);
    await expect(dialog.getByText(/·\s*0 item/)).toHaveCount(0);
  });
});

/**
 * The generalisation of defect #2, and the reason it is worth its own test:
 * `ApiErrorShape.message` is DEVELOPER text (CONTRACTS §0), so any screen that
 * prints it can leak SQL, table names or English at a user. This walks the
 * module's tabs and asserts none of that vocabulary is on screen — a guard
 * that keeps working as new screens arrive, unlike a per-toast assertion.
 */
test.describe('Pembelian — no technical vocabulary reaches the screen', () => {
  test('every tab renders without database words', async ({ page }) => {
    await login(page, USERS.owner);
    await page.goto('/purchasing', { waitUntil: 'domcontentloaded' });

    const TABS = [
      /Permintaan Outlet/,
      /Permintaan Pembelian/,
      /Purchase Order/,
      /Supplier/,
      /Riwayat Harga Supplier/,
    ];
    for (const tab of TABS) {
      // `.click()` with no count guard, deliberately. An earlier version did
      // `if (count === 0) continue`, which meant a renamed or missing tab made
      // this test pass having asserted nothing at all — the same vacuous-pass
      // hole that made the surface sweep skip all nine of its tabbed areas.
      // If a tab is gone, this must fail and name it.
      const trigger = page.getByRole('tab', { name: tab }).first();
      await expect(trigger, `Pembelian lost its ${String(tab)} tab`).toBeVisible({
        timeout: 20_000,
      });
      await trigger.click();
      await page.waitForLoadState('networkidle').catch(() => {});
      await assertNoLoadFailure(page, `tab ${String(tab)}`);
      await assertNoTechnicalError(page, `tab ${String(tab)}`);
    }
  });

  test('the guard itself notices technical text', async ({ page }) => {
    // A negative test for the assertion, so a broken matcher cannot make every
    // spec above pass silently — the failure mode that makes a sweep worthless.
    //
    // No login and no navigation: this tests the MATCHER against a page whose
    // content we control, so it stays meaningful even on a box where the app
    // is down. (It first shipped with a `login()` call, which coupled a pure
    // assertion test to the whole stack for no reason.)
    await page.setContent(
      `<main>duplicate key value violates unique constraint "suppliers_code_key"</main>`,
    );
    await expect(assertNoTechnicalError(page)).rejects.toThrow(/duplicate key/i);

    // …and does NOT fire on ordinary Indonesian copy, or it would be switched
    // off within a week.
    await page.setContent(`<main>Kode "SUP001" sudah dipakai. Gunakan yang lain.</main>`);
    await assertNoTechnicalError(page);

    expect(TECHNICAL_VOCABULARY.length).toBeGreaterThan(5);
  });
});
