import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatDateOnly } from '../src/common/date-only.util';

/**
 * A CALENDAR DATE MUST NOT BE READ BACK THROUGH UTC.
 *
 * node-pg parses a Postgres `DATE` with the LOCAL-timezone constructor, so
 * `.toISOString()` on that value re-reads it as UTC and shifts the calendar day
 * by the server's offset. Under `Asia/Makassar` (UTC+8, D-11's mandated
 * timezone) that is one full day EARLY. The same applies on the write path: a
 * fresh `new Date().toISOString().slice(0, 10)` is yesterday until 08:00 local,
 * so "today" is wrong for the first eight hours of every day.
 *
 * `common/date-only.util.ts` exists for this and its own docstring names five
 * modules that hit it before anyone wrote a guard: accounting, purchasing,
 * supplier, replenishment and delivery — the last two each carrying a private
 * copy that was subtly wrong in the same way.
 *
 * It has now happened three more times:
 *
 *   * `pos-mappers.ts` — every GoFood and ShopeeFood order displayed one day
 *     early. Found 2026-09-04 by recording an order dated the 4th and reading
 *     back the 3rd while the database row said the 4th. That is revenue
 *     attributed to the wrong day, on a platform outlets reconcile against the
 *     provider's own statements.
 *   * `journal.service.ts` — a reversal entry dated `new Date().toISOString()`,
 *     which before 08:00 local carries the previous day and can land in a
 *     fiscal period that is already closed.
 *   * `import.service.ts` — an imported contract starting "yesterday".
 *
 * Eight modules, one mistake. That is what a guard is for.
 */

const SRC = join(__dirname, '..', 'src');

/**
 * Formatting a Date as a calendar day by going through UTC.
 *
 * `Date.UTC(...)` and `getUTC*` arithmetic are NOT matched: a helper that
 * builds its value in UTC and reads it back in UTC is internally consistent
 * and correct (`dashboard/overview.service.ts` and `inventory.service.ts` both
 * do this deliberately). What breaks is mixing the two.
 */
const UTC_DATE_SLICE =
  /\.toISOString\(\)\s*\.\s*(?:slice\(0,\s*10\)|substring\(0,\s*10\)|split\('T'\)\[0\])/;

/** Lines where the value being formatted was constructed in UTC on the spot. */
const BUILT_IN_UTC = /Date\.UTC\(|getUTCDate\(|T00:00:00(?:\.000)?Z/;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue;
      walk(full, out);
    } else if (entry.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe('calendar dates are not read back through UTC', () => {
  it('formats a DATE the same way the database stored it', () => {
    // The property the helper exists to provide, pinned so a "simplification"
    // cannot quietly reintroduce the bug. pg hands us a Date built with the
    // LOCAL constructor; the local getters are what recover the original day.
    const asPgWouldParse = new Date(2026, 8, 4); // 4 Sep 2026, local
    expect(formatDateOnly(asPgWouldParse)).toBe('2026-09-04');

    // And the failure mode itself, so the test documents what it is preventing.
    const throughUtc = asPgWouldParse.toISOString().slice(0, 10);
    expect(
      throughUtc === '2026-09-04',
      'this machine is not UTC+something, so the shift cannot be demonstrated here',
    ).toBe(process.env.TZ !== 'Asia/Makassar' ? throughUtc === '2026-09-04' : false);
  });

  it('has no module formatting a date through UTC', () => {
    const offenders: string[] = [];

    for (const file of walk(SRC)) {
      const source = readFileSync(file, 'utf8');
      const lines = source.split('\n');
      lines.forEach((line, i) => {
        if (!UTC_DATE_SLICE.test(line)) return;
        // LOOK BACK A FEW LINES, not just this one. A correct helper builds its
        // value in UTC and reads it back in UTC, but the construction usually sits
        // two or three lines above the format call — checking only the matched
        // line reported all three correct helpers as bugs.
        if (lines.slice(Math.max(0, i - 6), i + 1).some((l) => BUILT_IN_UTC.test(l))) return;
        // The util itself explains the pattern in prose.
        if (file.endsWith(join('common', 'date-only.util.ts'))) return;
        if (line.trim().startsWith('*') || line.trim().startsWith('//')) return;
        offenders.push(`${relative(SRC, file).split(sep).join('/')}:${i + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'these shift the calendar day by the server timezone — use formatDateOnly():\n  ' +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
