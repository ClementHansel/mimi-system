import { type Locator, type Page } from '@playwright/test';

/**
 * Finding and opening the app's dialogs, shared by the two sweeps that do it.
 *
 * `form-sweep` opens every dialog and reads it (no writes, safe anywhere).
 * `form-validation-sweep` opens every dialog and submits it EMPTY (may write,
 * so it is gated). They must agree about WHICH dialogs exist and how to reach
 * them, or the second one silently covers less than the first — so the logic
 * lives here once rather than twice.
 */

/**
 * Labels that OPEN something rather than DO something.
 *
 * Matched as a whole-word prefix on the button's text: "Tambah Supplier",
 * "Buat Permintaan", "Impor CSV". Deliberately conservative — a missed dialog
 * costs coverage, a wrongly-clicked one costs data.
 *
 * "Ajukan" is absent even though it opens the leave form on `/me/cuti`: on
 * other screens the same word SUBMITS, and a draft purchase request's row
 * carries it. Missing one dialog is cheaper than filing somebody's paperwork.
 */
export const SAFE_OPENERS = ['Tambah', 'Buat', 'Impor', 'Ubah', 'Detail', 'Lihat', 'Atur'];

/** Never clicked, even when a label starts with a safe word. */
export const NEVER_CLICK = [
  /Nonaktif/i,
  /Hapus/i,
  /Batal/i,
  /Setujui/i,
  /Tolak/i,
  /Proses/i,
  /Kirim/i,
  /Terima/i,
  /Void/i,
  /Selesaikan/i,
  /Jadikan/i,
  /Keluar/i,
  /Sinkron/i,
];

export function isSafeOpener(label: string): boolean {
  const name = label.trim();
  if (name.length === 0 || name.length > 40) return false;
  if (NEVER_CLICK.some((p) => p.test(name))) return false;
  return SAFE_OPENERS.some((word) => new RegExp(`^${word}\\b`).test(name));
}

/**
 * Accessible names of every safe opener currently on screen, deduped.
 *
 * WAITS FOR BUTTONS FIRST. `networkidle` alone is not enough: the first run of
 * `form-sweep` collected its list straight after it and reported "0 dialogs"
 * for twelve routes whose openers exist and work — the buttons had not
 * rendered yet, so twelve routes covered nothing and the file passed green.
 */
export async function safeOpeners(page: Page): Promise<string[]> {
  await page
    .locator('button')
    .first()
    .waitFor({ state: 'visible', timeout: 20_000 })
    .catch(() => {});
  // One more settle: the shell's buttons paint before a panel's toolbar does.
  await page.waitForTimeout(1_500);

  const labels = await page
    .locator('button')
    .evaluateAll((els) => els.map((e) => (e.textContent ?? '').trim()));
  return [...new Set(labels.filter(isSafeOpener))];
}

/**
 * Labels that DISMISS a dialog rather than commit it. Everything else in a
 * dialog's footer is a candidate primary action.
 */
export const DISMISS_LABELS = [/^Batal/i, /^Tutup/i, /^Kembali/i, /^Selesai$/i];

/**
 * The dialog's primary action, or null if it has none (a viewer, a preview).
 *
 * Found by ELIMINATION rather than by an allowlist of labels. An exact-match
 * list of `['Simpan', 'Buat', …]` missed "Buat Kode Pemasangan" and "Buat
 * Surat Jalan" — real submits whose labels merely START with a listed word —
 * so `/topology` and `/delivery` reported nothing at all and looked covered.
 *
 * Takes the LAST non-dismiss button: dialog footers put the primary action
 * last, and a form's own field-level buttons ("Tambah Baris", the file picker)
 * come earlier.
 */
export async function primaryAction(dialog: Locator): Promise<Locator | null> {
  const buttons = dialog.getByRole('button');
  const count = await buttons.count().catch(() => 0);
  for (let i = count - 1; i >= 0; i--) {
    const candidate = buttons.nth(i);
    const label = ((await candidate.textContent().catch(() => '')) ?? '').trim();
    if (label.length === 0) continue;
    if (DISMISS_LABELS.some((p) => p.test(label))) continue;
    return candidate;
  }
  return null;
}

/**
 * True when the dialog is an EDIT form — every REQUIRED field already answered.
 *
 * "Submit it empty" is only a meaningful probe on a blank form.
 * `/purchasing`'s row-level "Ubah" opens the supplier form pre-filled, so
 * submitting it is a no-op update that legitimately succeeds — which this sweep
 * first reported as "the form accepted an empty submit", having performed a
 * real (harmless) supplier update to find out.
 *
 * KEYED ON REQUIRED FIELDS, not on "any field has a value". The first version
 * asked the looser question and skipped thirteen create forms whose only filled
 * field was a date defaulted to today — trading one false positive for a large
 * hole in coverage, which is the worse mistake of the two.
 *
 * Detecting the pre-fill is more honest than blacklisting "Ubah": some edit
 * dialogs open blank, and some "Tambah" dialogs default a field.
 */
export async function isPrefilled(dialog: Locator): Promise<boolean> {
  return dialog
    .locator('input, textarea, select')
    .evaluateAll((els) => {
      const fields = els.map(
        (el) => el as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
      );
      const required = fields.filter(
        (f) => f.required || f.getAttribute('aria-required') === 'true',
      );
      // No required field at all: nothing distinguishes "blank" from "edit", so
      // treat it as blank and let the submit answer for itself.
      if (required.length === 0) return false;
      const filled = (f: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) => {
        if (f instanceof HTMLInputElement && ['checkbox', 'radio'].includes(f.type))
          return f.checked;
        return (f.value ?? '').trim().length > 0;
      };
      // An EDIT form arrives with every required field already answered. A
      // CREATE form that merely defaults a date still has empty required ones.
      return required.every(filled);
    })
    .catch(() => false);
}

/**
 * Puts an `/outlet/*` screen into the state a supervisor always sees.
 *
 * As owner — every location in scope — those routes render a location PICKER
 * and no work surface, so a sweep finds nothing to open on six routes.
 */
export async function chooseOutletIfAsked(
  page: Page,
  route: string,
  ready?: Locator,
): Promise<void> {
  if (!route.startsWith('/outlet')) return;
  const picker = page.getByRole('button', { name: /^Mimi Chicken / }).first();

  // WAIT FOR THE SCREEN TO PICK A STATE, don't sample it once.
  //
  // This used to be a bare `count() > 0`, which asks "is the chooser painted
  // *right now*". `networkidle` can settle before React commits, so the answer
  // came back "no", the helper returned, and the caller then waited out its
  // whole timeout against a chooser that appeared a moment later — the failure
  // read as "Mulai Opname does not exist" while the screenshot showed twenty
  // outlet buttons.
  //
  // An unbound account (owner, direksi) lands on the chooser; a bound one
  // (staff, supervisor) goes straight to its outlet. So settle for EITHER: the
  // chooser, or the `ready` control the caller expects once an outlet is
  // chosen. Whichever wins, we stop waiting — a bound account pays nothing.
  const settled = [picker.waitFor({ state: 'visible', timeout: 30_000 })];
  if (ready) settled.push(ready.waitFor({ state: 'visible', timeout: 30_000 }));
  await Promise.race(settled).catch(() => {});

  if ((await picker.count()) > 0) {
    await picker.click().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    // The chooser must actually go away. Returning while it is still painted
    // leaves every later click landing on an outlet button.
    await picker.waitFor({ state: 'hidden', timeout: 30_000 }).catch(() => {});
  }
}

/**
 * Clicks `label` and returns the dialog if one opened, else null.
 *
 * Not every safe-looking label opens a dialog — "Detail" may expand a drawer,
 * "Atur" may navigate. That is not a failure, just nothing to inspect.
 */
export async function openDialog(page: Page, label: string): Promise<Locator | null> {
  const button = page.getByRole('button', { name: label, exact: true }).first();
  if ((await button.count()) === 0) return null;
  await button.click().catch(() => {});

  const dialog = page.getByRole('dialog').first();
  const appeared = await dialog
    .waitFor({ state: 'visible', timeout: 4_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    await page.keyboard.press('Escape').catch(() => {});
    return null;
  }
  return dialog;
}

/**
 * Closes whatever dialog is open. Returns false if it would not close, which
 * the caller should report rather than ignore: a stuck dialog leaves every
 * later click hitting its overlay.
 */
export async function closeDialog(page: Page): Promise<boolean> {
  await page.keyboard.press('Escape').catch(() => {});
  return page
    .getByRole('dialog')
    .first()
    .waitFor({ state: 'hidden', timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
}

/** How many tab panels this route has (1 when it is not tabbed). */
export async function panelCount(page: Page): Promise<number> {
  const count = await page
    .getByRole('tab')
    .count()
    .catch(() => 0);
  return count > 0 ? count : 1;
}

/** Selects tab `index`, if the route is tabbed at all. */
export async function selectPanel(page: Page, index: number): Promise<void> {
  const tabs = page.getByRole('tab');
  if ((await tabs.count().catch(() => 0)) === 0) return;
  await tabs
    .nth(index)
    .click()
    .catch(() => {});
  await page.waitForLoadState('networkidle').catch(() => {});
}

/**
 * Every route with an action surface worth opening. `/pos` is absent on
 * purpose: its buttons ring sales rather than opening dialogs, and
 * `ops-pos-day` drives it properly.
 */
export const DIALOG_ROUTES = [
  '/purchasing',
  '/finance',
  '/hr',
  '/assets',
  '/vouchers',
  '/admin',
  '/topology',
  '/delivery',
  '/outlet',
  '/outlet/opname',
  '/outlet/waste',
  '/outlet/retur',
  '/outlet/kas-kecil',
  '/outlet/jadwal',
  '/warehouse/stock',
  '/warehouse/receiving',
  '/me/cuti',
  '/me/pinjaman',
];

/**
 * Picks the first real option of a native `<select>`, waiting for its options
 * to arrive first.
 *
 * Every picker in this app is a native `<select>` whose options are FETCHED —
 * warehouses, items, suppliers. Reading `option` straight after the dialog
 * appears finds only the placeholder, and `getAttribute` then times out on a
 * locator that matches nothing. That race has cost this suite a failed run on
 * four separate specs now, so it lives in one place.
 *
 * Returns the chosen value, or null when the select genuinely offers nothing —
 * which is a finding for the caller to assert on, not something to swallow.
 */
export async function selectFirstOption(
  scope: Locator,
  label: string | RegExp,
): Promise<string | null> {
  const select = scope.getByLabel(label).first();
  const real = select.locator('option:not([value=""])').first();
  const appeared = await real
    .waitFor({ state: 'attached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return null;

  const value = await real.getAttribute('value');
  if (!value) return null;
  await select.selectOption(value);
  return value;
}

/**
 * Picks the first option of a `SearchableSelect` — the app's custom combobox.
 *
 * NOT every picker is a native `<select>`. `ui/SearchableSelect.tsx` renders a
 * `role="combobox"` BUTTON showing "Pilih…" which opens a `role="listbox"` of
 * `role="option"` items. `selectOption` does nothing to it, and reading
 * `option[value]` finds nothing — which is how the purchase-request form
 * reported "offered no warehouse to deliver to" while offering fifteen.
 *
 * Returns the chosen option's label, or null when the list is genuinely empty.
 */
export async function pickFromCombobox(
  scope: Locator,
  label: string | RegExp,
): Promise<string | null> {
  const trigger = scope.getByRole('combobox', { name: label }).first();
  if ((await trigger.count()) === 0) return null;

  // THE PLACEHOLDER IS ITSELF AN OPTION. `SearchableSelect` renders it as the
  // first `role="option"` in the listbox and clicking it calls `pick('')` —
  // it CLEARS the field. Taking `.first()` therefore selected nothing, over and
  // over, while reporting success: the form stayed empty and its Simpan button
  // stayed disabled for a reason no assertion could see.
  //
  // The trigger shows that same placeholder while nothing is chosen, so its
  // current text identifies the entry to skip — no hardcoded Indonesian, and it
  // keeps working if the copy changes.
  const placeholder = ((await trigger.textContent().catch(() => '')) ?? '').trim();

  await trigger.click();

  // SEARCHED INSIDE `scope`, not on the page. The listbox renders within the
  // dialog, and a page-wide `getByRole('option')` instead resolved to "Semua
  // Lokasi" — an option belonging to the filter BEHIND the dialog, invisible
  // under its overlay. Every click then timed out on an element that was never
  // going to be clickable, and the helper reported "this form offers no such
  // option" for a picker that had just opened thirty-five of them.
  const options = scope.getByRole('option');
  const option = placeholder
    ? options.filter({ hasNotText: placeholder }).first()
    : options.first();

  // `click()` and not a manual `waitFor({ state: 'visible' })`: Playwright's
  // click already waits for visible-stable-enabled and scrolls the option into
  // view, whereas the explicit visibility wait FAILED on a list that was
  // demonstrably open with 35 options in it — leaving the popup hanging and
  // returning "no such option" for a control that was working. Reading the
  // label first, so the caller learns what was chosen.
  const text = ((await option.textContent().catch(() => '')) ?? '').trim();
  const clicked = await option
    .click({ timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!clicked) return null;

  // The label may be empty for an icon-only option; the pick still happened, so
  // report success rather than a misleading null.
  return text || 'selected';
}

/**
 * Picks from whichever kind of picker this label happens to be — native
 * `<select>` or `SearchableSelect`. Forms in this app mix both, and which one
 * a given field uses is not something a flow spec should have to know.
 */
export async function choose(scope: Locator, label: string | RegExp): Promise<string | null> {
  // FOUND BY ROLE, not by label. Both kinds of picker expose
  // `role="combobox"` — a native `<select>` implicitly, `SearchableSelect`
  // explicitly — while `getByLabel` matches only the native one reliably and
  // returned nothing for the custom control even once it had a proper
  // accessible name.
  //
  // Detected rather than tried-and-waited: the first version called the native
  // path first and fell through on failure, costing a 20-second wait per
  // combobox field before the right code even ran.
  const control = scope.getByRole('combobox', { name: label }).first();
  // WAIT for it to exist. Counting immediately after the dialog becomes visible
  // finds zero: the dialog's frame paints before its fields mount, so every
  // caller got "this form offers no such picker" for a picker that was about to
  // appear. Third time this suite has been bitten by reading a surface before
  // it rendered, hence the wait living in the helper rather than each caller.
  const exists = await control
    .waitFor({ state: 'attached', timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  if (!exists) return null;

  const tag = await control.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
  return tag === 'select' ? selectFirstOption(scope, label) : pickFromCombobox(scope, label);
}
