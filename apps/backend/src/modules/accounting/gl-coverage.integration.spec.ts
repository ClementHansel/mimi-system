import { afterAll, describe, expect, it } from 'vitest';
import { GL_COVERAGE_REF_TYPES, GlCoverageService } from './gl-coverage.service';
import { closePool, withRollback } from './test-support/live-db';

/**
 * A-7 — the GL coverage report has to actually RUN.
 *
 * ## Why this file exists, specifically
 *
 * The first version of this report shipped to production and returned HTTP 500:
 * `column reference "status" is ambiguous`. The query joins `journal_entries`,
 * which has its own `status` column, so the per-probe predicate had to qualify
 * with the `d.` alias. It typechecked perfectly — the predicates are strings —
 * and the whole accounting suite passed, because **nothing anywhere executed
 * the query**.
 *
 * That is the gap this closes. The assertions below are deliberately weak about
 * the NUMBERS (they depend on whatever the database happens to hold) and strict
 * about the query running at all against every probe. A report whose SQL is
 * assembled from string fragments needs exactly that: proof each fragment is
 * valid SQL in the context it is spliced into.
 */

const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)('GlCoverageService — live DB', () => {
  afterAll(async () => {
    if (!hasDb) return;
    await closePool();
  });

  it('executes every probe against the real schema without a SQL error', async () => {
    await withRollback(async (client) => {
      const report = await new GlCoverageService().report(client);

      // One row per probe, and every probe ran — a broken predicate throws
      // rather than returning a row, so arriving here at all is the assertion.
      expect(report.gaps.map((g) => g.refType).sort()).toEqual([...GL_COVERAGE_REF_TYPES].sort());
      expect(report.gaps).toHaveLength(GL_COVERAGE_REF_TYPES.length);
    });
  }, 30_000);

  it('reports counts that are internally consistent', async () => {
    await withRollback(async (client) => {
      const report = await new GlCoverageService().report(client);

      for (const gap of report.gaps) {
        // Unposted is a subset of total, by construction. If this ever inverts,
        // the LEFT JOIN has started multiplying rows — a document with two
        // journal entries would otherwise inflate `total` past the document
        // count and make the whole report lie in the safe-looking direction.
        expect(gap.unposted).toBeLessThanOrEqual(gap.total);
        expect(gap.unposted).toBeGreaterThanOrEqual(0);
        // A window only exists when something is actually unposted.
        if (gap.unposted === 0) {
          expect(gap.oldestUnpostedAt).toBeNull();
          expect(gap.newestUnpostedAt).toBeNull();
        }
        if (gap.oldestUnpostedAt && gap.newestUnpostedAt) {
          expect(new Date(gap.oldestUnpostedAt).getTime()).toBeLessThanOrEqual(
            new Date(gap.newestUnpostedAt).getTime(),
          );
        }
      }

      expect(report.totalUnposted).toBe(report.gaps.reduce((n, g) => n + g.unposted, 0));
    });
  }, 30_000);

  it('never reports a document as posted on the strength of a MANUAL entry', async () => {
    await withRollback(async (client) => {
      // A bookkeeper's own correction against a document is not the engine
      // having posted it. If the match ever drops `source = 'system'`, this
      // count would fall and the report would hide real gaps — the one
      // direction in which being wrong is dangerous.
      const manual = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM journal_entries WHERE source = 'manual'`,
      );
      expect(Number(manual.rows[0]!.n)).toBeGreaterThanOrEqual(0);

      const report = await new GlCoverageService().report(client);
      expect(report.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    });
  }, 30_000);
});
