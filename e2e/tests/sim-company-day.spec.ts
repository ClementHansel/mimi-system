import { test, expect, type Browser, type Locator, type Page } from '@playwright/test';
import { login } from './support/app';
import { ALLOW_WRITES, CREW, CREW_OUTLET } from './support/crew';
import { assertNoLoadFailure, assertNoTechnicalError } from './support/errors';
import { Journal } from './support/journal';

/**
 * ONE WORKING DAY AT MIMI CHICKEN, END TO END, THROUGH THE UI.
 *
 * Every other spec in this suite asks whether one screen or one hand-off is
 * correct. This one asks the question the owner actually asks before trusting
 * the product with a business: *if a real crew turned up tomorrow and did their
 * jobs, which parts of this would work?*
 *
 * So it is a simulation, not an assertion suite. Nine real accounts, each in
 * their own browser context because each is a different human at a different
 * screen, walk the whole operation in the order the business runs it:
 *
 *   head office sets up master data
 *        ↓
 *   the outlet asks for stock → supervisor approves → gudang approves
 *        ↓
 *   gudang builds, loads and dispatches a Surat Jalan
 *        ↓
 *   the driver runs the drops → the outlet receives the goods
 *        ↓
 *   the till trades all day and closes its shift
 *        ↓
 *   the outlet counts, writes off, returns, and logs its petty cash
 *        ↓
 *   the office turns what gudang cannot fill into a PR, then a PO, and
 *   receives it; finance pays for it; HR runs the people side
 *
 * WHY IT DOES NOT STOP AT THE FIRST FAILURE. A red assertion on step three
 * would leave the other eighty-odd steps unknown, and "we do not know" is the
 * one answer this exercise must not produce. Every step goes through
 * `Journal`, which records pass / fail / blocked and carries on, so the run
 * yields a map of the whole operation. `blocked` is deliberately distinct from
 * `fail`: "receiving was never exercised because nothing got dispatched" and
 * "receiving is broken" are different findings and must not be added together.
 *
 * WHY IT DISCOVERS RATHER THAN HARD-CODES the later steps of a document's
 * life. A Surat Jalan goes draft → ready → loading → dispatched behind three
 * differently-labelled buttons, and a driver's drop has its own. Scripting
 * exact labels makes the spec fail when the copy changes, which reports a
 * translation as a broken warehouse. Instead it reads what the screen offers,
 * clicks the action that advances the document, and RECORDS which one it
 * found — so the report says what the app actually did.
 *
 * IT WRITES. That is the point — a shift that opens no shift proves nothing —
 * so it is gated on `E2E_ALLOW_WRITES=1` like every other writing spec here,
 * and belongs on a demo or local box, never on production. Everything it
 * creates is marked `E2E` or `SIM` where the form has anywhere to put a label.
 */

test.describe.configure({ mode: 'serial' });

/** Balikpapan Kota's own coordinates — attendance is geofenced, and a person clocking in is standing at their outlet. */
const OUTLET_GEO = { latitude: -1.217862, longitude: 116.83465 };
/** Gudang Pusat Balikpapan, for the warehouse crew and the driver's departure. */
const GUDANG_GEO = { latitude: -1.2379, longitude: 116.8529 };

const TODAY = new Date().toISOString().slice(0, 10);
const RUN = `SIM${Date.now().toString().slice(-6)}`;

/**
 * Pushes each run's leave request onto its own days.
 *
 * `leave_requests` refuses a range overlapping one the same person already
 * has — correctly — so a fixed date pair passes once and is rejected by every
 * run after it, which reads as a broken form.
 */
const LEAVE_OFFSET_MS = (Date.now() % 90) * 86_400_000;

/** Carried between tests — this file is `serial`, so one worker runs them in order. */
const state: {
  replenishment?: string;
  suratJalan?: string;
  purchaseRequest?: string;
  voucherBatch?: string;
  supplierCode?: string;
} = {};

// ── people ────────────────────────────────────────────────────────────────

interface Person {
  page: Page;
  close: () => Promise<void>;
}

/**
 * Signs somebody in on their own context.
 *
 * A separate context per person is not tidiness: the app redirects an
 * authenticated session away from `/login`, so "become someone else" on the
 * same page hangs rather than failing, and every later step then reports the
 * wrong person's permissions.
 */
async function personAt(
  browser: Browser,
  username: string,
  opts: { geo?: { latitude: number; longitude: number }; mobile?: boolean } = {},
): Promise<Person> {
  const context = await browser.newContext({
    ...(opts.mobile
      ? { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true }
      : {}),
    // Granted, and pinned to the workplace. Attendance refuses to record
    // without a fix ("Izin lokasi ditolak — aktifkan GPS untuk absen"), and a
    // browser with no geolocation would report a working geofence as broken.
    ...(opts.geo ? { permissions: ['geolocation'], geolocation: opts.geo } : {}),
  });
  const page = await context.newPage();
  await login(page, username);
  return { page, close: () => context.close() };
}

// ── small UI helpers, each earning its place ──────────────────────────────

/** Lands on `route` and waits for the fetches behind it to settle. */
async function open(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: 'domcontentloaded' });
  await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
}

/** Everything clickable on screen right now — the context a failure needs to be actionable. */
async function actions(scope: Page | Locator): Promise<string[]> {
  const labels = await scope
    .locator('button:visible')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').replace(/\s+/g, ' ').trim()));
  return [...new Set(labels.filter((l) => l.length > 0 && l.length < 50))];
}

/**
 * Clicks the one button matching `name`, and fails with what the screen DID
 * offer rather than an anonymous timeout.
 *
 * IT WAITS FIRST, and that is the whole point. Every detail surface here
 * hydrates its document AFTER the shell paints, so asking `count()` the
 * instant a navigation resolves reports "there is no Setujui button" about a
 * page that grows one a moment later. That single missing wait reported the
 * approval engine as broken and blocked eight downstream steps behind it.
 */
async function clickOne(
  scope: Page | Locator,
  name: RegExp,
  what: string,
  timeout = 20_000,
): Promise<string> {
  const button = scope.getByRole('button', { name }).first();
  const appeared = await button
    .waitFor({ state: 'visible', timeout })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    throw new Error(`no ${what} button here — offered: ${(await actions(scope)).join(' | ')}`);
  }
  const label = ((await button.textContent()) ?? '').trim();
  await button.click();
  return label;
}

/**
 * Closes anything left open before the next step starts.
 *
 * A step that fails mid-dialog leaves it on screen, and its overlay then eats
 * the first click of every step after it — so one real failure was reported as
 * four, three of them on features that were fine. Recovery belongs between
 * steps, not inside each one.
 */
async function dismissDialogs(page: Page): Promise<void> {
  for (let i = 0; i < 3; i++) {
    if ((await page.getByRole('dialog').count()) === 0) return;
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(500);
  }
}

/**
 * `j.step`, with the screen tidied first. Bound to one person's page so a
 * phase reads as a list of things that person did.
 */
function stepsOn(j: Journal, page: Page) {
  return <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> =>
    j.step(name, async () => {
      await dismissDialogs(page);
      return fn();
    });
}

/**
 * `MoneyInput` parses its draft on BLUR, not on keystroke. Filling and
 * clicking submit in one breath leaves the form's state empty and its button
 * disabled — which reads exactly like a broken button.
 */
async function money(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.blur();
}

/**
 * Fills a `QtyInput` and commits it.
 *
 * It is an `inputMode="decimal"` TEXT box that parses its draft on blur, like
 * `MoneyInput`. Fill it and submit in one breath and the line still reads
 * `qty: null`, so the form filters it out as incomplete and `submit()` returns
 * without a toast — indistinguishable, from the outside, from a dead button.
 */
async function qty(field: Locator, value: string): Promise<void> {
  await field.fill(value);
  await field.blur();
}

/** Picks a native `<select>`'s first real option, after its fetched options arrive. */
async function pickFirst(scope: Locator, label: string | RegExp): Promise<string> {
  const select = scope.getByLabel(label).first();
  const real = select.locator('option:not([value=""])').first();
  await real.waitFor({ state: 'attached', timeout: 20_000 });
  const value = await real.getAttribute('value');
  if (!value) throw new Error(`"${label}" offered no selectable option`);
  await select.selectOption(value);
  return ((await real.textContent()) ?? '').trim();
}

/**
 * Satisfies a required photo field with a real (tiny) PNG.
 *
 * Waste, retur, receiving and attendance all refuse to submit without one —
 * the photo IS the evidence — and a headless browser has no camera, so the
 * "Pilih dari Berkas" path is the one a test can take. It is also the path a
 * real user on a desktop takes.
 */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

async function attachPhoto(scope: Locator | Page): Promise<void> {
  const inputs = scope.locator('input[type="file"]');
  const count = await inputs.count();
  if (count === 0) throw new Error('this form has no file input to attach a photo to');
  // ALL of them. Petty cash asks for two separate photos — the payment receipt
  // and the goods — and holds "Ajukan" disabled until both are present, so
  // filling only the first left the button dead and the step timed out on a
  // click against a control that was correctly refusing to be pressed.
  for (let i = 0; i < count; i++) {
    await inputs
      .nth(i)
      .setInputFiles({ name: `${RUN}-${i}.png`, mimeType: 'image/png', buffer: PNG });
  }
}

/**
 * Presses a form's primary action, and explains a refusal instead of timing out.
 *
 * A disabled submit is the app telling you the form is not satisfied. Clicking
 * it anyway waits out the action timeout and reports `locator.click: Timeout`,
 * which reads as a broken button — it cost three separate false findings here.
 * This says which button, and what the form still had on screen.
 */
async function submitForm(scope: Locator, name: RegExp, what: string): Promise<void> {
  const button = scope.getByRole('button', { name }).last();
  await button.waitFor({ state: 'visible', timeout: 20_000 });
  if (!(await button.isEnabled())) {
    const hint = (await scope.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    throw new Error(
      `the ${what} form will not submit — its action is disabled. On screen: ${hint}`,
    );
  }
  await button.click();
}

/** The dialog that is open, waited for properly. */
function dialogOf(page: Page): Locator {
  return page.getByRole('dialog').first();
}

/** Reads a table cell only once it holds something — rows mount empty while the fetch settles. */
async function cellText(row: Locator, index: number): Promise<string> {
  const cell = row.locator('td').nth(index);
  await expect(cell).toHaveText(/\S/, { timeout: 30_000 });
  return (await cell.innerText()).trim();
}

/**
 * Walks a document forward through whatever buttons its screen currently
 * offers, up to `max` times, and reports the sequence it actually clicked.
 *
 * Used for the Surat Jalan (draft → ready → loading → dispatched) and the
 * driver's drop, where the labels belong to the app and not to this spec.
 */
async function advance(
  page: Page,
  openIt: () => Promise<Locator>,
  wanted: RegExp,
  max = 4,
): Promise<string[]> {
  const clicked: string[] = [];
  for (let i = 0; i < max; i++) {
    const scope = await openIt();
    const button = scope.getByRole('button', { name: wanted }).first();
    if ((await button.count()) === 0) break;
    const label = ((await button.textContent()) ?? '').trim();
    await button.click();
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
    await page.waitForTimeout(1_500);
    clicked.push(label);
  }
  return clicked;
}

/**
 * Counts a storage area, choosing one that actually HOLDS something.
 *
 * The first area in the list is frequently empty (Chiller and Display hold
 * nothing at this outlet), and an opname on an empty area opens a sheet with
 * no lines — so a test that takes the first option submits a count of nothing
 * and reports success. This walks the areas until it finds one with stock, and
 * says so if none of them have any.
 */
async function countAnArea(page: Page, route: string): Promise<string> {
  await open(page, route);
  const areas = await page
    .getByRole('button', { name: /^Mulai Opname/ })
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .then(async () => {
      await page
        .getByRole('button', { name: /^Mulai Opname/ })
        .first()
        .click();
      const start = dialogOf(page);
      await expect(start).toBeVisible({ timeout: 20_000 });
      const select = start.getByLabel('Area Penyimpanan').first();
      await select.locator('option:not([value=""])').first().waitFor({ state: 'attached' });
      return select
        .locator('option:not([value=""])')
        .evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
    });

  const emptyAreas: string[] = [];
  for (const area of areas) {
    // A FULL RELOAD between attempts. Starting a count creates a real opname
    // document, so the screen the next attempt meets is not the one this
    // function assumed — it reported all three warehouse areas as empty while
    // Stok Gudang showed 99 and 43 lines in two of them.
    await open(page, route);
    await clickOne(page, /^Mulai Opname/, 'start-count');
    await expect(dialogOf(page)).toBeVisible({ timeout: 20_000 });
    await dialogOf(page).getByLabel('Area Penyimpanan').selectOption(area);
    await dialogOf(page).getByRole('button', { name: 'Lanjut' }).click();
    await page.waitForTimeout(2_500);

    const sheet = dialogOf(page);
    await expect(sheet).toBeVisible({ timeout: 30_000 });
    const counts = sheet.locator('input');
    if ((await counts.count()) === 0) {
      emptyAreas.push(area);
      await dismissDialogs(page);
      continue;
    }

    // Count first, THEN the reason. The "Alasan" cell renders a textarea only
    // once the row actually varies (`variesNow`), so the field does not exist
    // until the count is committed — and `canSubmitOpname` holds Ajukan
    // disabled while any varying line has no reason (FR-SO-02). Filling the
    // count alone therefore left a permanently disabled submit.
    const firstRow = sheet.locator('tbody tr').first();
    await qty(firstRow.locator('input').first(), '5');
    await page.waitForTimeout(1_000);
    const reason = firstRow.locator('textarea').first();
    if ((await reason.count()) > 0) {
      await reason.fill(`${RUN} selisih hasil hitung fisik`);
      await reason.blur();
      await page.waitForTimeout(500);
    }
    await submitForm(sheet, /^Ajukan/, 'stock opname');
    await page.waitForTimeout(2_500);
    await screenIsHealthy(page, `after submitting a count at ${route}`);
    await expect(page.locator('table tbody')).toContainText(/OPN\//, { timeout: 20_000 });
    return `counted a stocked area (${emptyAreas.length} empty areas skipped)`;
  }
  throw new Error(
    `every storage area here counts empty (${areas.length} tried) — at ${route}. If this is ` +
      `the warehouse, that is the known defect: its panel builds the sheet from ` +
      `opname.lines alone, and a fresh count has none. The outlet's panel merges in current ` +
      `balances via buildOpnameSheet(); the warehouse's was never given the same treatment.`,
  );
}

/** The health check every screen gets, so a "pass" never means "it rendered garbage". */
async function screenIsHealthy(page: Page, where: string): Promise<void> {
  await assertNoLoadFailure(page, where);
  await assertNoTechnicalError(page, where);
}

// ══════════════════════════════════════════════════════════════════════════

test.describe('A working day at Mimi Chicken', () => {
  test.skip(!ALLOW_WRITES, 'writes disabled — this simulation trades, ships and hires for real');

  // ── 1. HEAD OFFICE OPENS UP ─────────────────────────────────────────────

  test('Kantor pusat: master data, people and promotions', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Kantor Pusat', 'Pemilik');
    const owner = await personAt(browser, CREW.owner);
    const { page } = owner;
    const step = stepsOn(j, page);

    try {
      await step('opens the head-office dashboard', async () => {
        await open(page, '/dashboard');
        await expect(page.getByRole('heading', { name: 'Dasbor' }).first()).toBeVisible();
        await screenIsHealthy(page, '/dashboard');
        return 'seven tabs of reporting render';
      });

      await step('reads every dashboard tab', async () => {
        const tabs = page.getByRole('tab');
        const count = await tabs.count();
        if (count === 0) throw new Error('the dashboard renders no tabs at all');
        const seen: string[] = [];
        for (let i = 0; i < count; i++) {
          const label = (await tabs.nth(i).innerText()).trim();
          await tabs.nth(i).click();
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
          await screenIsHealthy(page, `/dashboard › ${label}`);
          seen.push(label);
        }
        return seen.join(', ');
      });

      // A supplier, because the purchase order later in the day needs one and
      // because supplier search 500'd in production once before.
      state.supplierCode = `E2E-${RUN}`;
      await step('registers a new supplier', async () => {
        await open(page, '/purchasing');
        await page.getByRole('tab', { name: 'Supplier', exact: true }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await clickOne(page, /^Tambah Supplier/, 'add-supplier');

        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await d.getByLabel('Kode Supplier').fill(state.supplierCode!);
        await d.getByLabel('Nama Supplier').fill(`E2E Pemasok ${RUN}`);
        await d.getByLabel('Termin (hari)').fill('14');
        await d.getByRole('button', { name: 'Simpan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after creating a supplier');
        return state.supplierCode!;
      });

      await step('finds that supplier by searching for it', async () => {
        // The exact query that returned a 500 for every search term in
        // production on 2026-08-31.
        const search = page.getByPlaceholder('Cari kode atau nama supplier…').first();
        if ((await search.count()) === 0) throw new Error('the supplier list offers no search box');
        await search.fill(RUN);
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, 'supplier search');
        await expect(page.locator('table tbody')).toContainText(RUN, { timeout: 20_000 });
        return 'search returns the new supplier';
      });

      await step('mints a voucher batch for the promotion', async () => {
        await open(page, '/vouchers');
        await clickOne(page, /^Buat Batch/, 'new-batch');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        state.voucherBatch = `E2E Promo ${RUN}`;
        // `CreateBatchDto` requires a `code` and matches it against
        // /^[A-Z0-9_-]+$/ — it is what gets printed on the card.
        await d.getByLabel('Kode Batch').fill(`E2E-${RUN.toUpperCase()}`);
        await d.getByLabel('Nama Batch').fill(state.voucherBatch);
        await money(d.getByLabel('Nilai Potongan'), '5000');
        await money(d.getByLabel('Minimum Belanja'), '10000');
        await d.getByLabel('Berlaku Mulai').fill(TODAY);
        await d.getByLabel('Berlaku Sampai').fill('2026-12-31');
        await d.getByRole('button', { name: 'Simpan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after creating a voucher batch');
        await expect(page.locator('table tbody')).toContainText(RUN, { timeout: 20_000 });
        return state.voucherBatch;
      });

      await step('registers a new asset', async () => {
        await open(page, '/assets');
        await clickOne(page, /^Tambah Aset/, 'add-asset');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await d.getByLabel('Nama').first().fill(`E2E Freezer ${RUN}`);
        const where = await pickFirst(d, /^Lokasi/);
        await d.getByRole('button', { name: 'Simpan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after creating an asset');
        return `asset placed at ${where}`;
      });

      await step('hires an employee', async () => {
        await open(page, '/hr');
        await clickOne(page, /^Tambah Pegawai/, 'add-employee');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await d.getByLabel('No. Pegawai').fill(`E2E${RUN.slice(-4)}`);
        await d.getByLabel('Nama Lengkap').fill(`E2E Karyawan ${RUN}`);
        await d.getByLabel('Jabatan').fill('Staf Simulasi');
        await d.getByLabel('Tanggal Masuk').fill(TODAY);
        await pickFirst(d, /^ID Lokasi/);
        await money(d.getByLabel('Gaji Pokok'), '4000000');
        await d.getByRole('button', { name: 'Simpan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after hiring');
        return `E2E Karyawan ${RUN}`;
      });

      await step('creates a login for a new starter', async () => {
        await open(page, '/admin');
        await clickOne(page, /^Tambah Pengguna/, 'add-user');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await d.getByLabel('Username').fill(`e2e_${RUN.toLowerCase()}`);
        await d.getByLabel('Nama Lengkap').fill(`E2E Pengguna ${RUN}`);
        await d.getByLabel('Kata Sandi').fill('password123');
        await d.getByLabel('Peran').selectOption('koki');
        await d.getByRole('button', { name: 'Simpan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after creating a user');
        return `e2e_${RUN.toLowerCase()}`;
      });

      await step('checks the audit trail recorded all of that', async () => {
        await open(page, '/admin');
        await page.getByRole('tab', { name: 'Jejak Audit' }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, '/admin › Jejak Audit');
        await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });
        return 'audit log renders entries';
      });
    } finally {
      await owner.close();
    }
  });

  // ── 2. THE OUTLET ASKS FOR STOCK ────────────────────────────────────────

  test('Outlet: the supervisor raises a replenishment and approves her own step', async ({
    browser,
  }) => {
    test.setTimeout(600_000);
    const j = new Journal('Outlet', 'Supervisor Cabang');
    const spv = await personAt(browser, CREW.supervisor, { geo: OUTLET_GEO });
    const { page } = spv;
    const step = stepsOn(j, page);

    try {
      state.replenishment = await step('asks Gudang Pusat for stock', async () => {
        await open(page, '/outlet');
        await expect(page.getByRole('heading', { name: /Minta Barang/i })).toBeVisible();
        await clickOne(page, /^Buat Permintaan/, 'new-request');

        const d = dialogOf(page);
        await expect(d).toBeVisible();
        const item = await pickFirst(d, 'Barang');
        await qty(d.getByLabel('Jumlah'), '3');
        await d.getByRole('button', { name: 'Ajukan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });

        const number = await cellText(page.locator('table tbody tr').first(), 0);
        if (!/^RR\//.test(number))
          throw new Error(`the new request has no number (read "${number}")`);
        await screenIsHealthy(page, 'after raising a replenishment');
        console.log(`[sim] replenishment ${number} for ${item}`);
        return number;
      });

      if (!state.replenishment) {
        j.blocked('approves it at the supervisor step', 'no request was created');
      } else {
        await step('approves it at the supervisor step', async () => {
          await open(page, '/approvals');
          await page.getByLabel('Filter Jenis Dokumen').selectOption('replenishment_request');
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

          const row = page.locator('table tbody tr', { hasText: state.replenishment! });
          await expect(row, `${state.replenishment} never reached the approvals inbox`).toBeVisible(
            {
              timeout: 30_000,
            },
          );
          // A clickable `<tr>` with no anchor: clicking the row element can
          // land between cells and do nothing, which reads as a broken inbox.
          await row.locator('td').first().click();
          await page.waitForURL((u) => u.pathname.startsWith('/approvals/replenishment_request/'), {
            timeout: 30_000,
          });
          await expect(page.locator('body')).toContainText(state.replenishment!);
          await screenIsHealthy(page, 'approval detail');

          await clickOne(page, /^Setujui$/, 'approve');
          await expect(
            page.getByRole('button', { name: 'Setujui' }),
            'the approve button is still offered — the decision did not register',
          ).toBeHidden({ timeout: 30_000 });
          return `${state.replenishment} approved at step 1`;
        });
      }

      await step('reads the outlet stock on hand', async () => {
        await open(page, '/outlet/stok');
        await screenIsHealthy(page, '/outlet/stok');
        await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });
        return 'stock balances render per storage area';
      });

      await step('clocks in for the shift', async () => {
        await open(page, '/me/absen');
        await screenIsHealthy(page, '/me/absen');
        const blocked = await page.getByText(/Izin lokasi ditolak/i).count();
        if (blocked > 0)
          throw new Error('attendance still reports GPS denied with permission granted');
        await attachPhoto(page);
        await clickOne(page, /Absen Masuk/, 'clock-in');
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, 'after clocking in');
        return 'clocked in with a selfie inside the geofence';
      });
    } finally {
      await spv.close();
    }
  });

  // ── 3. GUDANG APPROVES, PICKS AND SHIPS ─────────────────────────────────

  test('Gudang Pusat: approves the request, then builds and dispatches a Surat Jalan', async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    const j = new Journal('Gudang Pusat', 'Kepala Gudang');
    const kgd = await personAt(browser, CREW.kepalaGudang, { geo: GUDANG_GEO });
    const { page } = kgd;
    const step = stepsOn(j, page);

    try {
      await step('opens the warehouse front page with live counts', async () => {
        await open(page, '/warehouse');
        const tile = page.locator('main a[href^="/warehouse"]').first();
        await expect(tile).toBeVisible({ timeout: 20_000 });
        // A NUMBER, not the loading em dash: "nothing to do" and "we could not
        // load this" must never look the same on a screen used to plan a day.
        await expect(tile, 'the warehouse tiles never resolved to a value').toContainText(/\d/);
        await screenIsHealthy(page, '/warehouse');
        return 'status tiles carry real counts';
      });

      await step('walks every warehouse area', async () => {
        const panels = [
          'approvals',
          'stock',
          'receiving',
          'opname',
          'waste',
          'retur',
          'pengiriman',
        ];
        const broken: string[] = [];
        for (const panel of panels) {
          await open(page, `/warehouse/${panel}`);
          try {
            await screenIsHealthy(page, `/warehouse/${panel}`);
          } catch (err) {
            broken.push(`${panel}: ${(err as Error).message.split('\n')[0]}`);
          }
        }
        if (broken.length > 0) throw new Error(broken.join(' ; '));
        return `${panels.length} areas all load`;
      });

      if (!state.replenishment) {
        j.blocked('approves the request at the warehouse step', 'the outlet raised nothing');
      } else {
        await step('approves the request at the warehouse step', async () => {
          // GUDANG'S OWN QUEUE, not the office inbox. `/approvals` is the
          // dashboard's surface and a Kepala Gudang's replenishment step is not
          // listed there — theirs is `/warehouse/approvals`, where a row opens a
          // decision dialog with the requested lines and Tolak / Setujui.
          await open(page, '/warehouse/approvals');
          await screenIsHealthy(page, '/warehouse/approvals');
          const row = page
            .locator('table')
            .first()
            .locator('tbody tr', { hasText: state.replenishment! });
          await expect(
            row,
            `${state.replenishment} never reached Gudang's queue — the chain stalled at step 1`,
          ).toBeVisible({ timeout: 30_000 });
          await row.locator('td').first().click();

          const decision = dialogOf(page);
          await expect(decision, 'the row opened no decision dialog').toBeVisible({
            timeout: 20_000,
          });
          await assertNoTechnicalError(page, 'gudang decision dialog');
          await clickOne(decision, /^Setujui$/, 'approve');
          await expect(decision).toBeHidden({ timeout: 30_000 });
          return `${state.replenishment} approved at the warehouse step`;
        });

        await step('sees it in the approved queue and starts processing', async () => {
          await open(page, '/warehouse/approvals');
          await screenIsHealthy(page, '/warehouse/approvals');
          const row = page.locator('table tbody tr', { hasText: state.replenishment! });
          await expect(row, `${state.replenishment} is not in the warehouse queue`).toBeVisible({
            timeout: 30_000,
          });
          // "Diminta Oleh" must carry a NAME. Gudang cannot read `users`, so
          // this only works because the service resolves it in a system
          // context — and it printed a raw UUID here once.
          const text = await row.innerText();
          if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) {
            throw new Error('the queue prints a raw UUID instead of the requester name');
          }
          const start = row.getByRole('button', { name: /Mulai Pemrosesan/ });
          if ((await start.count()) > 0) {
            await start.click();
            await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
          }
          return 'the approved request is pickable';
        });
      }

      state.suratJalan = await step('builds a Surat Jalan for the outlet', async () => {
        await open(page, '/delivery');
        await clickOne(page, /^Buat Surat Jalan/, 'new-surat-jalan');
        const d = dialogOf(page);
        await expect(d).toBeVisible();

        // Frozen/chilled and dry may never share a truck (FR-LOG-02), so the
        // dialog filters the requests it offers by the type chosen. Which one
        // holds our request depends on the item the outlet asked for, so try
        // both rather than assuming.
        let chosen = '';
        for (const type of ['Beku/Dingin', 'Kering (Sembako)']) {
          await d.getByRole('button', { name: type }).click();
          await page.waitForTimeout(1_500);
          // BY LABEL, and FORCED. `ui/Checkbox` renders its input `sr-only`
          // (the visible box is a styled sibling), so `check()` waits forever
          // for a control that is never going to be "visible". And a request
          // whose lines do not match this truck type is deliberately DISABLED —
          // that is the cold-chain rule working, not a broken picker, so skip
          // it and try the other type rather than timing out on it.
          const box = state.replenishment
            ? // An RR number carries no regex metacharacters — a forward slash
              // needs no escaping inside a `RegExp` — so it is safe as a pattern.
              d.getByLabel(new RegExp(state.replenishment))
            : d.getByLabel(/^RR\//).first();
          if ((await box.count()) > 0 && (await box.first().isEnabled())) {
            // CLICK THE LABEL, which is what a person clicks. `check({force})`
            // on the `sr-only` input can set the property without React's
            // `onCheckedChange` ever firing, leaving `selected` empty — and
            // `SjCreateForm.submit()` then returns silently on `drops.length
            // === 0`, so the dialog just sits there with no request made and no
            // message. Clicking the label goes through the real handler.
            const label = d.locator('label').filter({ has: box.first() }).first();
            if ((await label.count()) > 0) await label.click();
            else await box.first().check({ force: true });
            await page.waitForTimeout(500);
            if (!(await box.first().isChecked())) {
              throw new Error(`the request could not be selected on the ${type} truck`);
            }
            chosen = type;
            break;
          }
        }
        if (!chosen) {
          throw new Error(
            `no approved request could be loaded onto either truck type — offered: ${(
              await d.locator('label').allInnerTexts()
            )
              .join(' | ')
              .slice(0, 300)}`,
          );
        }

        // Named, not first-in-list: the driver leg below signs in as this
        // exact person, and picking whoever sorts first assigns the run to
        // somebody whose account this test cannot open.
        await d.getByLabel('Driver').selectOption({ label: 'Ayu Rahayu' });
        await pickFirst(d, 'Kendaraan');
        await d.getByLabel('Tanggal Rencana Kirim').fill(TODAY);
        await d.getByLabel('Catatan').fill(`${RUN} simulasi hari kerja`);
        await d.getByRole('button', { name: /^Buat Surat Jalan$/ }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after creating a Surat Jalan');

        const number = await cellText(page.locator('table tbody tr').first(), 0);
        if (!/^SJ\//.test(number))
          throw new Error(`the new Surat Jalan has no number (read "${number}")`);
        console.log(`[sim] surat jalan ${number} on the ${chosen} truck`);
        return number;
      });

      if (!state.suratJalan) {
        j.blocked('loads and dispatches it', 'no Surat Jalan was created');
      } else {
        await step('loads and dispatches it', async () => {
          const openSj = async () => {
            await open(page, '/delivery');
            const row = page.locator('table tbody tr', { hasText: state.suratJalan! }).first();
            await expect(row).toBeVisible({ timeout: 30_000 });
            await row.locator('td').first().click();
            const d = dialogOf(page);
            await expect(d).toBeVisible({ timeout: 20_000 });
            return d;
          };
          // The document's own wording for each step, discovered rather than
          // assumed — "Tandai Siap Kirim", then loading, then departure.
          const steps = await advance(page, openSj, /Siap Kirim|Muat|Berangkat|Kirim/);
          if (steps.length === 0) {
            const d = await openSj();
            throw new Error(
              `nothing on the Surat Jalan advances it — offered: ${(await actions(d)).join(' | ')}`,
            );
          }
          await screenIsHealthy(page, 'after dispatching');
          return `advanced through: ${steps.join(' → ')}`;
        });
      }
    } finally {
      await kgd.close();
    }
  });

  // ── 4. THE DRIVER RUNS IT ───────────────────────────────────────────────

  test('Driver: picks up the run on a phone and delivers it', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Pengiriman', 'Driver');
    const driver = await personAt(browser, CREW.driver, { geo: GUDANG_GEO, mobile: true });
    const { page } = driver;
    const step = stepsOn(j, page);

    try {
      const hasJob = await step("opens today's run", async () => {
        await open(page, '/driver');
        await screenIsHealthy(page, '/driver');
        await expect(page.getByRole('heading', { name: /Surat Jalan Hari Ini/i })).toBeVisible();
        const empty = await page.getByText(/Tidak ada Surat Jalan untuk hari ini/i).count();
        if (empty > 0) {
          throw new Error(
            state.suratJalan
              ? `${state.suratJalan} was dispatched to this driver today but their phone shows no run`
              : 'no run to deliver (nothing was dispatched)',
          );
        }
        return 'the run is on the phone';
      });

      if (!hasJob) {
        j.blocked('completes the drop', "the driver's screen showed no run");
      } else {
        await step('works the drop through to completion', async () => {
          const steps = await advance(
            page,
            async () => {
              await open(page, '/driver');
              return page.locator('body');
            },
            /Berangkat|Mulai|Tiba|Sampai|Serah|Selesai/,
            6,
          );
          if (steps.length === 0) {
            throw new Error(
              `nothing on the driver screen advances the drop — offered: ${(
                await actions(page)
              ).join(' | ')}`,
            );
          }
          await screenIsHealthy(page, 'driver after working the drop');
          return `advanced through: ${steps.join(' → ')}`;
        });
      }
    } finally {
      await driver.close();
    }
  });

  // ── 5. THE OUTLET RECEIVES ──────────────────────────────────────────────

  test('Outlet: receives the delivery against the Surat Jalan', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Outlet', 'Supervisor Cabang');
    const spv = await personAt(browser, CREW.supervisor, { geo: OUTLET_GEO });
    const { page } = spv;
    const step = stepsOn(j, page);

    try {
      await step('opens Terima Barang', async () => {
        await open(page, '/outlet/terima');
        // This screen 500'd on every visit until the Surat Jalan list's
        // location filter was fixed; it is the single most load-bearing
        // read in the outlet's day.
        await screenIsHealthy(page, '/outlet/terima');
        await expect(page.getByRole('heading', { name: /Terima Barang/i })).toBeVisible();
        return 'the receiving screen loads';
      });

      const waiting = await step('finds a delivery waiting to be received', async () => {
        const empty = await page.getByText(/Tidak ada pengiriman yang menunggu/i).count();
        if (empty > 0) {
          throw new Error(
            state.suratJalan
              ? `${state.suratJalan} does not appear at the outlet it was addressed to`
              : 'nothing was shipped, so nothing is waiting',
          );
        }
        return 'a delivery is waiting';
      });

      if (!waiting) {
        j.blocked('books the goods in', 'nothing was waiting to receive');
      } else {
        await step('books the goods in', async () => {
          const label = await clickOne(page, /Terima|Detail|Lihat/, 'receive');
          await page.waitForTimeout(1_500);
          const d = dialogOf(page);
          if ((await d.count()) > 0 && (await d.isVisible())) {
            const qty = d.locator('input').first();
            await qty.fill('3');
            await qty.blur();
            await attachPhoto(d).catch(() => {});
            await d
              .getByRole('button', { name: /Ajukan|Simpan|Terima/ })
              .first()
              .click();
            await expect(d).toBeHidden({ timeout: 30_000 });
          }
          await screenIsHealthy(page, 'after receiving');
          return `received via "${label}"`;
        });
      }
    } finally {
      await spv.close();
    }
  });

  // ── 6. THE TILL TRADES ──────────────────────────────────────────────────

  test('POS: the cashier opens the till, sells, and closes the shift', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Kasir (POS)', 'Kasir');
    const kasir = await personAt(browser, CREW.kasir, { geo: OUTLET_GEO });
    const { page } = kasir;
    const step = stepsOn(j, page);

    // NO BLUETOOTH PRINTER on this till. `printReceipt` calls
    // `navigator.bluetooth.requestDevice()`, which opens a chooser headless
    // Chromium has no UI to show — the promise never settles, the cart never
    // clears, and a completed sale looks like a double-charge bug. Removing
    // the API models a real till with no BLE printer paired.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'bluetooth', { value: undefined, configurable: true });
    });

    try {
      await step('opens the till on the right branch', async () => {
        await open(page, '/pos');
        await expect(page.getByText(CREW_OUTLET).first()).toBeVisible({ timeout: 30_000 });
        await screenIsHealthy(page, '/pos');
        return `till bound to ${CREW_OUTLET}`;
      });

      const opened = await step('opens the shift with a cash float', async () => {
        const float = page.getByLabel(/Modal Awal Kas/i);
        if ((await float.count()) === 0) return 'a shift was already open';
        const button = page.getByRole('button', { name: 'Buka Kasir' });
        await expect(button, 'the till offers to open before a float is entered').toBeDisabled();
        await money(float, '200000');
        await expect(button, 'the float did not commit, so the till stayed shut').toBeEnabled();
        await button.click();
        await expect(float).toBeHidden({ timeout: 60_000 });
        await screenIsHealthy(page, 'after opening the shift');
        return 'shift opened with Rp200.000';
      });

      if (!opened) {
        j.blocked('rings a sale', 'the till never opened');
      } else {
        await step('the shift survives a reload', async () => {
          await page.reload({ waitUntil: 'domcontentloaded' });
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
          await expect(
            page.getByLabel(/Modal Awal Kas/i),
            'after a reload the till asked to be opened again — the shift did not persist',
          ).toBeHidden();
          return 'the open shift is server-side, not React state';
        });

        await step('rings a cash sale', async () => {
          const item = page.getByRole('button', { name: /^Kerupuk/ });
          await expect(item, 'the product grid never loaded, so nothing can be sold').toBeVisible({
            timeout: 60_000,
          });
          await item.click();
          const next = page.getByRole('button', { name: 'Lanjut ke Pembayaran' });
          await expect(next).toBeEnabled({ timeout: 30_000 });
          await next.click();

          await page.getByRole('button', { name: 'Tunai' }).click();
          const received = page.getByLabel(/Uang Diterima/i);
          await expect(received).toBeVisible({ timeout: 30_000 });
          await money(received, '3000');

          const finish = page.getByRole('button', { name: /Selesaikan/ });
          await expect(finish).toBeEnabled({ timeout: 30_000 });
          await finish.click();

          // `handleSubmit` clears the cart LAST, after the fact is committed —
          // so an empty basket is the till's own confirmation, and the payment
          // button going disabled is how that shows.
          await expect(
            page.getByRole('button', { name: 'Lanjut ke Pembayaran' }),
            'the basket still holds the sale — the transaction did not complete',
          ).toBeDisabled({ timeout: 60_000 });
          await screenIsHealthy(page, 'after a cash sale');
          return 'one cash sale of Rp3.000 committed';
        });

        await step('rings a second sale on a non-cash tender', async () => {
          const item = page.getByRole('button', { name: /^Kerupuk/ });
          await item.click();
          await page.getByRole('button', { name: 'Lanjut ke Pembayaran' }).click();
          const tender = page.getByRole('button', { name: /QRIS|Transfer|Kartu|Debit/ }).first();
          if ((await tender.count()) === 0) {
            throw new Error(
              `the till offers no non-cash tender — offered: ${(await actions(page)).join(' | ')}`,
            );
          }
          const label = ((await tender.textContent()) ?? '').trim();
          await tender.click();
          const finish = page.getByRole('button', { name: /Selesaikan/ });
          await expect(finish).toBeEnabled({ timeout: 30_000 });
          await finish.click();
          await expect(page.getByRole('button', { name: 'Lanjut ke Pembayaran' })).toBeDisabled({
            timeout: 60_000,
          });
          await screenIsHealthy(page, 'after a non-cash sale');
          return `one sale settled by ${label}`;
        });

        await step('closes the shift and counts the drawer', async () => {
          // THE TILL'S OWN TAB, not the sidebar's. `/pos` renders "Kasir",
          // "Shift", "GoFood" and "ShopeeFood" across the top; closing the day
          // is under Shift, and searching the selling screen for it finds only
          // the product grid — which reads as "there is no way to close".
          // `TabsTrigger`, so its ARIA role is `tab` — `getByRole('button')`
          // matches nothing even though the element really is a <button>.
          const shiftTab = page.getByRole('tab', { name: /Shift/ }).first();
          if ((await shiftTab.count()) > 0) {
            await shiftTab.click();
            await page.waitForTimeout(2_000);
          }
          const close = page
            .getByRole('button', { name: /Tutup Kasir|Tutup Shift|Akhiri/ })
            .first();
          if ((await close.count()) === 0) {
            throw new Error(
              `the till offers no way to close the shift — offered: ${(await actions(page)).join(
                ' | ',
              )}`,
            );
          }
          await close.click();
          await page.waitForTimeout(1_500);
          const d = dialogOf(page);
          if ((await d.count()) > 0 && (await d.isVisible())) {
            const counted = d.locator('input').first();
            await money(counted, '206000');
            await d
              .getByRole('button', { name: /Tutup|Simpan|Selesai/ })
              .last()
              .click();
            await page.waitForTimeout(2_000);
          }
          await screenIsHealthy(page, 'after closing the shift');
          return 'shift closed with a counted drawer';
        });

        await step('the takings for the day actually leave the till', async () => {
          // THE HALF A CLICKING TEST CANNOT SEE. This POS is offline-first:
          // every sale is committed to an IndexedDB outbox and pushed later, so
          // an empty basket proves the cashier's experience and nothing about
          // the books. Read the outbox itself, and give the engine a minute to
          // drain it before calling it stuck.
          const depthOf = () =>
            page.evaluate(
              () =>
                new Promise<number>((resolve) => {
                  const req = indexedDB.open('mimi-local');
                  req.onerror = () => resolve(-1);
                  req.onsuccess = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('outbox')) return resolve(-1);
                    const count = db
                      .transaction('outbox', 'readonly')
                      .objectStore('outbox')
                      .count();
                    count.onsuccess = () => resolve(count.result);
                    count.onerror = () => resolve(-1);
                  };
                }),
            );

          let depth = await depthOf();
          for (let i = 0; i < 6 && depth > 0; i++) {
            await page.waitForTimeout(10_000);
            depth = await depthOf();
          }

          if (depth > 0) {
            const pill = await page
              .getByText(/Tersinkron|menunggu|Menyinkronkan/)
              .first()
              .innerText()
              .catch(() => '(no sync pill)');
            throw new Error(
              `${depth} facts are STILL in the till's local outbox after 60s — the shift and ` +
                `its sales never reached the server, so nothing entered the books. ` +
                `The sync indicator meanwhile reads "${pill.trim()}".`,
            );
          }
          return depth === 0
            ? 'the outbox drained — the sales are on the server'
            : 'outbox unreadable';
        });
      }
    } finally {
      await kasir.close();
    }
  });

  // ── 7. THE OUTLET'S HOUSEKEEPING ────────────────────────────────────────

  test('Outlet: counts, writes off, returns and logs its petty cash', async ({ browser }) => {
    test.setTimeout(900_000);
    const j = new Journal('Outlet', 'Supervisor Cabang');
    const spv = await personAt(browser, CREW.supervisor, { geo: OUTLET_GEO });
    const { page } = spv;
    const step = stepsOn(j, page);

    try {
      await step('records spoilage with photo evidence', async () => {
        await open(page, '/outlet/waste');
        await clickOne(page, /^Catat Waste/, 'record-waste');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await pickFirst(d, 'Area Penyimpanan');
        await pickFirst(d, 'Barang');
        await qty(d.getByLabel('Hasil Hitung'), '1');
        await d.getByLabel('Catatan').fill(`${RUN} simulasi`);
        await attachPhoto(d);
        await d.getByRole('button', { name: 'Ajukan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after recording waste');
        await expect(page.locator('table tbody')).toContainText(/WST\//, { timeout: 20_000 });
        return 'a waste record was raised';
      });

      await step('sends damaged stock back to the warehouse', async () => {
        await open(page, '/outlet/retur');
        await clickOne(page, /^Buat Retur/, 'new-return');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await pickFirst(d, 'Barang');
        await pickFirst(d, 'Area Penyimpanan');
        await qty(d.getByLabel('Hasil Hitung'), '1');
        await d.getByLabel('Alasan').fill(`${RUN} rusak saat kirim`);
        await attachPhoto(d);
        await d.getByRole('button', { name: 'Ajukan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after raising a return');
        await expect(page.locator('table tbody')).toContainText(/RET\//, { timeout: 20_000 });
        return 'a retur to gudang was raised and submitted';
      });

      await step('counts a storage area', () => countAnArea(page, '/outlet/opname'));

      await step('logs a petty-cash purchase', async () => {
        await open(page, '/outlet/kas-kecil');
        await clickOne(page, /^Catat Kas Kecil/, 'record-petty-cash');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await d.getByLabel('Tanggal').fill(TODAY);
        await pickFirst(d, /Nama Toko/);
        await d.getByLabel('Keterangan').fill(`${RUN} beli gas`);
        await money(d.getByLabel('Total'), '150000');
        await attachPhoto(d);
        await submitForm(d, /^Ajukan/, 'petty cash');
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after logging petty cash');
        await expect(page.locator('table tbody')).toContainText(/PC\//, { timeout: 20_000 });
        return 'a petty-cash claim was raised';
      });

      await step('reads and saves the shift roster', async () => {
        await open(page, '/outlet/jadwal');
        await screenIsHealthy(page, '/outlet/jadwal');
        const cells = page.locator('select');
        if ((await cells.count()) === 0)
          throw new Error('the roster grid renders no shift pickers');
        const save = page.getByRole('button', { name: /^Simpan/ }).first();
        if ((await save.count()) === 0) throw new Error('the roster cannot be saved');
        await save.click();
        await page.waitForTimeout(2_000);
        await screenIsHealthy(page, 'after saving the roster');
        return 'the week roster renders and saves';
      });
    } finally {
      await spv.close();
    }
  });

  // ── 8. THE KITCHEN ──────────────────────────────────────────────────────

  test('Dapur: the cook reads the floor and records what spoiled', async ({ browser }) => {
    test.setTimeout(300_000);
    const j = new Journal('Outlet', 'Juru Masak');
    const koki = await personAt(browser, CREW.koki, { geo: OUTLET_GEO });
    const { page } = koki;
    const step = stepsOn(j, page);

    try {
      await step('opens the stock floor', async () => {
        await open(page, '/outlet/stok');
        await screenIsHealthy(page, 'koki /outlet/stok');
        await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });
        return 'the cook can see what is in stock';
      });

      await step('opens waste without tripping a permission they do not hold', async () => {
        // A Juru Masak holds `waste.read` and NOT `return.read`. The panel used
        // to fetch returns anyway, which earned them a 403 and an unhandled
        // rejection on a screen they are entitled to.
        const failures: string[] = [];
        page.on('response', (res) => {
          if (res.url().includes('/api/') && res.status() >= 400) {
            failures.push(`${res.status()} ${new URL(res.url()).pathname}`);
          }
        });
        const crashes: string[] = [];
        page.on('pageerror', (err) => crashes.push(err.message));

        await open(page, '/outlet/waste');
        await page.waitForTimeout(2_000);
        await screenIsHealthy(page, 'koki /outlet/waste');
        if (failures.length > 0 || crashes.length > 0) {
          throw new Error(
            `the cook's waste screen calls what they may not: ${failures.join(', ')}${
              crashes.length ? ` ; page errors: ${crashes.join(', ')}` : ''
            }`,
          );
        }
        return 'no forbidden call, no unhandled rejection';
      });

      await step('clocks in', async () => {
        await open(page, '/me/absen');
        await screenIsHealthy(page, 'koki /me/absen');
        await attachPhoto(page);
        await clickOne(page, /Absen Masuk|Absen Keluar/, 'clock');
        await page.waitForTimeout(2_000);
        await screenIsHealthy(page, 'koki after clocking');
        return 'attendance recorded';
      });
    } finally {
      await koki.close();
    }
  });

  // ── 9. THE OFFICE BUYS ──────────────────────────────────────────────────

  test('Pembelian: the office turns the outlet request into a PR, a PO, and receives it', async ({
    browser,
  }) => {
    test.setTimeout(900_000);
    // KEPALA GUDANG, not the Manager. `purchasing.pr.create` is held by owner,
    // kepala_gudang and supervisor — a Manager can APPROVE a purchase request
    // but may not raise one, so "Jadikan PR" is correctly absent from their
    // screen. Running this as a Manager tested the gate, not the flow.
    const j = new Journal('Pembelian', 'Kepala Gudang');
    const mgr = await personAt(browser, CREW.kepalaGudang);
    const { page } = mgr;
    const step = stepsOn(j, page);

    try {
      await step('reads the outlet requests queue', async () => {
        await open(page, '/purchasing');
        await screenIsHealthy(page, '/purchasing');
        const rows = page.locator('table tbody tr');
        await expect(rows.first()).toBeVisible({ timeout: 20_000 });
        // "Jumlah Item" counted every request as 0 in production once — a
        // request with no items in it cannot be converted or fulfilled.
        const text = await rows.first().innerText();
        if (/\b0\b/.test(text.split('\n')[2] ?? '')) {
          throw new Error('an outlet request is listed as holding 0 items');
        }
        return 'outlet requests are listed with their item counts';
      });

      state.purchaseRequest = await step('converts a request into a purchase request', async () => {
        const button = page.getByRole('button', { name: /^Jadikan PR/ }).first();
        // WAIT for it. The action lives in a table row, and the rows arrive
        // after `networkidle` settles — counting immediately reported "no
        // outlet request offers conversion to a PR" against a screen showing
        // fourteen of them.
        const offered = await button
          .waitFor({ state: 'visible', timeout: 20_000 })
          .then(() => true)
          .catch(() => false);
        if (!offered) {
          throw new Error('no outlet request offers conversion to a PR');
        }
        await button.click();
        await page.waitForTimeout(2_000);
        const d = dialogOf(page);
        if ((await d.count()) > 0 && (await d.isVisible())) {
          const submit = d.getByRole('button', { name: /Simpan|Buat|Ajukan|Lanjut/ }).last();
          await submit.click();
          await expect(d).toBeHidden({ timeout: 30_000 });
        }
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, 'after converting to a PR');

        await page.getByRole('tab', { name: 'Permintaan Pembelian' }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        const number = await cellText(page.locator('table tbody tr').first(), 0);
        if (!/^PR\//.test(number))
          throw new Error(`no purchase request appeared (read "${number}")`);
        return number;
      });

      await step('raises a purchase order against the new supplier', async () => {
        await open(page, '/purchasing');
        await page.getByRole('tab', { name: 'Purchase Order' }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, '/purchasing › Purchase Order');
        const button = page.getByRole('button', { name: /^Buat PO/ }).first();
        if ((await button.count()) === 0) throw new Error('the PO tab offers no way to create one');
        await button.click();
        await page.waitForTimeout(2_000);
        const d = dialogOf(page);
        await expect(d, 'the new-PO form did not open').toBeVisible({ timeout: 20_000 });
        const fields = await d.locator('input, select, textarea').count();
        if (fields === 0) throw new Error('the new-PO form rendered no fields');
        await page.keyboard.press('Escape');
        return `the PO form opens with ${fields} fields`;
      });

      await step('reads supplier price history', async () => {
        await open(page, '/purchasing');
        await page.getByRole('tab', { name: /Riwayat Harga/ }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, '/purchasing › Riwayat Harga Supplier');
        return 'price history loads';
      });
    } finally {
      await mgr.close();
    }
  });

  test('Gudang: receives a purchase order into stock', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Gudang Pusat', 'Kepala Gudang');
    const kgd = await personAt(browser, CREW.kepalaGudang, { geo: GUDANG_GEO });
    const { page } = kgd;
    const step = stepsOn(j, page);

    try {
      await step('books a supplier delivery in against its PO', async () => {
        await open(page, '/warehouse/receiving');
        await screenIsHealthy(page, '/warehouse/receiving');
        const row = page.locator('table tbody tr').first();
        if ((await row.count()) === 0) throw new Error('no purchase order is awaiting receipt');
        const po = await cellText(row, 0);
        await row.locator('td').first().click();
        await page.waitForTimeout(2_000);

        const d = dialogOf(page);
        await expect(d, `${po} did not open a receiving sheet`).toBeVisible({ timeout: 20_000 });
        // EVERY line, not just the first. The receipt is only submittable when
        // all of them carry a received quantity AND a storage area — a PO for
        // three items is not received by answering for one, and the form is
        // right to refuse. Filling only row 0 left the action disabled.
        const lineRows = d.locator('tbody tr');
        const lineCount = await lineRows.count();
        if (lineCount === 0) throw new Error('the receiving sheet lists no ordered lines');
        for (let i = 0; i < lineCount; i++) {
          const lineRow = lineRows.nth(i);
          await qty(lineRow.locator('input').first(), '1');
          const area = lineRow.locator('select').first();
          if ((await area.count()) > 0) {
            const value = await area
              .locator('option:not([value=""])')
              .first()
              .getAttribute('value');
            if (value) await area.selectOption(value);
          }
        }
        await attachPhoto(d);
        await submitForm(d, /Ajukan|Simpan/, 'PO receiving');
        await page.waitForTimeout(3_000);
        await screenIsHealthy(page, 'after receiving a PO');
        return `${po} received (${lineCount} lines)`;
      });

      await step('counts a warehouse storage area', () => countAnArea(page, '/warehouse/opname'));
    } finally {
      await kgd.close();
    }
  });

  // ── 10. FINANCE ─────────────────────────────────────────────────────────

  test('Keuangan: records a payment, reads the ledger and the reports', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Keuangan', 'Staf Keuangan');
    const fin = await personAt(browser, CREW.finance);
    const { page } = fin;
    const step = stepsOn(j, page);

    try {
      await step('opens the payment verification queue', async () => {
        await open(page, '/finance');
        await screenIsHealthy(page, '/finance');
        await expect(page.locator('table tbody tr').first()).toBeVisible({ timeout: 20_000 });
        return 'payments awaiting verification are listed';
      });

      await step('records a payment', async () => {
        await clickOne(page, /^Catat Pembayaran/, 'record-payment');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await money(d.getByLabel('Jumlah'), '250000');
        await d.getByLabel('Nomor Referensi').fill(RUN);
        await d.getByLabel('Catatan').fill(`${RUN} simulasi pembayaran`);
        await d.getByRole('button', { name: 'Simpan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after recording a payment');
        return 'a payment voucher was raised';
      });

      await step('reads every finance tab', async () => {
        const tabs = page.getByRole('tab');
        const count = await tabs.count();
        const seen: string[] = [];
        const broken: string[] = [];
        for (let i = 0; i < count; i++) {
          const label = (await tabs.nth(i).innerText()).trim();
          await tabs.nth(i).click();
          await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
          try {
            await screenIsHealthy(page, `/finance › ${label}`);
            seen.push(label);
          } catch (err) {
            broken.push(`${label}: ${(err as Error).message.split('\n')[0]}`);
          }
        }
        if (broken.length > 0) throw new Error(broken.join(' ; '));
        return seen.join(', ');
      });
    } finally {
      await fin.close();
    }
  });

  // ── 11. HR ──────────────────────────────────────────────────────────────

  test('SDM: leave, attendance, payroll and contracts', async ({ browser }) => {
    test.setTimeout(900_000);
    const j = new Journal('SDM', 'HR Admin');
    const hr = await personAt(browser, CREW.hrAdmin);
    const { page } = hr;
    const step = stepsOn(j, page);

    try {
      await step('reads every HR tab', async () => {
        await open(page, '/hr');
        const tabs = page.getByRole('tab');
        const count = await tabs.count();
        const seen: string[] = [];
        const broken: string[] = [];
        for (let i = 0; i < count; i++) {
          const label = (await tabs.nth(i).innerText()).trim();
          await tabs.nth(i).click();
          await page.waitForLoadState('networkidle', { timeout: 25_000 }).catch(() => {});
          try {
            await screenIsHealthy(page, `/hr › ${label}`);
            seen.push(label);
          } catch (err) {
            broken.push(`${label}: ${(err as Error).message.split('\n')[0]}`);
          }
        }
        if (broken.length > 0) throw new Error(broken.join(' ; '));
        return seen.join(', ');
      });

      await step('opens a payroll run', async () => {
        await open(page, '/hr');
        await page.getByRole('tab', { name: 'Payroll' }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        // "Hitung Payroll" is DISABLED until a period is entered — the click
        // just times out otherwise, which reads as a dead button rather than an
        // unanswered field.
        const period = page.locator('input').first();
        if ((await period.count()) > 0) {
          await period.fill(TODAY.slice(0, 7));
          await period.blur();
          await page.waitForTimeout(1_000);
        }
        const calc = page.getByRole('button', { name: /Hitung Payroll/ }).first();
        if ((await calc.count()) === 0)
          throw new Error('payroll offers no way to run a calculation');
        if (!(await calc.isEnabled())) {
          throw new Error(
            'Hitung Payroll stays disabled even with a period entered, and the screen says why nowhere',
          );
        }
        await calc.click();
        await page.waitForTimeout(2_000);
        const d = dialogOf(page);
        if ((await d.count()) > 0 && (await d.isVisible())) {
          const fields = await d.locator('input, select').count();
          await page.keyboard.press('Escape');
          return `the payroll run form opens with ${fields} fields`;
        }
        await screenIsHealthy(page, 'payroll');
        return 'payroll calculation is reachable';
      });

      await step('reviews the leave queue', async () => {
        await open(page, '/hr');
        await page.getByRole('tab', { name: /Cuti/ }).click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, '/hr › Cuti/Izin');
        return 'the leave queue loads with approve/reject actions';
      });
    } finally {
      await hr.close();
    }
  });

  // ── 12. EVERY EMPLOYEE'S OWN SURFACE ────────────────────────────────────

  test('Akun Saya: a member of staff runs their own paperwork', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Akun Saya', 'Kasir');
    const kasir = await personAt(browser, CREW.kasir, { geo: OUTLET_GEO });
    const { page } = kasir;
    const step = stepsOn(j, page);

    try {
      await step('opens every personal surface', async () => {
        const routes = [
          '/me',
          '/me/absen',
          '/me/slip',
          '/me/cuti',
          '/me/profil',
          '/me/pinjaman',
          '/me/kontrak',
        ];
        const broken: string[] = [];
        for (const route of routes) {
          await open(page, route);
          try {
            await screenIsHealthy(page, route);
          } catch (err) {
            broken.push(`${route}: ${(err as Error).message.split('\n')[0]}`);
          }
        }
        if (broken.length > 0) throw new Error(broken.join(' ; '));
        return `${routes.length} personal surfaces load`;
      });

      await step('applies for leave', async () => {
        await open(page, '/me/cuti');
        await clickOne(page, /^Ajukan/, 'request-leave');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        // UNPAID LEAVE, because it has no quota. Annual does (12 days), and a
        // simulation that files two days every run exhausts it and then reports
        // a WORKING quota guard as a broken form — the test measuring its own
        // history instead of the feature.
        await d.getByLabel('Jenis').selectOption('unpaid');
        // A DIFFERENT DAY EACH RUN. Filing the same two dates every time means
        // the second run overlaps the first run's request and is refused — the
        // simulation measuring its own history instead of the feature, exactly
        // as the annual-quota version did.
        const leaveFrom = new Date(Date.now() + 30 * 86_400_000 + LEAVE_OFFSET_MS);
        const leaveTo = new Date(leaveFrom.getTime() + 86_400_000);
        await d.getByLabel('Tanggal Mulai').fill(leaveFrom.toISOString().slice(0, 10));
        await d.getByLabel('Tanggal Selesai').fill(leaveTo.toISOString().slice(0, 10));
        await d.getByLabel(/Alasan/).fill(`${RUN} simulasi cuti`);
        await d.getByRole('button', { name: 'Simpan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after applying for leave');
        return 'a leave request was filed';
      });

      await step('applies for a salary advance', async () => {
        await open(page, '/me/pinjaman');
        await clickOne(page, /^Ajukan/, 'request-loan');
        const d = dialogOf(page);
        await expect(d).toBeVisible();
        await money(d.getByLabel('Jumlah Pinjaman'), '1000000');
        await money(d.getByLabel('Angsuran per Bulan'), '250000');
        await d.getByLabel(/Alasan/).fill(`${RUN} simulasi kasbon`);
        await d.getByRole('button', { name: 'Ajukan' }).click();
        await expect(d).toBeHidden({ timeout: 30_000 });
        await screenIsHealthy(page, 'after applying for a loan');
        return 'a kasbon request was filed';
      });

      await step('messages head office', async () => {
        await open(page, '/me/chat');
        await screenIsHealthy(page, '/me/chat');
        const box = page.locator('textarea, input[type="text"]').last();
        if ((await box.count()) === 0) throw new Error('the mail thread offers nowhere to type');
        await box.fill(`${RUN} simulasi pesan ke kantor`);
        const send = page.getByRole('button', { name: /Kirim|Send/ }).first();
        if ((await send.count()) === 0) throw new Error('the mail thread has no send button');
        await send.click();
        await page.waitForTimeout(2_000);
        await screenIsHealthy(page, 'after sending mail');
        await expect(page.locator('body')).toContainText(RUN, { timeout: 20_000 });
        return 'a message reached the office thread';
      });
    } finally {
      await kasir.close();
    }
  });

  // ── 13. THE REST OF THE SURFACE ─────────────────────────────────────────

  test('Sisanya: docs, topology, chats and the printed documents', async ({ browser }) => {
    test.setTimeout(600_000);
    const j = new Journal('Lain-lain', 'Pemilik');
    const owner = await personAt(browser, CREW.owner);
    const { page } = owner;
    const step = stepsOn(j, page);

    try {
      await step('opens the manual', async () => {
        await open(page, '/docs');
        await screenIsHealthy(page, '/docs');
        const links = await page.locator('main a[href^="/docs/"]').count();
        if (links === 0) throw new Error('the manual lists no chapters');
        await page.locator('main a[href^="/docs/"]').first().click();
        await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});
        await screenIsHealthy(page, '/docs/[slug]');
        return `${links} chapters, and one opens`;
      });

      await step('opens the device topology', async () => {
        await open(page, '/topology');
        await screenIsHealthy(page, '/topology');
        return 'the topology tree renders';
      });

      await step('opens internal chat and starts a thread', async () => {
        await open(page, '/chat/internal');
        await screenIsHealthy(page, '/chat/internal');
        const start = page.getByRole('button', { name: /Chat Baru/ }).first();
        if ((await start.count()) === 0)
          throw new Error('internal chat offers no way to start a thread');
        return 'internal chat loads with its threads';
      });

      await step('opens the WhatsApp inbox', async () => {
        await open(page, '/chat');
        await screenIsHealthy(page, '/chat');
        return 'the WhatsApp admin inbox loads';
      });

      if (!state.suratJalan) {
        j.blocked('prints the Surat Jalan', 'no Surat Jalan was created');
      } else {
        await step('prints the Surat Jalan', async () => {
          await open(page, '/delivery');
          const row = page.locator('table tbody tr', { hasText: state.suratJalan! }).first();
          await expect(row).toBeVisible({ timeout: 30_000 });
          await row.locator('td').first().click();
          const d = dialogOf(page);
          await expect(d).toBeVisible({ timeout: 20_000 });
          const print = d.getByRole('button', { name: /Surat Jalan|Cetak/ }).first();
          if ((await print.count()) === 0) {
            throw new Error(`no print action — offered: ${(await actions(d)).join(' | ')}`);
          }
          const [printed] = await Promise.all([
            page
              .context()
              .waitForEvent('page', { timeout: 20_000 })
              .catch(() => null),
            print.click(),
          ]);
          const target = printed ?? page;
          await target.waitForLoadState('domcontentloaded').catch(() => {});
          await target.waitForTimeout(2_500);
          await screenIsHealthy(target as Page, 'printed Surat Jalan');
          const body = await target.locator('body').innerText();
          if (!body.includes(state.suratJalan!)) {
            throw new Error('the printed document does not carry its own Surat Jalan number');
          }
          // The paper names the driver. It must be the person actually
          // driving — `drivers.name` disagreed with the account behind it.
          return `printed, and it names ${/Ayu Rahayu/.test(body) ? 'the assigned driver' : 'SOMEONE ELSE'}`;
        });
      }
    } finally {
      await owner.close();
    }
  });
});
