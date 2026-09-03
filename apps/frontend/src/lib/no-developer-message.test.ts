import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `ApiError.message` IS FOR DEVELOPERS AND MUST NEVER REACH A SCREEN.
 *
 * CONTRACTS.md §0 fixes the error shape as `{statusCode, code, message,
 * details?}` and says plainly that `message` is a developer fallback. It reads
 * like `Opname 8f2c… is 'submitted', not 'counting'` or `Role 'supervisor' is
 * not assigned to location c2f9…` — English, with row ids in it.
 *
 * It was rendered at 49 call sites in 38 files, as
 * `err instanceof ApiError ? err.message : t('table.error')`. That is the
 * mechanism behind the owner's very first request in this engagement — "error
 * code nya mungkin bisa dicek lagi ya untuk yang lainnya jg, biar lebih
 * standard dan tidak pakai bahasa teknis" — and it survived the server-side
 * SQLSTATE mapping and the code→sentence table, because these sites bypass
 * both and print the raw string.
 *
 * `apiErrorText` (via `errMsg`) is the one path: field-aware code → code →
 * status class → caller's fallback, and it never returns `message`.
 *
 * ── WHY A FILE SCAN AND NOT A UNIT TEST ─────────────────────────────────────
 * The defect is not that any one function is wrong — `apiErrorText` was
 * already correct and already tested. It is that 38 files declined to call it.
 * Only reading the source can see that, and the same scan is what will notice
 * the 39th.
 */
const SRC = join(__dirname, '..');

/**
 * Reading `err.message` to SHOW it. `console.*` and rethrows are fine.
 *
 * Matches the message being CHOSEN by a ternary in ANY shape, not just the one
 * the original 49 sites happened to use. Two of them nested the check
 * differently — `err instanceof ApiError && err.code === X ? ... : err.message`
 * and `... && !details ? err.message : undefined` — and slipped straight past a
 * regex pinned to the common form, which is why this matches on the `?` rather
 * than on the `instanceof`.
 */
const RENDERS_DEVELOPER_MESSAGE = /\?\s*err(?:or)?\.message\b/;

/**
 * The two files allowed to name the field.
 *
 * `api-error.ts` IS the mapping layer: its header explains the anti-pattern it
 * replaces, which means quoting it, and a scan that cannot tell a comment from
 * code flags the fix as the defect. This file quotes it for the same reason.
 */
const EXEMPT = ['api-error.ts', 'no-developer-message.test.ts'];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules' || entry === '.next') continue;
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("the API error's developer message", () => {
  it('is never chosen as the text to display', () => {
    const offenders = walk(SRC)
      .filter((f) => !EXEMPT.some((e) => f.endsWith(e)))
      .filter((f) => RENDERS_DEVELOPER_MESSAGE.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));

    expect(
      offenders,
      'these render ApiError.message at the user — pass the error to errMsg(err, fallback) instead',
    ).toEqual([]);
  });

  it('is not smuggled through as a toast description either', () => {
    // The same leak with a different shape: the sentence comes from `errMsg`
    // and the developer string is appended underneath as `description`, which
    // is exactly as visible.
    const offenders = walk(SRC)
      .filter((f) => !f.endsWith('no-developer-message.test.ts'))
      .filter((f) => /description:\s*err(?:or)?\.message\b/.test(readFileSync(f, 'utf8')))
      .map((f) => f.slice(SRC.length + 1));

    expect(offenders, 'these put ApiError.message in a toast description').toEqual([]);
  });
});
