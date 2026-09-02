import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';
import { ALLOW_WRITES } from './support/crew';
import { assertNoLoadFailure, assertNoTechnicalError, collectApiFailures } from './support/errors';
import { choose, chooseOutletIfAsked, closeDialog } from './support/dialogs';

/**
 * THE FLOWS ONLY THE OWNER CAN DRIVE END TO END — stock opname, payroll, and an
 * approval chain past its first step.
 *
 * Owner is all-access, which makes it the wrong account for asking "can the
 * person whose job this is reach it" (`ops-role-reality` does that) and the
 * RIGHT one for asking "does this multi-step flow work at all". A replenishment
 * chain needs a supervisor AND a warehouse head; owner holds both steps, so one
 * session can walk the whole thing instead of orchestrating two people.
 *
 * Each write here is gated. Starting an opname creates a real count document;
 * approving a warehouse step releases goods to be picked; a payroll run
 * calculates what people are paid. None of that belongs on a live box, and the
 * ephemeral CI stack is where they run.
 */

test.describe('Stock opname', () => {
  test('the outlet can open its count sheet', async ({ page }) => {
    const api = collectApiFailures(page);
    await login(page, USERS.owner);
    await page.goto('/outlet/opname', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    // Passing the start button as the "already chosen" signal lets the helper
    // wait for whichever state this screen lands in — the outlet chooser for an
    // unbound account like owner, or the sheet itself for a bound one.
    const start = page.getByRole('button', { name: 'Mulai Opname', exact: true });
    await chooseOutletIfAsked(page, '/outlet/opname', start);

    // 60s, not 30: this is the first test to touch `/outlet/opname`, so on a
    // dev build it pays that route's cold compile. It failed at 30s against a
    // perfectly healthy screen the write test then used successfully.
    await expect(start).toBeVisible({ timeout: 60_000 });
    await assertNoLoadFailure(page, '/outlet/opname');
    await assertNoTechnicalError(page, '/outlet/opname');
    expect(api.failures, 'the opname screen called something forbidden').toEqual([]);
  });

  test.describe('starting a count (opt-in)', () => {
    test.skip(!ALLOW_WRITES, 'writes disabled — starting a count creates a real document');

    test('a count opens against one storage area, with its own number', async ({ page }) => {
      test.setTimeout(240_000);
      const api = collectApiFailures(page);
      await login(page, USERS.owner);
      await page.goto('/outlet/opname', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      const start = page.getByRole('button', { name: 'Mulai Opname', exact: true });
      await chooseOutletIfAsked(page, '/outlet/opname', start);

      await start.click();
      const dialog = page.getByRole('dialog').first();
      await expect(dialog).toBeVisible({ timeout: 30_000 });

      // ONE AREA AT A TIME is the point: stock is counted per storage area
      // (freezer, chiller, dry store…), never as one outlet total, so the sheet
      // a person carries matches the shelf they are standing at.
      // PREFER AN AREA THAT HOLDS SOMETHING. `choose` takes the first option,
      // which is "Chiller" — legitimately empty in the seed, so the sheet came
      // up with no lines and proved nothing about whether a sheet is built from
      // what the system thinks is on the shelf. Dry Store and Freezer are the
      // stocked areas; the fallback keeps this working on a box seeded
      // differently.
      // BY ROLE, not `getByLabel`. This is a native `<select>` whose label is
      // associated well enough for the accessible name but not for
      // `getByLabel`, which matched nothing here — so the option filter below
      // found zero options and silently fell back to the first area (Chiller,
      // the empty one) while reporting success.
      const area = dialog.getByRole('combobox', { name: /Area Penyimpanan/ }).first();
      await expect(area).toBeVisible({ timeout: 30_000 });
      // WAIT FOR THE AREAS TO ARRIVE. The select paints with only its
      // placeholder and fills in from a fetch, so filtering the options
      // immediately found none and fell through to the fallback below —
      // which counted Chiller (empty) while the test believed it had chosen a
      // stocked area. A probe confirmed the list is ["Pilih…"] at that moment
      // and all five areas a moment later.
      await area
        .locator('option:not([value=""])')
        .first()
        .waitFor({ state: 'attached', timeout: 30_000 });
      const stocked = area.locator('option', { hasText: /Dry Store|Freezer/ }).first();
      if ((await stocked.count()) > 0) {
        await area.selectOption(await stocked.getAttribute('value'));
      } else {
        expect(
          await choose(dialog, /Area Penyimpanan/),
          'no storage area could be chosen, so no sheet can exist',
        ).toBeTruthy();
      }
      await dialog.getByRole('button', { name: 'Lanjut', exact: true }).click();

      // THE SHEET IS THE SUCCESS SIGNAL, not the start dialog closing.
      // Submitting swaps one dialog for another — the start form closes and the
      // count sheet opens — so `expect(dialog).toBeHidden()` raced the
      // replacement and failed against a screen that had done exactly the right
      // thing (the log showed `.first()` resolving to the *sheet*, visible, for
      // a full minute). Wait for the sheet by its document number instead.
      const sheet = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { level: 2, name: /^OPN\// }) })
        .first();
      await expect(sheet, 'no count sheet opened, so there is nothing to count on').toBeVisible({
        timeout: 60_000,
      });
      const opnameNumber = (await sheet.getByRole('heading', { level: 2 }).innerText()).trim();
      console.log(`[e2e] opened stock count ${opnameNumber}`);

      // THE RULE THAT MAKES A COUNT TRUSTWORTHY, stated on the sheet itself: a
      // line whose counted quantity differs from the system's needs a reason
      // before it can be submitted. A variance with no explanation is how
      // shrinkage becomes invisible.
      await expect(
        sheet.getByText(/selisih wajib diisi alasannya/i),
        'the sheet does not tell the counter that a variance needs a reason',
      ).toBeVisible();

      // A sheet for a stocked area must list what the system believes is there.
      // Without this the test passed on an empty sheet — and an empty sheet is
      // uncountable: there is no "add a line" control, and CSV import only
      // fills quantities on rows that already exist.
      const lines = sheet.locator('table tbody tr');
      await expect(lines.first(), 'the count sheet for a stocked area has no lines').toBeVisible({
        timeout: 30_000,
      });
      expect(await lines.count()).toBeGreaterThan(0);

      // Submitting is blocked until something is actually counted, which is the
      // gate that stops an untouched sheet becoming an official zero count.
      const submit = sheet.getByRole('button', { name: 'Ajukan', exact: true });
      await expect(submit, 'an untouched count sheet can be submitted as-is').toBeDisabled();

      // AND A COUNT CAN ACTUALLY BE RECORDED. This is the part that was
      // impossible: with no rows there was nothing to type into, so the flow
      // ended here. Counting the first line to exactly its system quantity
      // keeps this a no-variance count, which needs no reason and so tests the
      // plain path rather than the variance gate.
      const firstRow = lines.first();
      // Quantities render Indonesian: "12.090,704 kg" is twelve thousand, not
      // twelve. Strip the unit, drop the thousands dots, then make the decimal
      // comma a point — reading it as-is typed "12.090.704" into the field.
      const systemQty = (await firstRow.locator('td').nth(1).innerText())
        .replace(/[^0-9.,]/g, '')
        .replace(/\./g, '')
        .replace(',', '.');
      expect(systemQty, 'could not read the system quantity off the sheet').toMatch(/^\d/);

      // `inputmode="decimal"` on a plain text input, not a spinbutton — and it
      // commits `onBlur`, so the value has to be committed with a Tab before
      // the submit gate re-evaluates.
      const counted = firstRow.locator('input[inputmode="decimal"]').first();
      await counted.fill(systemQty);
      await counted.press('Tab');

      await expect(submit, 'a counted sheet still cannot be submitted').toBeEnabled();
      await sheet.getByRole('button', { name: 'Simpan', exact: true }).click();
      await page.waitForLoadState('networkidle').catch(() => {});

      // Reopening proves the server kept it, rather than the number merely
      // sitting in React state.
      await closeDialog(page);
      await page.locator('table tbody tr').first().click();
      const reopened = page
        .getByRole('dialog')
        .filter({ has: page.getByRole('heading', { level: 2, name: opnameNumber }) })
        .first();
      await expect(reopened).toBeVisible({ timeout: 30_000 });
      await expect(
        reopened.locator('table tbody tr').first().locator('input[inputmode="decimal"]').first(),
        'the count was not saved — it came back empty',
      ).not.toHaveValue('');
      console.log(`[e2e] recorded a count on ${opnameNumber}`);

      await assertNoLoadFailure(page, 'after opening a count');
      await assertNoTechnicalError(page, 'after opening a count');
      expect(
        api.failures.filter((f) => /^5\d\d /.test(f)),
        'opening a count caused a server error',
      ).toEqual([]);
    });
  });
});

test.describe('Payroll', () => {
  test('the payroll tab lists runs by their own number', async ({ page }) => {
    const api = collectApiFailures(page);
    await login(page, USERS.owner);
    await page.goto('/hr', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.getByRole('tab', { name: 'Payroll' }).click();
    await page.waitForLoadState('networkidle').catch(() => {});

    // Payroll is the one screen where a wrong number is somebody's wages, so
    // what matters first is that a run is identifiable at all.
    const rows = page.locator('table tbody tr');
    if ((await rows.count()) > 0) {
      await expect(
        page.getByText(/PRUN\//).first(),
        'a payroll run is listed without its own number',
      ).toBeVisible({ timeout: 30_000 });
    }

    // The action that produces one has to be reachable, or the screen is a
    // read-only archive of runs nobody can add to.
    await expect(page.getByRole('button', { name: /Hitung Payroll/ })).toBeVisible({
      timeout: 30_000,
    });

    await assertNoLoadFailure(page, '/hr → Payroll');
    await assertNoTechnicalError(page, '/hr → Payroll');
    expect(api.failures, 'the payroll tab called something forbidden').toEqual([]);
  });

  // NOT AUTOMATED, and recorded rather than left as a silent gap: running
  // payroll computes what every employee is paid for a period, against
  // statutory tables (BPJS, PPh21) whose correctness is the whole feature. A
  // browser test that clicks "Hitung Payroll" and asserts a row appeared would
  // prove the button works while saying nothing about the figures — and the
  // figures are the part that matters. That belongs in the payroll module's own
  // integration tests, against known inputs and expected amounts.
});

test.describe('An approval chain past its first step', () => {
  test.skip(!ALLOW_WRITES, 'writes disabled — approving releases goods to be picked');

  test('the owner can act on a step the supervisor has already cleared', async ({ page }) => {
    test.setTimeout(240_000);

    // THIS TEST RAISES ITS OWN REQUEST instead of picking one out of the
    // inbox. The first version scanned the seeded queue for a document already
    // at step 2 — which worked once, then approved the last of them and
    // skipped itself thereafter as "no request has passed the supervisor",
    // reporting green while testing nothing. A flow that consumes its own
    // fixture has to create it.
    await login(page, USERS.owner);
    await page.goto('/outlet', { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    const raise = page.getByRole('button', { name: /Buat Permintaan/i });
    await chooseOutletIfAsked(page, '/outlet', raise);
    await expect(raise).toBeVisible({ timeout: 60_000 });

    // Remember what is at the top BEFORE submitting. Reading the first row
    // straight after the dialog closes read the list as it was — this test
    // passed alone and failed in a full run, because on a warm box the reload
    // had not landed yet and the "new" number was another spec's request (or a
    // loading row). Pinning to a CHANGE identifies our own document rather
    // than trusting the timing.
    const topCell = page.locator('table tbody tr').first().locator('td').nth(0);
    const before = await topCell.innerText().catch(() => '');

    await raise.click();

    const dialog = page.getByRole('dialog').first();
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    const itemSelect = dialog.getByLabel('Barang');
    await itemSelect
      .locator('option:not([value=""])')
      .first()
      .waitFor({ state: 'attached', timeout: 30_000 });
    const firstItem = await itemSelect
      .locator('option:not([value=""])')
      .first()
      .getAttribute('value');
    await itemSelect.selectOption(firstItem!);
    await dialog.getByLabel('Jumlah').fill('4');
    await dialog.getByRole('button', { name: 'Ajukan' }).click();
    await expect(dialog).toBeHidden({ timeout: 60_000 });

    await expect(topCell, 'the outlet list never showed the new request').not.toHaveText(
      before.trim(),
      { timeout: 60_000 },
    );
    await expect(topCell).toHaveText(/^RR\//, { timeout: 30_000 });
    const requestNumber = (await topCell.innerText()).trim();

    // ── Step 1: the supervisor's decision ──────────────────────────────────
    const stepOf = async () => {
      await page.goto('/approvals', { waitUntil: 'domcontentloaded' });
      await page.waitForLoadState('networkidle').catch(() => {});
      // Filter by VALUE — `selectOption({ label })` silently does nothing on a
      // mismatch and leaves every document type in the list.
      await page.getByLabel('Filter Jenis Dokumen').selectOption('replenishment_request');
      await page.waitForLoadState('networkidle').catch(() => {});
      const row = page.locator('table tbody tr').filter({ hasText: requestNumber }).first();
      await expect(row, `${requestNumber} is not in the approvals inbox`).toBeVisible({
        timeout: 30_000,
      });
      return { row, step: (await row.locator('td').last().innerText()).trim() };
    };

    const first = await stepOf();
    expect(first.step, 'a new request should be waiting at step 1').toBe('1');
    await first.row.locator('td').first().click();
    await page.waitForURL((u) => u.pathname.startsWith('/approvals/replenishment_request/'), {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Setujui' }).click();
    await expect(
      page.getByRole('button', { name: 'Setujui' }),
      'the supervisor decision did not register',
    ).toBeHidden({ timeout: 30_000 });

    // ── Step 2: the warehouse's decision, on a chain already moved on ──────
    // This is the part nothing had exercised: every earlier spec stopped at
    // step 1, so the second step and the timeline it renders were untested.
    const second = await stepOf();
    expect(
      Number(second.step),
      'the chain did not advance past the supervisor after approval',
    ).toBeGreaterThanOrEqual(2);
    await second.row.locator('td').first().click();
    await page.waitForURL((u) => u.pathname.startsWith('/approvals/replenishment_request/'), {
      timeout: 30_000,
    });

    const approve = page.getByRole('button', { name: 'Setujui' });
    await expect(
      approve,
      `${requestNumber} is waiting at a later step but offers the owner no decision`,
    ).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('body')).toContainText(requestNumber);
    // The timeline of a chain with a cleared step used to print the approver's
    // user ID where the person belongs. Guarded here because a step-1-only
    // flow never renders it.
    await assertNoTechnicalError(page, 'owner on a later approval step');

    await approve.click();
    await expect(
      page.getByRole('button', { name: 'Setujui' }),
      'the decision did not register — the approve button is still offered',
    ).toBeHidden({ timeout: 30_000 });
    await assertNoTechnicalError(page, 'owner after approving a later step');
    console.log(`[e2e] walked ${requestNumber} through two approval steps`);
  });
});
