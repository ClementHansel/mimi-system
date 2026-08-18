import { test, expect } from '@playwright/test';
import { assertAppIsUp, login, USERS } from './support/app';

/**
 * Regression cover for the incident that opened this session: the whole app
 * rendered a BLANK WHITE PAGE.
 *
 * A stored session holding an `accessToken` but no usable `user` passed
 * `AppShell`'s gate (which checked the token) and failed `app/page.tsx`'s
 * (which checks the user), so nothing rendered — and the redirect never fired
 * either, because it only triggers when the token is falsy. No content, no
 * console error, no navigation.
 *
 * Unit tests cover the gate logic. Only a browser can prove the whole
 * hydrate → gate → redirect path recovers, because the bug lived in the
 * interaction between persisted storage and two components, and its signature
 * was the ABSENCE of everything.
 */

/** Shapes that used to strand the app. Each must now land on /login. */
const POISONED = [
  {
    name: 'token with a null user',
    blob: { state: { accessToken: 'stale.jwt.token', refreshToken: 'r', user: null }, version: 0 },
  },
  {
    name: 'user missing the locations array',
    blob: {
      state: {
        accessToken: 'stale.jwt.token',
        refreshToken: 'r',
        user: { id: 'u1', name: 'Budi', roleKey: 'owner', permissions: [] },
      },
      version: 0,
    },
  },
  {
    name: 'pre-versioning blob with no version field',
    blob: {
      state: {
        accessToken: 'stale.jwt.token',
        refreshToken: 'r',
        user: { id: 'u1', name: 'Budi' },
      },
    },
  },
  {
    name: 'current-version blob that is nonetheless corrupt',
    blob: {
      state: {
        accessToken: 'stale.jwt.token',
        refreshToken: 'r',
        user: { id: 'u1', name: 'Budi' },
      },
      version: 1,
    },
  },
];

test.describe('session recovery (blank-page regression)', () => {
  test('a clean browser reaches the login page', async ({ page, baseURL }) => {
    await assertAppIsUp(page, baseURL);
    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.locator('body')).toContainText('Mimi Chicken OS');
  });

  for (const { name, blob } of POISONED) {
    test(`recovers to /login from a poisoned session: ${name}`, async ({ page, context }) => {
      await context.addInitScript(
        (payload) => localStorage.setItem('mimi-session', JSON.stringify(payload)),
        blob,
      );

      const pageErrors: string[] = [];
      page.on('pageerror', (e) => pageErrors.push(e.message));

      await page.goto('/');

      await expect(page).toHaveURL(/\/login$/);
      // The specific failure was a page that rendered NOTHING, so assert on
      // real content rather than just the URL.
      await expect(page.getByRole('button', { name: /masuk/i })).toBeVisible();
      expect(pageErrors, 'a poisoned session must not throw during render').toEqual([]);
    });
  }

  test('a real session survives a full reload', async ({ page }) => {
    // The other half of the fix: discarding bad sessions must not discard good
    // ones. A persist `version`/`migrate` that is too aggressive logs everyone
    // out on every visit, which would look like a different bug entirely.
    await login(page, USERS.owner);

    const stored = await page.evaluate(() => localStorage.getItem('mimi-session'));
    expect(stored, 'a successful login must persist a session').toBeTruthy();
    expect(JSON.parse(stored!).version, 'persisted at the current schema version').toBe(1);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page).not.toHaveURL(/\/login/);
  });
});
