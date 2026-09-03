import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Pool } from 'pg';

/**
 * EVERY STATIC SQL STATEMENT IN THE SOURCE MUST PARSE AGAINST THE REAL SCHEMA.
 *
 * ── WHY ─────────────────────────────────────────────────────────────────────
 * Two of the defects a real user found in this system were SQL that never
 * parsed, and both reached production:
 *
 *   * `supplier_items`'s upsert read an unqualified `supplier_sku` on the
 *     right-hand side of `ON CONFLICT DO UPDATE`, where both the target table
 *     and EXCLUDED are in scope. Postgres refuses that as ambiguous AT PARSE
 *     TIME, so adding OR repricing any supplier item returned 500 — the whole
 *     supplier price list was dead, and the UI swallowed it into a toast, so
 *     the report was "saat klik tambah tidak terjadi apa apa".
 *   * The supplier search built a `$0` placeholder, so every search 500'd and
 *     the screen said "Gagal memuat data".
 *
 * Neither needed a clever test. Both needed the statement to be looked at once
 * by the only thing that can judge it: the database. `PREPARE` does exactly
 * that — it parses, resolves every table and column against the live schema,
 * and plans, WITHOUT executing anything. No fixtures, no writes, no cleanup.
 *
 * A unit test cannot see these, an integration test only sees the statements
 * its own flow happens to execute, and this repo has ~980 static statements
 * across 183 files. Covering them by execution would mean writing hundreds of
 * flows; covering them by parsing costs one query each.
 *
 * ── WHAT THIS DOES NOT COVER, STATED PLAINLY ────────────────────────────────
 * Statements assembled with `${...}` are SKIPPED — roughly 170 of them, the
 * paged/filtered list queries. Their text is not knowable without running the
 * code that builds it, and a half-substituted template does not parse. The
 * count is asserted below so a pass can never be read as "all SQL is checked",
 * and so that a sudden jump in dynamic statements is visible.
 *
 * Parsing is also not behaviour: a statement that parses can still return the
 * wrong rows, write to the wrong place, or be called with the wrong arguments.
 * This closes one class — "the statement was never valid" — completely, and
 * says nothing about the rest.
 */

const SRC = join(__dirname, '..', 'src');

/** Statements whose parameter types Postgres cannot infer without a call site. */
const PARAM_TYPE_ONLY = new Set(['42P08', '42P18']);

interface Extracted {
  file: string;
  sql: string;
}

const SQL_START = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH)\b/i;
/** A real statement names where it reads from or writes to. */
const HAS_TARGET = /\b(FROM|INTO|SET|VALUES)\b/i;

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

function extract(): { statements: Extracted[]; dynamic: number } {
  const statements: Extracted[] = [];
  let dynamic = 0;

  for (const file of walk(SRC)) {
    const source = readFileSync(file, 'utf8');
    // Only files that talk to the database — otherwise every doc comment
    // containing the word SELECT becomes a candidate.
    if (!source.includes('client.query') && !source.includes('pool.query')) continue;

    for (const match of source.matchAll(/`([^`]*)`/g)) {
      const body = match[1]!.trim();
      if (!SQL_START.test(body)) continue;

      if (body.includes('${')) {
        dynamic++;
        continue;
      }

      // PROSE THAT LOOKS LIKE SQL. Comments in this codebase quote statements
      // constantly — "INSERT ... ON CONFLICT", "SELECT * FROM <table>",
      // "WITH CHECK (true)" — and a one-word literal is a label, not a query.
      // Without these four filters, 47 comment fragments arrive as syntax
      // errors and bury the two findings that matter.
      if (body.includes('..') || body.includes('<')) continue;
      if (body.split(/\s+/).length < 4) continue;
      if (!HAS_TARGET.test(body)) continue;

      statements.push({
        file: relative(join(__dirname, '..'), file).split(sep).join('/'),
        sql: body,
      });
    }
  }
  return { statements, dynamic };
}

const OWNER_URL =
  process.env.DATABASE_MIGRATION_URL ??
  `postgres://${process.env.POSTGRES_USER ?? 'mimi'}:${process.env.POSTGRES_PASSWORD ?? 'mimi_secret'}@localhost:${
    process.env.POSTGRES_PORT ?? '55433'
  }/${process.env.POSTGRES_DB ?? 'mimi'}`;

describe('every static SQL statement parses against the real schema', () => {
  let pool: Pool;

  beforeAll(() => {
    // The OWNER connection deliberately: `PREPARE` resolves tables and columns,
    // and doing that as the RLS-enforced runtime role would report a policy
    // refusal as if the statement were malformed.
    pool = new pg.Pool({ connectionString: OWNER_URL, max: 1 });
  });

  afterAll(async () => {
    await pool.end();
  });

  it('has no statement the database refuses to parse', async () => {
    const { statements } = extract();
    expect(
      statements.length,
      'no SQL was extracted — the walker or the filters are broken',
    ).toBeGreaterThan(500);

    const failures: string[] = [];
    const client = await pool.connect();
    try {
      for (const [index, entry] of statements.entries()) {
        const name = `sql_parse_check_${index}`;
        try {
          await client.query(`PREPARE ${name} AS ${entry.sql}`);
          await client.query(`DEALLOCATE ${name}`);
        } catch (err) {
          const e = err as { code?: string; message?: string };
          if (e.code && PARAM_TYPE_ONLY.has(e.code)) continue;
          const oneLine = entry.sql.replace(/\s+/g, ' ').slice(0, 160);
          failures.push(`${entry.file}\n      [${e.code}] ${e.message}\n      ${oneLine}`);
        }
      }
    } finally {
      client.release();
    }

    expect(
      failures,
      `SQL that cannot parse will fail at RUNTIME as a 500, whatever the caller does:\n  ${failures.join('\n  ')}`,
    ).toEqual([]);
  }, 120_000);

  it('reports how much SQL it cannot check, so a pass is not mistaken for coverage', () => {
    const { statements, dynamic } = extract();

    // Not a threshold to satisfy — a number to keep visible. Statements built
    // with `${...}` are the paged/filtered list queries, and they are exactly
    // where the `$0` placeholder bug lived, so nobody should read this suite
    // passing as "the SQL is fine".
    console.log(
      `[sql-parses] ${statements.length} static statements checked, ` +
        `${dynamic} dynamic statements NOT checked (built with template substitution)`,
    );

    expect(dynamic).toBeGreaterThan(0);
  });
});
