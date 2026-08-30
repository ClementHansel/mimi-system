import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import type { Pool, PoolClient } from 'pg';

/**
 * TENANT ISOLATION — the security boundary migration 263 introduces.
 *
 * A cross-tenant leak is the worst failure this system can have and it is
 * SILENT: nothing throws, nothing logs, one client simply sees another
 * company's data. So this proves the boundary against a real database with two
 * real tenants, rather than trusting that the policies read correctly.
 *
 * It creates its own second tenant and removes it again, so it never depends on
 * seed data and leaves none behind.
 *
 * Step 1 scope: `locations` and `users` are the only tables carrying
 * `tenant_id` so far (docs/MULTI-TENANCY.md §4). When step 2 adds the column to
 * the remaining 73, the sweep below should be driven from
 * `information_schema` rather than this hand-written pair — a list that must be
 * maintained by hand is a list that rots, and the thing it stops testing is a
 * data leak.
 */
const APP_URL = `postgres://mimi_app:${process.env.DB_APP_PASSWORD ?? 'mimi_app_secret'}@localhost:${
  process.env.POSTGRES_PORT ?? '55433'
}/${process.env.POSTGRES_DB ?? 'mimi'}`;
const OWNER_URL = `postgres://mimi:${process.env.POSTGRES_PASSWORD ?? 'mimi'}@localhost:${
  process.env.POSTGRES_PORT ?? '55433'
}/${process.env.POSTGRES_DB ?? 'mimi'}`;

const hasDb = process.env.VITEST_LIVE_DB !== 'off';

describe.skipIf(!hasDb)('tenant isolation (live DB, real RLS)', () => {
  let owner: Pool;
  let app: Pool;
  let otherTenantId: string;
  let otherUserId: string;
  let otherLocationId: string;
  let mimiUserId: string;

  beforeAll(async () => {
    owner = new pg.Pool({ connectionString: OWNER_URL, max: 3 });
    app = new pg.Pool({ connectionString: APP_URL, max: 3 });

    const t = await owner.query<{ id: string }>(
      `INSERT INTO tenants (code, name) VALUES ('t-iso-test', 'Isolation Test Co') RETURNING id`,
    );
    otherTenantId = t.rows[0]!.id;

    const loc = await owner.query<{ id: string }>(
      `INSERT INTO locations (code, name, type, city, tenant_id)
       VALUES ('T-ISO-1', 'Isolation Test Outlet', 'outlet', 'Balikpapan', $1) RETURNING id`,
      [otherTenantId],
    );
    otherLocationId = loc.rows[0]!.id;

    const u = await owner.query<{ id: string }>(
      `INSERT INTO users (username, name, password_hash, role_id, is_active, tenant_id)
       SELECT 't_iso_owner', 'Isolation Test Owner', u.password_hash, u.role_id, true, $1
         FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.key = 'owner' LIMIT 1
       RETURNING id`,
      [otherTenantId],
    );
    otherUserId = u.rows[0]!.id;

    const mimi = await owner.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE r.key = 'owner' AND u.tenant_id <> $1 ORDER BY u.username LIMIT 1`,
      [otherTenantId],
    );
    mimiUserId = mimi.rows[0]!.id;
  });

  afterAll(async () => {
    if (owner) {
      await owner.query(`DELETE FROM users WHERE tenant_id = $1`, [otherTenantId]);
      await owner.query(`DELETE FROM locations WHERE tenant_id = $1`, [otherTenantId]);
      await owner.query(`DELETE FROM tenants WHERE id = $1`, [otherTenantId]);
      await owner.end();
    }
    if (app) await app.end();
  });

  /** Exactly what `RlsContextGuard` does per request, on one connection. */
  async function asUser<T>(userId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [userId]);
      await client.query(`SELECT set_config('app.role', 'owner', true)`);
      await client.query(`SELECT set_config('app.tenant_id', app_tenant_of_user($1)::text, true)`, [
        userId,
      ]);
      await client.query(`SELECT set_config('app.location_ids', '', true)`);
      return await fn(client);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  }

  it('an OWNER — the widest role there is — cannot see another tenant’s locations', async () => {
    // Owner is deliberately the subject: it is central, so it bypasses every
    // location check. If the tenant gate holds for owner it holds for everyone
    // narrower. A test using a Kasir would prove almost nothing here.
    const rows = await asUser(mimiUserId, (c) =>
      c.query(`SELECT id FROM locations WHERE id = $1`, [otherLocationId]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('an OWNER cannot see another tenant’s users', async () => {
    const rows = await asUser(mimiUserId, (c) =>
      c.query(`SELECT id FROM users WHERE id = $1`, [otherUserId]),
    );
    expect(rows.rowCount).toBe(0);
  });

  it('the other tenant sees its OWN rows — the gate is not simply shut for everyone', async () => {
    // Without this, a policy of `USING (false)` would pass every test above.
    const loc = await asUser(otherUserId, (c) =>
      c.query(`SELECT id FROM locations WHERE id = $1`, [otherLocationId]),
    );
    expect(loc.rowCount).toBe(1);
    const self = await asUser(otherUserId, (c) =>
      c.query(`SELECT id FROM users WHERE id = $1`, [otherUserId]),
    );
    expect(self.rowCount).toBe(1);
  });

  it('neither tenant’s location list contains the other’s', async () => {
    const mine = await asUser(mimiUserId, (c) => c.query(`SELECT id FROM locations`));
    const theirs = await asUser(otherUserId, (c) => c.query(`SELECT id FROM locations`));
    const mineIds = new Set(mine.rows.map((r) => (r as { id: string }).id));
    const theirIds = theirs.rows.map((r) => (r as { id: string }).id);
    expect(theirIds.length).toBeGreaterThan(0);
    expect(theirIds.filter((id) => mineIds.has(id))).toEqual([]);
  });

  it('FAILS CLOSED: a session that never set app.tenant_id sees nothing', async () => {
    // The failure this guards is a code path that forgets `set_config`. Failing
    // OPEN there would mean every such path silently reads across tenants,
    // which is exactly the bug class that cannot be found by looking at output.
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.user_id', $1, true)`, [mimiUserId]);
      await client.query(`SELECT set_config('app.role', 'owner', true)`);
      // deliberately no app.tenant_id
      const rows = await client.query(`SELECT id FROM locations`);
      expect(rows.rowCount).toBe(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
