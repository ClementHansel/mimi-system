import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { translate } from './index';

/**
 * Every LITERAL `t('a.b.c')` in the app must resolve to a real string.
 *
 * `doc-keys.test.ts` covers the catalog-driven TEMPLATE-literal keys. This is
 * the other half, and it is not redundant: a literal key looks safe precisely
 * because it is spelled out in full, so nobody checks it — and nothing else
 * can. `id.ts` is a plain object literal rather than a typed key union, so
 * `t()` accepts any string and TypeScript is content either way.
 *
 * What a miss actually does, from `translate()`: it returns THE KEY. The
 * `console.warn` beside that return is guarded by
 * `process.env.NODE_ENV !== 'production'`, so a production build says nothing
 * at all. Two live examples this test was written from:
 *
 *   `common.noAccess` — the entire heading of `WarehousePanelPage` when a role
 *     cannot reach a panel, so those users read "common.noAccess".
 *   `common.clear` — the aria-label of `SearchableSelect`'s clear button, so a
 *     screen reader announced "common dot clear" on every long dropdown.
 *
 * Neither appeared in any suite, in CI, or in the console of a production
 * build. Both were one missing line in `id.ts`.
 */

const SRC = resolve(__dirname, '../..');

/**
 * The `[^a-zA-Z0-9_.]` before `t(` is load-bearing. Without it the pattern
 * also matches the tail of `getByText('Aktif')`, `format('...')` and every
 * other identifier ending in `t`, which produced 200+ phantom "missing keys"
 * on the first attempt — all of them ordinary UI strings out of test files.
 */
const LITERAL_T_CALL = /[^a-zA-Z0-9_.]t\('([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)'\)/g;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    // This file's own prose spells out example keys (`t('a.b.c')`), and the
    // scanner cannot tell a doc comment from a call site — it reported itself
    // on the first run. Skipping only THIS file keeps every other test file in
    // scope, which matters: a stale key in a test is still a stale key.
    if (full === __filename) continue;
    if (statSync(full).isDirectory()) sourceFiles(full, acc);
    else if (/\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

function usedKeys(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of sourceFiles(SRC)) {
    const where = file.slice(SRC.length + 1).replace(/\\/g, '/');
    for (const [, key] of readFileSync(file, 'utf8').matchAll(LITERAL_T_CALL)) {
      found.set(key!, [...(found.get(key!) ?? []), where]);
    }
  }
  return found;
}

describe('i18n literal keys', () => {
  it('resolves every literal key the app asks for', () => {
    const missing: string[] = [];
    for (const [key, files] of usedKeys()) {
      // `translate` returns the key itself on a miss, so comparing against the
      // key IS the exact check rather than a proxy for it. A dictionary entry
      // whose value equalled its own key would read as a false positive here;
      // none exists, and one would be a bug in its own right.
      if (translate(key) === key) missing.push(`${key}  (${[...new Set(files)].join(', ')})`);
    }
    expect(
      missing.sort(),
      'these render as the raw key string to real users, and a production build logs nothing about it',
    ).toEqual([]);
  });

  it('actually scans the source tree, rather than passing on an empty set', () => {
    // Without this, a broken regex or a wrong SRC path makes the test above
    // pass by examining zero keys — the standard way a codebase-scanning test
    // rots into decoration while still showing green.
    expect(usedKeys().size).toBeGreaterThan(1_000);
  });
});
