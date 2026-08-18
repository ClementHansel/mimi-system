import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for `@mimi/e2e`.
 *
 * This suite runs against an ALREADY-RUNNING instance — it deliberately does
 * not declare a `webServer`. The stack is Postgres + Redis + MinIO + backend +
 * frontend; booting that from a test runner would duplicate
 * `docker-compose.yml` badly and hide which layer failed when it broke. Point
 * `E2E_BASE_URL` at whichever instance you want to exercise:
 *
 *   pnpm e2e                                          # localhost:3000
 *   E2E_BASE_URL=http://150.109.15.108:8080 pnpm e2e  # the demo box
 *
 * NOT wired into `pnpm test` (which is `pnpm -r --filter=!@mimi/e2e test`) on
 * purpose: the unit/integration suites must stay runnable with nothing served,
 * and a browser suite that silently "passes" because the app was down is worse
 * than no suite.
 */
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';

export default defineConfig({
  testDir: './tests',
  // Every spec logs in through the real UI and several read the same demo
  // records; running files in parallel against ONE shared database made
  // failures depend on which spec got there first. Serial is slower and
  // honest — this suite is minutes, not hours.
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  // No retries. A retry on a suite like this converts a real intermittent
  // defect into a green run, which is precisely the failure mode that let CI
  // sit red for eleven commits without anyone reading it.
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : [['list']],
  use: {
    baseURL: BASE_URL,
    // The demo box is HTTP-only (blocker B-14) and Playwright's Chromium
    // treats it as an insecure origin, so geolocation and service workers are
    // unavailable there. Specs must not assume either.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['Pixel 7'] },
      // The driver surface is the only mobile-first one (BUILD-PLAN §4.3), so
      // only its spec runs on a phone viewport.
      testMatch: /driver\.spec\.ts/,
    },
  ],
});
