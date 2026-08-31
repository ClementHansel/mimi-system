import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';
import { assertNoLoadFailure, assertNoTechnicalError } from './support/errors';

/**
 * The outlet-request round trip, end to end across TWO interfaces — the
 * question the owner actually asked on 2026-08-31 ("outlet request dateng nya
 * darimana ya?") plus the bug that answer exposed.
 *
 * The flow: an outlet raises a request in the OUTLET interface (`/outlet` →
 * Minta Barang), and the office reads it in the DASHBOARD interface
 * (`/purchasing` → Permintaan Outlet) and converts it to a PR. Those are two
 * different apps' worth of screens over one row, and the defect lived exactly
 * in the seam: the outlet screen showed "Air Mineral Botol · 1.000 pack" while
 * the office screen showed the same request as "0 item" and refused to convert
 * it. Neither screen alone looked wrong enough to notice.
 *
 * WRITES ARE OPT-IN. This suite can be pointed at production
 * (`E2E_BASE_URL=https://mimichicken.my.id`), where creating a replenishment
 * request would put a fake order into a real outlet's queue for a real
 * supervisor to approve. So the creating test runs only with
 * `E2E_ALLOW_WRITES=1`, and the read-only half — which is what would have
 * caught the "0 item" bug — always runs.
 */

const ALLOW_WRITES = process.env.E2E_ALLOW_WRITES === '1';
/** A seeded supervisor: `<slot>_<outlet>_<shift>` per `database/simulate-org.ts`. */
const SUPERVISOR = process.env.E2E_SUPERVISOR ?? 'spv_bpp01_p';

test.describe('Outlet to office: one request, two interfaces', () => {
  test('the outlet raises requests in its own interface, not in Pembelian', async ({ page }) => {
    await login(page, SUPERVISOR);
    await page.goto('/outlet', { waitUntil: 'domcontentloaded' });

    // The answer to "where do outlet requests come from": this screen, in the
    // outlet interface — with a create button, which `/purchasing` deliberately
    // does not have (the office must not author a request on an outlet's
    // behalf; see `OutletRequestsPanel`'s own header).
    await expect(page.getByRole('heading', { name: /Minta Barang/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /Buat Permintaan/i })).toBeVisible();
    await assertNoLoadFailure(page, '/outlet');
    await assertNoTechnicalError(page, '/outlet');
  });

  test('a request with lines in the outlet view has the same lines in the office view', async ({
    page,
  }) => {
    // READ-ONLY and therefore always on: it reconciles two screens over
    // whatever requests the box already has. This is the assertion that fails
    // on the pre-fix build, because the office list returned no lines at all.
    await login(page, USERS.owner);

    await page.goto('/purchasing', { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('tab', { name: /Permintaan Outlet/ })
      .first()
      .click();
    await page.waitForLoadState('networkidle').catch(() => {});

    const rows = page.locator('table tbody tr');
    const count = await rows.count();
    test.skip(count === 0, 'no submitted outlet requests on this box to reconcile');

    // Every listed request must report a non-zero item count. A request with
    // no lines cannot be submitted in the first place (`validateLines`
    // rejects an empty array), so a 0 here means the READ lost them.
    for (let i = 0; i < count; i++) {
      const requestNumber = (await rows.nth(i).locator('td').nth(0).innerText()).trim();
      const itemCount = (await rows.nth(i).locator('td').nth(2).innerText()).trim();
      expect(
        itemCount,
        `${requestNumber} lists 0 items, but an empty request cannot be submitted`,
      ).not.toBe('0');
    }
  });

  test('the CSV export writes one row per line, not one blank row per request', async ({
    page,
  }) => {
    // Same root cause, different symptom, and the one a screenshot cannot
    // show: `OutletRequestsPanel` exports one row per REQUEST LINE on purpose
    // ("what are the stores actually asking for"), so a lineless list wrote a
    // file of empty item cells.
    await login(page, USERS.owner);
    await page.goto('/purchasing', { waitUntil: 'domcontentloaded' });
    await page
      .getByRole('tab', { name: /Permintaan Outlet/ })
      .first()
      .click();
    await page.waitForLoadState('networkidle').catch(() => {});

    const rowCount = await page.locator('table tbody tr').count();
    test.skip(rowCount === 0, 'no submitted outlet requests on this box to export');

    const download = page.waitForEvent('download', { timeout: 30_000 });
    await page.getByRole('button', { name: /Ekspor CSV/i }).click();
    const file = await download;
    const stream = await file.createReadStream();
    const csv = await new Promise<string>((resolve, reject) => {
      let acc = '';
      stream.on('data', (chunk: unknown) => (acc += String(chunk)));
      stream.on('end', () => resolve(acc));
      stream.on('error', reject);
    });

    const lines = csv.trim().split(/\r?\n/);
    expect(lines.length, 'CSV has a header and at least one data row').toBeGreaterThan(1);
    // The item-name column must be populated on at least one data row. With
    // the bug, EVERY data row had it empty.
    const dataRows = lines.slice(1);
    const anyItemNamed = dataRows.some((row) => {
      const cells = row.split(',');
      return cells.slice(4).some((c) => c.replace(/"/g, '').trim() !== '');
    });
    expect(anyItemNamed, 'every exported row has an empty item — the lines were lost').toBe(true);
  });

  test.describe('creating a request (opt-in: E2E_ALLOW_WRITES=1)', () => {
    test.skip(!ALLOW_WRITES, 'writes disabled — this would create a real order on the target box');

    test('a request raised at the outlet appears in the office list with its items', async ({
      page,
      browser,
    }) => {
      await login(page, SUPERVISOR);
      await page.goto('/outlet', { waitUntil: 'domcontentloaded' });

      await page.getByRole('button', { name: /Buat Permintaan/i }).click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // The item picker is a NATIVE `<select>` (`ui/Select.tsx` says so, and
      // explains why it is not a custom listbox), so this drives it with
      // `selectOption` rather than click-then-pick-an-option. The first run of
      // this test guessed the latter and timed out on an invisible element —
      // worth recording, because the same wrong guess would silently apply to
      // every other form in the app.
      const itemSelect = dialog.getByLabel('Barang');
      const firstItemValue = await itemSelect
        .locator('option:not([value=""])')
        .first()
        .getAttribute('value');
      await itemSelect.selectOption(firstItemValue!);

      // `QtyInput` is an `inputMode="decimal"` text field, not a spinbutton.
      await dialog.getByLabel('Jumlah').fill('4');

      // `common.submit` is "Ajukan" here, not "Simpan".
      await dialog.getByRole('button', { name: 'Ajukan' }).click();

      // The new request must show its own line straight away, in the interface
      // that created it.
      await expect(dialog).toBeHidden({ timeout: 30_000 });
      const newRow = page.locator('table tbody tr').first();
      await expect(newRow).toBeVisible();
      const requestNumber = (await newRow.locator('td').nth(0).innerText()).trim();
      expect(requestNumber).toMatch(/^RR\//);

      // …and then the same row, read by the OFFICE, must agree about the count.
      //
      // A SECOND BROWSER CONTEXT, not a second `login()` on this page: the app
      // redirects an already-authenticated session away from `/login`, so the
      // helper's username field never appears and the switch times out. Two
      // contexts is also the honest shape of this scenario — two people at two
      // machines, which is the whole point of checking that they agree.
      const officeContext = await browser.newContext();
      const officePage = await officeContext.newPage();
      try {
        await login(officePage, USERS.owner);
        await officePage.goto('/purchasing', { waitUntil: 'domcontentloaded' });
        await officePage
          .getByRole('tab', { name: /Permintaan Outlet/ })
          .first()
          .click();

        const officeRow = officePage.locator('table tbody tr', { hasText: requestNumber });
        await expect(officeRow).toBeVisible({ timeout: 30_000 });
        // The bug, stated across the seam: the office counted 0 for a request
        // the outlet had just filled in.
        await expect(officeRow.locator('td').nth(2)).not.toHaveText('0');
      } finally {
        await officeContext.close();
      }
    });
  });
});
