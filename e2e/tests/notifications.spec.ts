import { test, expect } from '@playwright/test';
import { login, USERS } from './support/app';

/**
 * W5-08 — the in-app notification inbox.
 *
 * The header bell was a `<button>` with no handler, no badge and no panel,
 * while `GET /notifications` and both read endpoints had been live all along.
 * So this spec's job is narrow and specific: prove the bell is WIRED, because
 * "renders a bell icon" is exactly what it used to do while doing nothing.
 */

test.describe('notification inbox', () => {
  test('the bell opens an inbox and can mark everything read', async ({ page }) => {
    await login(page, USERS.owner);
    // The hub is chromeless — the header only exists on a shell route.
    await page.goto('/dashboard');

    const bell = page.getByRole('button', { name: /Notifikasi/i });
    await expect(bell).toBeVisible({ timeout: 20_000 });

    await bell.click();
    const panel = page.getByRole('menu').filter({ hasText: /Notifikasi/i });
    await expect(panel).toBeVisible();

    // Either real notifications or the empty state — both are legitimate, but
    // a panel that renders neither means the fetch never resolved.
    await expect(panel).toContainText(
      /Tandai semua dibaca|Tidak ada notifikasi baru|\d{1,2}\.\d{2}/,
      {
        timeout: 20_000,
      },
    );

    const markAll = panel.getByRole('button', { name: /Tandai semua dibaca/i });
    if (await markAll.count()) {
      await markAll.click();
      // The control only exists while something is unread, so it must vanish.
      await expect(markAll).toBeHidden({ timeout: 15_000 });
    }
  });

  test('the panel closes on Escape', async ({ page }) => {
    // Same affordance as the profile menu beside it — a dropdown that traps
    // the user is a bug the header would otherwise ship inconsistently.
    await login(page, USERS.owner);
    await page.goto('/dashboard');

    await page.getByRole('button', { name: /Notifikasi/i }).click();
    const panel = page.getByRole('menu').filter({ hasText: /Notifikasi/i });
    await expect(panel).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
  });
});
