import { test, expect, type Page } from '@playwright/test';
import { login, USERS } from './support/app';

/**
 * The gudang side of delivery: route planning and the live board.
 *
 * Gated on `delivery.sj.create`, which is kepala_gudang's — so these specs run
 * as the warehouse account (`USERS.kepalaGudang`), not owner. That distinction is itself worth encoding:
 * the owner can see the Surat Jalan and the map but deliberately cannot plan
 * the route, and a spec written as owner would have "proved" the planner was
 * missing.
 */

async function openFirstSuratJalan(page: Page) {
  await page.goto('/delivery');
  const rows = page.locator('table tbody tr');
  await expect(rows.first()).toBeVisible();

  const drawer = page.locator('[role="dialog"]');
  // The row is server-rendered, so a click landing before React hydrates hits
  // an element whose handler is not attached yet and does NOTHING — silently,
  // with no error. Same class as the login form submitting natively
  // pre-hydration; the difference is that the login button has an explicit
  // `disabled until hydrated` guard to wait on and this table has no such
  // signal. Retrying the open is therefore the honest wait.
  await expect(async () => {
    await rows.first().click();
    await expect(drawer).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 25_000 });
  // The drawer paints a "Memuat…" placeholder first and fills in from the
  // server a beat later. Reading `innerText()` before this settles returned the
  // loading state, which made status-dependent tests SKIP — a skip that means
  // "I looked too early" is worse than a failure, because it reads as
  // "not applicable" in the report.
  await expect(drawer).toContainText('Drop', { timeout: 20_000 });
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

    if (/Tidak ada truk dalam perjalanan/.test(await body.innerText())) {
      // A legitimate state, not a failure — assert it reads as such rather
      // than leaving a blank panel.
      await expect(page.locator('.leaflet-container')).toHaveCount(0);
      return;
    }

    // Leaflet is loaded through `next/dynamic` with `ssr: false`, so the
    // container appears a beat after the panel's own text. Counting
    // immediately raced the chunk download.
    await expect(page.locator('.leaflet-container')).toBeVisible({ timeout: 20_000 });
    // Tracking needs HTTPS (blocker B-14), so over plain HTTP every truck
    // reports no signal. Either is acceptable; a truck row is not.
    await expect(body).toContainText(/Belum ada sinyal lokasi|Terakhir/);
  });

  /**
   * The route planner is gated on `delivery.sj.create`, and this pair is what
   * proves the gate is a gate rather than a permanently-open or permanently-
   * shut door.
   *
   * It used to be a single test asserting the OWNER cannot plan, on the stated
   * premise that "`delivery.sj.create` is kepala_gudang's, not owner's". The
   * matrix says otherwise — `delivery.sj.create` is
   * `[OWN true, KGD true, SA true]` — because owner is an all-access role.
   * So the test demanded the opposite of the intended design and failed
   * against a correct app. (`route.controller.ts` carries the same "kepala
   * gudang only" slip in a comment; the matrix is the authority.)
   *
   * Manager is the subject that actually carries the intent: `delivery.read`
   * true, `delivery.sj.create` false — someone who genuinely can watch the
   * board and genuinely must not plan on it.
   */
  test('a manager can watch the board but cannot plan the route', async ({ page }) => {
    await login(page, USERS.manager);
    await page.goto('/delivery');
    await expect(page.getByRole('tab', { name: /Pantau Truk/ })).toBeVisible();

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Drop');
    await expect(drawer).not.toContainText('Rute & Petunjuk Pengiriman');
    // The editor's action, not just its heading: a heading can be renamed,
    // but a Save button rendered to someone who cannot save is the actual
    // defect this guards against.
    await expect(drawer.getByRole('button', { name: /Simpan Petunjuk/ })).toHaveCount(0);
  });

  test('an all-access role IS offered the planner — the gate is not shut for everyone', async ({
    page,
  }) => {
    // Without this half, deleting the planner outright would leave the
    // negative test above green, and "nobody can plan a route" would ship as
    // a passing suite.
    await login(page, USERS.owner);
    await page.goto('/delivery');

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    await rows.first().click();
    const drawer = page.locator('[role="dialog"]');
    await expect(drawer).toBeVisible();
    await expect(drawer).toContainText('Rute & Petunjuk Pengiriman');
  });
});
