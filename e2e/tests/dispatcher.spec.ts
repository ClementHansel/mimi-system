import { test, expect, type Page } from '@playwright/test';
import { login, USERS } from './support/app';

/**
 * The gudang side of delivery: route planning and the live board.
 *
 * Gated on `delivery.sj.create`, which is kepala_gudang's — so these specs run
 * as `kepalagudang1`, not owner. That distinction is itself worth encoding:
 * the owner can see the Surat Jalan and the map but deliberately cannot plan
 * the route, and a spec written as owner would have "proved" the planner was
 * missing.
 */

async function openFirstSuratJalan(page: Page) {
  await page.goto('/delivery');
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();
  await rows.first().click();
  const drawer = page.locator('[role="dialog"]');
  await expect(drawer).toBeVisible();
  return drawer;
}

test.describe('dispatcher — route planning', () => {
  test('the Surat Jalan detail shows each stop with a real address', async ({ page }) => {
    await login(page, USERS.kepalaGudang);
    const drawer = await openFirstSuratJalan(page);

    await expect(drawer).toContainText('Rute & Petunjuk Pengiriman');
    // The reported bug was that drops carried only name + city, so a driver
    // could not navigate. Assert the address actually reaches the client.
    await expect(drawer).toContainText(/Jl\./);
    // Coordinates present => the Navigate button and live map can work.
    await expect(drawer).toContainText('Koordinat tersedia');
  });

  test('a per-stop delivery brief round-trips', async ({ page }) => {
    await login(page, USERS.kepalaGudang);
    const drawer = await openFirstSuratJalan(page);

    const note = `E2E brief ${Date.now()} — masuk lewat gang samping`;
    // The LAST stop: earlier ones may already be completed, and a finished drop
    // is intentionally read-only (the backend refuses to rewrite its brief).
    const boxes = drawer.locator('textarea');
    await expect(boxes.first()).toBeVisible();
    const target = boxes.last();
    test.skip(await target.isDisabled(), 'every stop on this trip is already completed');

    await target.fill(note);
    await drawer.getByRole('button', { name: /Simpan (Rute|Petunjuk)/ }).click();
    await expect(drawer).toContainText(note);

    // Reopen from the server to prove it persisted rather than merely painting.
    await page.keyboard.press('Escape');
    const reopened = await openFirstSuratJalan(page);
    await expect(reopened).toContainText(note);
  });

  test('the route order is locked once the trip is under way', async ({ page }) => {
    await login(page, USERS.kepalaGudang);
    const drawer = await openFirstSuratJalan(page);

    const status = (await drawer.innerText()).replace(/\s+/g, ' ');
    test.skip(
      !/Dalam Perjalanan|Dimuat/.test(status),
      'this trip is still draft/ready, so reordering is legitimately open',
    );

    await expect(drawer).toContainText('Urutan rute terkunci');
    // Briefs stay editable while the order is locked — that is what the locked
    // notice promises, and it was false when first written.
    await expect(drawer.locator('textarea').last()).toBeEnabled();
  });
});

test.describe('dispatcher — live board', () => {
  test('renders the map and lists trucks in transit', async ({ page }) => {
    await login(page, USERS.kepalaGudang);
    await page.goto('/delivery');

    await page.getByRole('tab', { name: /Pantau Truk/ }).click();

    const body = page.locator('body');
    await expect(body).toContainText('Pantau Truk');

    const hasMap = await page.locator('.leaflet-container').count();
    const empty = await body.innerText();
    if (/Tidak ada truk dalam perjalanan/.test(empty)) {
      // A legitimate state, not a failure — assert it reads as such rather
      // than leaving a blank panel.
      expect(hasMap, 'no trucks in transit; the empty state should stand alone').toBe(0);
      return;
    }

    expect(hasMap, 'a truck is in transit so the map must render').toBeGreaterThan(0);
    // Tracking needs HTTPS (blocker B-14), so over plain HTTP every truck
    // reports no signal. Either is acceptable; a truck row is not.
    await expect(body).toContainText(/Belum ada sinyal lokasi|Terakhir/);
  });

  test('owner can watch the board but cannot plan the route', async ({ page }) => {
    await login(page, USERS.owner);
    await page.goto('/delivery');
    await expect(page.getByRole('tab', { name: /Pantau Truk/ })).toBeVisible();

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Drop');
    // `delivery.sj.create` is kepala_gudang's, not owner's.
    await expect(drawer).not.toContainText('Rute & Petunjuk Pengiriman');
  });
});
