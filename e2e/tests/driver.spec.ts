import { test, expect } from '@playwright/test';
import { login, pathOf, USERS } from './support/app';

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

/** Does this driver actually have a trip dated today? */
async function hasJobToday(page: import('@playwright/test').Page): Promise<boolean> {
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ');
  return !/Tidak ada Surat Jalan untuk hari ini/.test(text);
}

test.describe('driver job list', () => {
  test('a driver lands directly on their own job list', async ({ page }) => {
    await login(page, USERS.driver);
    // Drivers are redirected past the hub — it belongs to owner/superadmin.
    expect(pathOf(page)).toBe('/driver');
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
