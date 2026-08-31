import { describe, expect, it } from 'vitest';
import type { PoolClient } from 'pg';
import { SupplierService } from './supplier.service';

/**
 * Supplier search 500'd on EVERY query. Typing "supp" into the Supplier tab
 * showed "Gagal memuat data" and nothing else (owner's report, 2026-08-31).
 *
 * The `q` branch pushed one `%q%` value, wrote `$n` three times, then rewrote
 * the FIRST `$n` back to `$n - 1` and appended a fourth clause on that same
 * index. With no `active` filter — which is every request the frontend makes,
 * since it never sends `active` — `n` was 1 and the rewrite produced `$0`.
 * Postgres numbers parameters from 1, so the statement was rejected before it
 * ever looked at a row.
 *
 * These tests assert the SQL TEXT against the parameter array, because that
 * relationship is the bug: a fake client is enough, and a live database would
 * only prove the same thing more slowly. Two properties are checked, not one —
 * that every placeholder is in range (the outage), and that the three ILIKE
 * clauses stay INSIDE their parentheses (the latent second defect: an `OR`
 * outside them out-ranks the `is_active IS NOT FALSE` baseline and would list
 * deactivated suppliers to anyone who searched).
 */

interface Captured {
  sql: string;
  params: unknown[];
}

function fakeClient(captured: Captured[]): PoolClient {
  return {
    query: (sql: string, params: unknown[] = []) => {
      captured.push({ sql, params });
      // `list`/`getDirectory` each run a COUNT then a page read; both are
      // satisfied by a shape with an empty `rows` and a numeric `count`.
      return Promise.resolve({ rows: [{ count: '0' }] });
    },
  } as unknown as PoolClient;
}

/** Every `$n` the statement mentions, as numbers. */
function placeholders(sql: string): number[] {
  return [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
}

describe.each([
  ['list', (svc: SupplierService, c: PoolClient) => svc.list(c, 'supp')],
  ['getDirectory', (svc: SupplierService, c: PoolClient) => svc.getDirectory(c, 'supp')],
])('SupplierService.%s — searching by name/code/phone', (_name, run) => {
  it('numbers every placeholder from 1 and never past the parameter count', async () => {
    const captured: Captured[] = [];
    await run(new SupplierService(), fakeClient(captured));

    expect(captured.length).toBeGreaterThan(0);
    for (const { sql, params } of captured) {
      for (const n of placeholders(sql)) {
        // `$0` is the exact statement Postgres refused. Asserting the whole
        // range rather than just `not 0` also catches an off-by-one the other
        // way, which would read a parameter that was never bound.
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(params.length);
      }
    }
  });

  it('binds the search term once, wrapped in wildcards', async () => {
    const captured: Captured[] = [];
    await run(new SupplierService(), fakeClient(captured));

    for (const { params } of captured) {
      expect(params.filter((p) => p === '%supp%')).toHaveLength(1);
    }
  });

  it('keeps the three ILIKE clauses inside one parenthesised group', async () => {
    const captured: Captured[] = [];
    await run(new SupplierService(), fakeClient(captured));

    for (const { sql } of captured) {
      const group = /AND \((name ILIKE \$\d+ OR code ILIKE \$\d+ OR phone ILIKE \$\d+)\)/.exec(sql);
      expect(group).not.toBeNull();
      // Nothing may trail the group with a bare OR — that is what would have
      // let an inactive supplier through the `is_active` baseline.
      expect(sql.slice(group!.index + group![0].length)).not.toMatch(/^\s*OR\b/);
    }
  });
});
