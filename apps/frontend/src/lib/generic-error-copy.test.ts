import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * "GAGAL MASUK" IS A LOGIN MESSAGE, AND ONLY THE LOGIN SCREENS MAY SAY IT.
 *
 * `auth.genericError` is "Gagal masuk. Silakan coba lagi." — *failed to sign
 * in*. It was being passed as the last-resort fallback to `errMsg()` in 33
 * files, so any error the code map had no line for told the user their sign-in
 * had failed. Reported from production 2026-09-03 while adding an item to a
 * supplier: the add did nothing and announced "Gagal masuk. Silakan coba lagi."
 * on a screen with no login on it.
 *
 * It also directly contradicts the owner's standing instruction about error
 * copy ("biar lebih standard dan tidak pakai bahasa teknis"): a message that
 * describes the wrong operation is worse than a vague one, because it sends the
 * reader off to re-authenticate instead of retrying what they were doing.
 *
 * `errors.generic` ("Terjadi kesalahan. Silakan coba lagi.") is the correct
 * last resort and is what every non-auth caller now passes.
 */
const SRC = join(__dirname, '..');
const AUTH_ROUTES = join('app', '(auth)');

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

describe('generic error copy', () => {
  it('only the login screens use the sign-in failure message', () => {
    const offenders = walk(SRC).filter((file) => {
      if (file.includes(AUTH_ROUTES)) return false;
      // The dictionary itself has to define the string, and this test has to
      // name it to check for it.
      if (file.endsWith(join('i18n', 'id.ts'))) return false;
      if (file.endsWith('generic-error-copy.test.ts')) return false;
      return readFileSync(file, 'utf8').includes('auth.genericError');
    });

    expect(
      offenders.map((f) => f.slice(SRC.length + 1)),
      'these screens would tell the user their sign-in failed — pass errors.generic instead',
    ).toEqual([]);
  });
});
