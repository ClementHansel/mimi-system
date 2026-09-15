import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * MA-206 — "tidak ada response ketika klik berangkatkan di surat jalan".
 *
 * The toast viewport was `z-50`, and so are `Drawer` and `Modal`
 * (`fixed inset-0 z-50`). At equal z-index the later element in DOM order wins,
 * and an overlay opened by the user mounts after the app-shell-level viewport —
 * so every toast raised by an action taken INSIDE a drawer or modal was painted
 * underneath it.
 *
 * Reproduced in a real browser before the fix: clicking "Berangkatkan" on a
 * Surat Jalan with no stock returned 422, the toast element existed, Playwright's
 * `isVisible()` returned true — it does not test occlusion — and
 * `document.elementFromPoint` at the toast's own centre returned the drawer's
 * "Surat Jalan" button. Nothing was on screen for the user. After the fix the
 * same probe returns the toast's own `<p>Stok tidak mencukupi.</p>`.
 *
 * This is asserted against the SOURCE rather than a rendered DOM because jsdom
 * does not apply Tailwind, so a rendered computed `z-index` is always `auto`
 * here and a render-based test would pass no matter how the classes changed —
 * which is exactly the kind of test that let this through.
 */
/**
 * Reads the z-index off the `className` of the component's own top-level
 * `fixed` container.
 *
 * Deliberately scans only quoted `className` values, never the whole file: the
 * first version of this matched anywhere in the source and happily picked
 * `z-[60]` out of the PROSE of the comment above, so it reported the fix as
 * present while the actual class still said `z-50`. It passed against the very
 * bug it exists to catch.
 */
function zIndexOf(relativePath: string): number {
  const source = readFileSync(join(__dirname, relativePath), 'utf8');
  const classNames = [...source.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\}|\{'([^']*)'\})/g)]
    .map((m) => m[1] ?? m[2] ?? m[3] ?? '')
    .filter((c) => /\bfixed\b/.test(c) && /\bz-/.test(c));
  if (classNames.length === 0) throw new Error(`no fixed+z-index className in ${relativePath}`);
  const zs = classNames
    .map((c) => c.match(/\bz-\[(\d+)\]|\bz-(\d+)\b/))
    .map((m) => (m ? Number(m[1] ?? m[2]) : NaN))
    .filter((n) => Number.isFinite(n));
  if (zs.length === 0) throw new Error(`no z-index value parsed in ${relativePath}`);
  return Math.max(...zs);
}

describe('MA-206 — a toast must outrank every overlay it can be raised from', () => {
  const toastZ = zIndexOf('./Toast.tsx');

  it('the toast viewport sits above Drawer', () => {
    // A drawer is where "Berangkatkan" lives. Equal is NOT good enough: at a tie
    // the overlay wins on DOM order and the message is invisible.
    expect(toastZ).toBeGreaterThan(zIndexOf('./Drawer.tsx'));
  });

  it('the toast viewport sits above Modal', () => {
    // The load dialog (seal numbers, temperature) is a Modal, and MA-205's
    // out-of-stock refusal is raised from inside it.
    expect(toastZ).toBeGreaterThan(zIndexOf('./Modal.tsx'));
  });

  it('is a real number, not an accidental match on some other class', () => {
    expect(Number.isFinite(toastZ)).toBe(true);
    expect(toastZ).toBeGreaterThan(0);
  });
});
