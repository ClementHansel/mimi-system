import { test } from '@playwright/test';
import { login, USERS } from './support/app';

// What does a dialog do when submitted empty? Probe three different ones.
const CASES: [string, string, string][] = [
  ['/purchasing', 'Tambah Supplier', 'Simpan'],
  ['/finance', 'Tambah Akun', 'Simpan'],
  ['/admin', 'Tambah Pengguna', 'Simpan'],
];

for (const [route, opener, submit] of CASES) {
  test(`${route} → ${opener} submitted empty`, async ({ page }) => {
    const fails: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/api/') && r.request().method() !== 'GET') {
        fails.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`);
      }
    });
    await login(page, USERS.owner);
    await page.goto(route, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: opener, exact: true }).first().click();
    const dlg = page.getByRole('dialog');
    await dlg.first().waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    const btn = dlg.getByRole('button', { name: submit, exact: true }).first();
    const n = await btn.count();
    console.log(`@@@ ${route} submit "${submit}" count=${n} disabled=${n ? await btn.isDisabled() : 'n/a'}`);
    if (n && !(await btn.isDisabled())) {
      await btn.click();
      await page.waitForTimeout(3000);
      const flat = (await page.locator('body').innerText()).split('\n').filter(Boolean).join(' / ');
      console.log(`@@@ ${route} after empty submit: ` + flat.slice(-260));
    }
    console.log(`@@@ ${route} non-GET calls: ` + (fails.join(' | ') || '(none)'));
  });
}
