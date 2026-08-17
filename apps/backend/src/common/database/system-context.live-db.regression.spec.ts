import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { withSystemContext, SYSTEM_CENTRAL_ROLE, SYSTEM_SENTINEL_USER_ID } from './system-context';

/**
 * THE test for the empty-string GUC sentinel. A mock-based unit test
 * (`system-context.spec.ts`) cannot reproduce this bug at all — it is a
 * real Postgres session-level behavior (a placeholder GUC, once touched by
 * ANY `SET LOCAL` on a physical connection, reports `''` instead of `NULL`
 * for the rest of that connection's life, even across COMMIT/ROLLBACK) that
 * only exists against a real server. A test on a FRESH connection would not
 * reproduce it either — the bug only manifests on a RECYCLED one, which is
 * every connection in a pooled application after its first authenticated
 * request. `appPool` below is built with `max: 1` specifically to force
 * every `connect()`/`release()` cycle in this file to reuse the exact same
 * physical connection, deterministically, rather than hoping the default
 * pool happens to hand back the same one.
 *
 * DELIBERATELY does not go through a real table/RLS policy (e.g. `users`):
 * W1-C is independently fixing `app_is_self()` itself to guard
 * `NULLIF(current_setting(...), '') IS NOT NULL` — and by the time this was
 * written, that fix had already landed, so a query through `users_select`
 * no longer reproduces the crash regardless of whether this file's sentinel
 * is present. That is the CORRECT outcome for that migration, but it would
 * make a `users`-based test here a false negative for the mechanism this
 * file actually guards: this is deliberately a standalone SQL expression
 * that reproduces the raw GUC behavior the sentinel exists for, independent
 * of any table, policy, or migration's current state — so it stays
 * meaningful "belt-and-braces" evidence exactly as the coordinator asked,
 * rather than silently losing its signal the moment the other team's fix lands.
 */
describe.skipIf(!process.env.DATABASE_URL)(
  'system-context (live DB): the empty-string GUC sentinel on a RECYCLED connection',
  () => {
    let appPool: Pool;

    beforeAll(() => {
      appPool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    });

    afterAll(async () => {
      await appPool.end();
    });

    /** An arbitrary, fixed comparison UUID — stands in for what a real RLS helper like `app_is_self()` compares `app.user_id` against. Never equal to the sentinel. */
    const COMPARISON_UUID = '11111111-1111-1111-1111-111111111111';

    /** The exact shape `app_is_self()` had BEFORE W1-C's NULLIF fix: `IS NOT NULL` alone, which an empty string satisfies, followed by an unguarded `::uuid` cast. */
    const OLD_UNGUARDED_EXPRESSION = `
      SELECT (
        current_setting('app.user_id', true) IS NOT NULL
        AND current_setting('app.user_id', true)::uuid = '${COMPARISON_UUID}'::uuid
      ) AS result
    `;

    /**
     * Reproduces exactly what `RlsContextGuard` + `RlsCleanupInterceptor` do
     * for one real authenticated request: BEGIN, phase 0/1 session vars set
     * with `app.user_id` a REAL-shaped uuid, a query, then the guaranteed
     * ROLLBACK. This is the history every pooled connection accumulates in
     * production after serving its first request — not a contrived edge case.
     */
    async function poisonConnectionWithAPriorAuthenticatedRequest(): Promise<void> {
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SET LOCAL ROLE app_user');
        await client.query(`SELECT set_config('app.role', 'kasir', true)`);
        await client.query(`SELECT set_config('app.user_id', $1, true)`, [
          '99999999-9999-9999-9999-999999999999',
        ]);
        await client.query(`SELECT set_config('app.location_ids', 'loc-x', true)`);
        await client.query('SELECT 1');
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    }

    it('reproduces the bug: the pre-NULLIF-fix expression shape throws 22P02 on a recycled connection when app.user_id is left unset', async () => {
      await poisonConnectionWithAPriorAuthenticatedRequest();

      // Same physical connection (appPool has max: 1). Deliberately do NOT
      // set app.user_id — the assumption the original, unfixed
      // `assertSystemContext` made, which held only on a connection that
      // had NEVER set the GUC before.
      const client = await appPool.connect();
      try {
        await client.query('BEGIN');
        await expect(client.query(OLD_UNGUARDED_EXPRESSION)).rejects.toThrow(/invalid input syntax for type uuid/i);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    });

    it('the canonical withSystemContext\'s sentinel survives the identical recycled-connection history against that same expression shape', async () => {
      await poisonConnectionWithAPriorAuthenticatedRequest();

      // Same physical connection again — this time asserting the real
      // sentinel via withSystemContext first. If the sentinel were
      // missing, this would throw the exact same 22P02 the test above
      // reproduces; instead it evaluates to a normal, safe `false`
      // (the sentinel never equals COMPARISON_UUID).
      const result = await withSystemContext(appPool, { role: SYSTEM_CENTRAL_ROLE }, async (client) => {
        const res = await client.query<{ result: boolean }>(OLD_UNGUARDED_EXPRESSION);
        return res.rows[0]!.result;
      });

      expect(result).toBe(false);
    });

    it('sanity: the sentinel constant itself is never equal to an arbitrary real-looking uuid', () => {
      expect(SYSTEM_SENTINEL_USER_ID).not.toBe(COMPARISON_UUID);
    });
  },
);
