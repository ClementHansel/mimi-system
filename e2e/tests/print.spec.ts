import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';

/**
 * W5-05 — the printable documents.
 *
 * These are verified through the BUTTONS that reach them, not by visiting the
 * URLs directly: a print route nobody can navigate to is not a feature, and
 * the payslip button in particular was previously dead (gated on a
 * `slipPdfUrl` the backend hardcodes to null), which is exactly the failure
 * this spec exists to catch if it returns.
 *
 * The print DIALOG itself is deliberately not driven — Playwright cannot
 * meaningfully assert on the OS print sheet, and `window.print()` would block
 * the run. What is asserted is that the document renders, with the content a
 * paper delivery note or payslip is useless without.
 */

test.describe('printable documents', () => {
  test('the Surat Jalan opens as a signable delivery note', async ({ page, context }) => {
    await login(page, USERS.kepalaGudang);
    await page.goto('/delivery');

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    const drawer = page.locator('[role="dialog"]');
    await expect(async () => {
      await rows.first().click();
      await expect(drawer).toBeVisible({ timeout: 3_000 });
    }).toPass({ timeout: 25_000 });
    await expect(drawer).toContainText('Drop', { timeout: 20_000 });

    // The button opens a new tab (target=_blank) so the dispatcher does not
    // lose the drawer they were working in.
    const [printPage] = await Promise.all([
      context.waitForEvent('page'),
      drawer
        .getByRole('link', { name: /Surat Jalan/ })
        .first()
        .click(),
    ]);
    await printPage.waitForLoadState('domcontentloaded');

    await expect(printPage).toHaveURL(/\/print\/surat-jalan\//);
    const body = printPage.locator('body');

    // Letterhead + document identity.
    await expect(body).toContainText('Mimi Chicken OS');
    await expect(body).toContainText(/SJ\//);
    // The things that make it a delivery note rather than a screenshot:
    // a destination, what was sent, and somewhere to sign.
    await expect(body).toContainText(/Jl\./);
    await expect(body).toContainText('Dikirim');
    await expect(body).toContainText('Diterima');
    await expect(body).toContainText('Penerima di Outlet');
    // Chromeless: the app shell must not print with the document.
    await expect(printPage.locator('aside')).toHaveCount(0);

    await printPage.close();
  });

  test('an employee can obtain their own payslip', async ({ page, context }) => {
    // Owner has an employee record and therefore payslips; `superadmin`
    // deliberately does not (it is a technical account, kept out of payroll).
    await login(page, USERS.owner);
    await page.goto('/me');

    const body = page.locator('body');
    await expect(body).toContainText(/Slip Gaji|Akun Saya/, { timeout: 20_000 });

    // The panel lists each period collapsed; the print button only exists
    // inside an expanded slip. Expand the first one before looking for it —
    // the original spec skipped here and reported "no payslip", which was the
    // test not clicking rather than the data being absent.
    const slipRows = page.locator('button', { hasText: /^\d{4}-\d{2}$/ });
    if ((await slipRows.count()) === 0) {
      test.skip(true, 'no payslip listed for this account/year');
    }
    await slipRows.first().click();

    const slipLink = page.locator('a[href^="/print/slip-gaji/"]');
    await expect(slipLink.first()).toBeVisible({ timeout: 10_000 });

    const [printPage] = await Promise.all([context.waitForEvent('page'), slipLink.first().click()]);
    await printPage.waitForLoadState('domcontentloaded');

    await expect(printPage).toHaveURL(/\/print\/slip-gaji\//);
    const slipBody = printPage.locator('body');
    await expect(slipBody).toContainText('Slip Gaji');
    await expect(slipBody).toContainText('Pendapatan');
    await expect(slipBody).toContainText('Potongan');
    await expect(slipBody).toContainText('Gaji Bersih');

    await printPage.close();
  });

  test('a printable document still requires a session', async ({ page }) => {
    // `/print` is chromeless, which is a rendering decision — it must not have
    // become an auth hole. A payslip is the most sensitive document here.
    await page.goto('/print/slip-gaji/2026-08');
    await expect(page).toHaveURL(/\/login$/);
  });
});
