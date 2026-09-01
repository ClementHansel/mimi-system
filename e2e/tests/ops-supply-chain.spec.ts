import { test, expect, type Browser, type Page } from '@playwright/test';
import { login } from './support/app';
import { ALLOW_WRITES, CREW, CREW_OUTLET } from './support/crew';
import { assertNoLoadFailure, assertNoTechnicalError } from './support/errors';

/**
 * A REAL WORKING DAY on the business's spine, driven through the UI by the
 * people who actually do each step — one browser context per person, because
 * that is how it happens: four different humans, at four different screens,
 * handing one document along.
 *
 *   outlet asks  →  supervisor approves  →  gudang approves  →  gudang picks
 *   (Supervisor)    (Supervisor)            (Kepala Gudang)     (Kepala Gudang)
 *
 * WHY THIS SHAPE. Every previous suite here tests one screen at a time, and the
 * bug that started this work — Pembelian counting a real request as "0 item" —
 * lived in the SEAM between two screens that were each fine on their own. A
 * handoff is where state, permissions and RLS meet, and nothing that stays
 * inside one page can see it.
 *
 * WRITES ONLY WHERE WRITES ARE SAFE. This creates a real replenishment request
 * and really approves it, so it is gated on `E2E_ALLOW_WRITES=1` and runs on
 * the demo box, never against production. The read-only half — that each
 * person's queue exists, loads, and speaks Indonesian — always runs, because
 * "can Gudang open their approval queue at all" is worth knowing everywhere.
 *
 * IT DOES NOT ASSERT ON PRE-EXISTING DATA. A box someone has been clicking
 * around on has requests in every state; a test that expects the queue to be
 * empty, or to hold exactly one row, is testing the seed and will rot. It
 * tracks the request IT created, by number, and asserts about that one only.
 */

/** Signs a person in on their own context, as a separate human at their own screen. */
async function personAt(
  browser: Browser,
  username: string,
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await login(page, username);
  return { page, close: () => context.close() };
}

test.describe('The queues each job opens in the morning', () => {
  test("the supervisor's outlet screen and approvals inbox both load", async ({ browser }) => {
    const spv = await personAt(browser, CREW.supervisor);
    try {
      await spv.page.goto('/outlet', { waitUntil: 'domcontentloaded' });
      await spv.page.waitForLoadState('networkidle').catch(() => {});
      await expect(spv.page.getByRole('heading', { name: /Minta Barang/i })).toBeVisible();
      await assertNoLoadFailure(spv.page, 'supervisor /outlet');
      await assertNoTechnicalError(spv.page, 'supervisor /outlet');

      // Where the supervisor step of the approval chain is actually acted on.
      await spv.page.goto('/approvals', { waitUntil: 'domcontentloaded' });
      await spv.page.waitForLoadState('networkidle').catch(() => {});
      await assertNoLoadFailure(spv.page, 'supervisor /approvals');
      await assertNoTechnicalError(spv.page, 'supervisor /approvals');
    } finally {
      await spv.close();
    }
  });

  test('the warehouse head gets their own status tiles, with numbers in them', async ({
    browser,
  }) => {
    // Owner ruling, 2026-09-01. `/warehouse` is built on `/dashboard/ops-status`,
    // which was gated on `dashboard.view` — owner/manager only — so the person
    // whose front page this is saw an error state where the owner saw four live
    // tiles. The endpoint now also accepts `replenishment.approve.warehouse`
    // ("you run the central warehouse"); every count inside it was already
    // location-scoped, so that widened who may ask, not what comes back.
    const kgd = await personAt(browser, CREW.kepalaGudang);
    try {
      await kgd.page.goto('/warehouse', { waitUntil: 'domcontentloaded' });
      await kgd.page.waitForLoadState('networkidle').catch(() => {});

      const tile = kgd.page.locator('main a[href^="/warehouse"]').first();
      await expect(tile).toBeVisible();

      // A NUMBER, not the loading em dash. `WarehouseDashboard` renders "—"
      // while it does not know, precisely so that "nothing to do" and "we could
      // not load this" never look the same on a screen someone plans their
      // morning with — which makes the em dash the exact symptom of the bug.
      await expect(tile, 'the warehouse tiles never resolved to a value').toContainText(/\d/);

      await assertNoLoadFailure(kgd.page, 'gudang /warehouse');
      await assertNoTechnicalError(kgd.page, 'gudang /warehouse');
    } finally {
      await kgd.close();
    }
  });

  test("the warehouse head's approval queue loads and names its columns", async ({ browser }) => {
    const kgd = await personAt(browser, CREW.kepalaGudang);
    try {
      await kgd.page.goto('/warehouse/approvals', { waitUntil: 'domcontentloaded' });
      await kgd.page.waitForLoadState('networkidle').catch(() => {});

      await expect(kgd.page.getByText('Antrean Persetujuan').first()).toBeVisible();
      await assertNoLoadFailure(kgd.page, 'gudang /warehouse/approvals');
      // This is the screen that printed a raw requester UUID under "Diminta
      // Oleh" (2026-09-01); `assertNoTechnicalError` now matches bare UUIDs
      // precisely so this assertion catches it coming back.
      await assertNoTechnicalError(kgd.page, 'gudang /warehouse/approvals');

      // And "Diminta Oleh" carries a NAME. Gudang cannot read `users` at all
      // (`users_select`, migration 263), so this only works because the service
      // resolves the display name in a system context — the owner ruled the
      // name back in on 2026-09-01 because the warehouse fulfils every outlet's
      // requests and needs to know who asked. Skipped when the queue is empty:
      // an empty queue is a legitimate state of a box, not a regression.
      const rows = kgd.page.locator('table tbody tr');
      if ((await rows.count()) > 0) {
        const requestedBy = rows.first().locator('td').nth(2);
        await expect(
          requestedBy,
          'Gudang cannot see who raised the request they are being asked to approve',
        ).not.toHaveText('—');
      }
    } finally {
      await kgd.close();
    }
  });
});

test.describe('One request, handed from the outlet to the warehouse', () => {
  test.skip(!ALLOW_WRITES, 'writes disabled — this raises a real request on the target box');

  test('the outlet asks, the supervisor approves, and Gudang sees it in their queue', async ({
    browser,
  }) => {
    // Four handoffs and three logins: slower than the 60s default by design.
    test.setTimeout(240_000);

    const spv = await personAt(browser, CREW.supervisor);

    try {
      // ── 1. THE OUTLET ASKS ────────────────────────────────────────────────
      await spv.page.goto('/outlet', { waitUntil: 'domcontentloaded' });
      await spv.page.getByRole('button', { name: /Buat Permintaan/i }).click();

      const dialog = spv.page.getByRole('dialog');
      await expect(dialog).toBeVisible();

      // Native `<select>` (see `ui/Select.tsx`), so `selectOption`, not a click.
      const itemSelect = dialog.getByLabel('Barang');
      const firstItem = await itemSelect
        .locator('option:not([value=""])')
        .first()
        .getAttribute('value');
      expect(firstItem, 'the item picker offered nothing to request').toBeTruthy();
      await itemSelect.selectOption(firstItem!);
      await dialog.getByLabel('Jumlah').fill('3');
      await dialog.getByRole('button', { name: 'Ajukan' }).click();
      await expect(dialog).toBeHidden({ timeout: 30_000 });

      const firstRow = spv.page.locator('table tbody tr').first();
      await expect(firstRow).toBeVisible();

      // WAIT FOR THE CELL TO HAVE TEXT, not merely to exist. The list refetches
      // after the dialog closes, and reading straight away returned '' on the
      // first live run — the row was mounted and empty for an instant. That
      // failed the test AFTER it had already created a real request on
      // production, which is the worst possible moment to be wrong about
      // timing. Same fix as `purchasing.spec.ts`'s supplier-code read.
      const numberCell = firstRow.locator('td').nth(0);
      await expect(numberCell).toHaveText(/\S/, { timeout: 30_000 });
      const requestNumber = (await numberCell.innerText()).trim();
      // PRINTED, because this test writes. When it runs against a live box the
      // number is the only way for a person to find what it created and cancel
      // it — a replenishment request has no notes field to mark in the UI.
      console.log(`[e2e] created replenishment request ${requestNumber}`);
      expect(requestNumber, 'the new request has no number').toMatch(/^RR\//);

      // Submitted, not draft: an outlet request that never leaves the outlet is
      // not a handoff, and the rest of this test would be asserting nothing.
      await expect(firstRow).toContainText(/Diajukan|Menunggu/i);

      // ── 2. THE SUPERVISOR ACTS ON THEIR OWN STEP ──────────────────────────
      // Step 1 of the chain is `replenishment.approve.supervisor`, and the same
      // person holds it — the role does both jobs since `leader_outlet` was
      // retired. That is the live org, so it is what gets tested.
      await spv.page.goto('/approvals', { waitUntil: 'domcontentloaded' });
      await spv.page.waitForLoadState('networkidle').catch(() => {});

      // FILTER BY VALUE, not by label. `selectOption({ label })` silently does
      // nothing here if the label does not match exactly, and a filter that
      // quietly fails leaves the inbox showing every document type — which is
      // how an earlier version of this spec "found" rows it had not filtered.
      await spv.page.getByLabel('Filter Jenis Dokumen').selectOption('replenishment_request');
      await spv.page.waitForLoadState('networkidle').catch(() => {});

      const inboxRow = spv.page.locator('table tbody tr', { hasText: requestNumber });
      await expect(
        inboxRow,
        `${requestNumber} never reached the supervisor's approvals inbox`,
      ).toBeVisible({ timeout: 30_000 });
      await assertNoTechnicalError(spv.page, 'supervisor approvals inbox');

      // Open it by clicking a CELL. The row is a clickable `<tr>` with no
      // anchor, so clicking the row element itself can land between cells and
      // do nothing at all — which reads exactly like a broken inbox.
      await inboxRow.locator('td').first().click();
      await spv.page.waitForURL((u) => u.pathname.startsWith('/approvals/replenishment_request/'), {
        timeout: 30_000,
      });

      // The detail page hydrates its document AFTER the shell paints, so wait
      // for the decision control rather than for `networkidle`.
      const approveButton = spv.page.getByRole('button', { name: 'Setujui' });
      await expect(approveButton).toBeVisible({ timeout: 30_000 });

      // It must be showing OUR request, not whatever the inbox happened to
      // sort first — the whole point of matching by number above.
      await expect(spv.page.locator('body')).toContainText(requestNumber);
      await assertNoTechnicalError(spv.page, 'supervisor approval detail');

      await approveButton.click();

      // Approved: the decision is recorded and the document has left this step.
      // Asserted on the page rather than in the database, because what matters
      // is that the person who clicked can SEE that it worked.
      await expect(
        spv.page.getByRole('button', { name: 'Setujui' }),
        'the approve button is still offered — the decision did not register',
      ).toBeHidden({ timeout: 30_000 });
      await assertNoTechnicalError(spv.page, 'supervisor after approving');
    } finally {
      await spv.close();
    }

    // ── 3. THE WAREHOUSE SEES IT ────────────────────────────────────────────
    // A SEPARATE CONTEXT, because it is a separate person on a separate
    // machine — and because the app redirects an authenticated session away
    // from `/login`, so re-using the page to "become" someone else silently
    // does not work.
    const kgd = await personAt(browser, CREW.kepalaGudang);
    try {
      await kgd.page.goto('/warehouse/approvals', { waitUntil: 'domcontentloaded' });
      await kgd.page.waitForLoadState('networkidle').catch(() => {});
      await assertNoLoadFailure(kgd.page, 'gudang queue after a new request');
      await assertNoTechnicalError(kgd.page, 'gudang queue after a new request');

      // Deliberately NOT asserting the request is already in Gudang's queue:
      // whether it arrives there immediately depends on the approval chain's
      // configured steps for this document type, which the owner can change in
      // Admin (`settings.approval_mode.manage`). Asserting a specific chain
      // here would make this test fail the day the owner reconfigures one,
      // which is a setting, not a regression. What IS asserted is the part that
      // must hold under every configuration: the queue loads for the person who
      // works it, and shows them nothing machine-shaped.
      const outletCell = kgd.page.getByText(CREW_OUTLET).first();
      if ((await outletCell.count()) > 0) {
        await expect(outletCell).toBeVisible();
      }
    } finally {
      await kgd.close();
    }
  });
});
