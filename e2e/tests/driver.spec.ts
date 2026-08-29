import { test, expect } from '@playwright/test';
import { expectLandsOn, login, USERS } from './support/app';

/**
 * The driver's mobile surface. Runs on a phone viewport (see the `mobile`
 * project in playwright.config.ts) because that is the only device this
 * surface targets — BUILD-PLAN §4.3.
 *
 * The stop card is the thing that was broken: the delivery query never
 * selected `address`/`latitude`/`longitude`, so a driver got "Outlet Loa
 * Janan, Samarinda" and no way to navigate to it, on data that was present in
 * the database all along.
 */

/**
 * Does this driver actually have a trip dated today?
 *
 * Waits for the list to RESOLVE first. `my-jobs` is fetched after mount, so
 * reading the body immediately saw neither a job nor the empty state and every
 * caller skipped — silently reporting "not applicable" when the real answer was
 * "not loaded yet".
 */
async function hasJobToday(page: import('@playwright/test').Page): Promise<boolean> {
  const settled = page.locator('body');
  await expect(settled).toContainText(/SJ\/|Tidak ada Surat Jalan untuk hari ini/, {
    timeout: 20_000,
  });
  const text = (await settled.innerText()).replace(/\s+/g, ' ');
  return !/Tidak ada Surat Jalan untuk hari ini/.test(text);
}

test.describe('driver job list', () => {
  test('a driver reaches their own job list from the hub', async ({ page }) => {
    await login(page, USERS.driver);
    // This asserted `expectLandsOn(page, '/driver')` on the premise that
    // "drivers are redirected past the hub — it belongs to owner/superadmin".
    // Neither half is true any more: the hub is everyone's landing page since
    // the owner asked for the "where do you want to work today" launchpad
    // (F-BRAND, see the login page), and a driver reaches two interfaces —
    // the job list and their own account — so nothing redirects them past it.
    await expectLandsOn(page, '/');

    // What actually matters for a driver on a phone is that the job list is
    // ONE tap from where they land, so follow the link rather than calling
    // `page.goto('/driver')`: a route that only opens when typed by hand is
    // not reachable for someone holding a scooter helmet.
    await page.locator('a[href="/driver"]').first().click();
    await expectLandsOn(page, '/driver');
    await expect(page.locator('body')).toContainText('Surat Jalan Hari Ini');
  });

  test("today's stops show an address and a working navigation link", async ({ page }) => {
    await login(page, USERS.driver);
    await page.goto('/driver');
    await expect(page.locator('body')).toContainText('Surat Jalan Hari Ini');

    test.skip(
      !(await hasJobToday(page)),
      'no Surat Jalan dated today for this driver — re-run `pnpm db:seed`, which rolls the demo trip forward',
    );

    const body = page.locator('body');
    // The three things the driver could not previously see.
    await expect(body).toContainText(/Jl\./);
    await expect(page.getByRole('link', { name: /Navigasi/ }).first()).toBeVisible();

    const href = await page.locator('a[href*="google.com/maps/dir"]').first().getAttribute('href');
    expect(href, 'Navigate must deep-link to a real destination').toMatch(
      /destination=-?\d+\.\d+%2C-?\d+\.\d+/,
    );
    // Opens the phone's map app rather than replacing the PWA, which would
    // drop any offline-queued actions the driver is carrying.
    const target = await page
      .locator('a[href*="google.com/maps/dir"]')
      .first()
      .getAttribute('target');
    expect(target).toBe('_blank');
  });

  test('a delivery brief written by gudang is visible to the driver', async ({ page }) => {
    await login(page, USERS.driver);
    await page.goto('/driver');
    test.skip(!(await hasJobToday(page)), 'no Surat Jalan dated today for this driver');

    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    test.skip(
      !/Petunjuk Pengiriman/i.test(text),
      'no stop on this trip carries a brief — dispatcher.spec.ts writes one',
    );
    await expect(page.locator('body')).toContainText(/Petunjuk Pengiriman/i);
  });

  test('location sharing state is stated plainly, never left ambiguous', async ({
    page,
    baseURL,
  }) => {
    await login(page, USERS.driver);
    await page.goto('/driver');
    test.skip(!(await hasJobToday(page)), 'no Surat Jalan dated today for this driver');

    const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
    const inTransit = /Dalam Perjalanan/.test(text);
    test.skip(!inTransit, 'tracking only runs while a trip is in transit');

    // Over HTTP (blocker B-14) the browser refuses geolocation outright, so the
    // honest states are "sharing" or "permission denied" — never silence. A
    // driver who cannot tell which one they are in is the actual hazard:
    // dispatch reads a missing position as a broken-down truck.
    const isHttps = (baseURL ?? '').startsWith('https://');
    if (isHttps) {
      expect(text).toMatch(/Lokasi sedang dibagikan|Izin lokasi ditolak/);
    } else {
      expect(text, 'insecure origin: the driver must be told tracking is off').toMatch(
        /Izin lokasi ditolak|tidak mendukung pelacakan lokasi/,
      );
    }
  });
});
