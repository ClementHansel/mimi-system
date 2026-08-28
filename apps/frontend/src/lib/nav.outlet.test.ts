/**
 * The Outlet sidebar (owner, 2026-08-27: "these top tab need to be changed into
 * outlet sidebar"). Eight flows that used to be tabs are now eight routes.
 *
 * WHY A FILESYSTEM CHECK. Turning tabs into nav entries moves the failure mode:
 * a tab could not point at nothing, but an `href` typo gives a sidebar row that
 * 404s, and nothing else in the suite would notice — the nav renders fine, the
 * page just is not there. So this walks the real `app/outlet` directory and
 * insists every entry has a page, and that every page has an entry (an
 * orphaned route is a screen nobody can reach).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { INTERFACES } from './nav';

const APP_OUTLET = join(process.cwd(), 'src', 'app', 'outlet');

const outletInterface = INTERFACES.find((i) => i.id === 'outlet');
const outletSection = outletInterface?.sections.find((s) => s.id === 'outlet');
const items = outletSection?.items ?? [];

describe('outlet sidebar', () => {
  it('lists the eight flows the owner asked for, in working-day order', () => {
    expect(items.map((i) => i.href)).toEqual([
      '/outlet', // Minta Barang
      '/outlet/terima',
      '/outlet/stok',
      '/outlet/opname',
      '/outlet/waste',
      '/outlet/retur',
      '/outlet/kas-kecil',
      '/outlet/jadwal',
    ]);
  });

  it('gives every entry a page that exists', () => {
    for (const item of items) {
      const sub = item.href.replace(/^\/outlet\/?/, '');
      const file = join(APP_OUTLET, sub, 'page.tsx');
      expect(existsSync(file), `${item.href} -> ${file}`).toBe(true);
    }
  });

  it('leaves no page unreachable from the sidebar', () => {
    const hrefs = new Set(items.map((i) => i.href));
    for (const entry of readdirSync(APP_OUTLET)) {
      const dir = join(APP_OUTLET, entry);
      if (!statSync(dir).isDirectory()) continue;
      if (!existsSync(join(dir, 'page.tsx'))) continue;
      expect(hrefs.has(`/outlet/${entry}`), `/outlet/${entry} has no sidebar entry`).toBe(true);
    }
  });

  it('marks only the root entry `exact`', () => {
    // `/outlet` is a prefix of the other seven, so without `exact` it stays lit
    // on all of them and the sidebar shows two active rows at once. Conversely
    // an `exact` on a leaf would be harmless but pointless — flag drift either way.
    expect(items.filter((i) => i.exact).map((i) => i.href)).toEqual(['/outlet']);
  });

  it('gives every entry a distinct id and a permission to gate on', () => {
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // No entry may be ungated: these screens edit stock, cash and waste. An
    // undefined permission means "everyone who can sign in" (see `NavItem`).
    for (const item of items) {
      expect(item.permission, item.id).toBeDefined();
    }
  });

  it('claims every /outlet/* route for the outlet interface', () => {
    // `routes` is matched by prefix. Without `/outlet` in it, opening a
    // sub-flow would bounce the user into a different interface's shell.
    expect(outletInterface?.routes).toContain('/outlet');
  });
});
