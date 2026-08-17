import { describe, it, expect, vi } from 'vitest';
import { ScopeService } from './scope.service';

function makeClient(handlers: Record<string, unknown[]>) {
  return {
    query: vi.fn(async (sql: string) => {
      for (const [needle, rows] of Object.entries(handlers)) {
        if (sql.includes(needle)) return { rows };
      }
      return { rows: [] };
    }),
  };
}

describe('ScopeService', () => {
  // Phase 2 always runs on the caller-supplied client (never a connection of
  // its own — see the class-level comment on why: this makes it structurally
  // impossible to query outside the RLS-scoped transaction RlsContextGuard
  // already opened).
  let client: ReturnType<typeof makeClient>;

  const central = ['owner', 'manager', 'finance', 'hr_admin'];
  for (const roleKey of central) {
    it(`resolves ${roleKey} to null (unrestricted) without querying the database`, async () => {
      client = makeClient({});
      const service = new ScopeService();
      const result = await service.resolveLocationIds(client as never, { sub: 'user-1', roleKey });
      expect(result).toBeNull();
      expect(client.query).not.toHaveBeenCalled();
    });
  }

  for (const roleKey of ['supervisor', 'leader_outlet', 'kasir']) {
    it(`resolves ${roleKey} to exactly their user_locations assignment`, async () => {
      client = makeClient({
        'FROM user_locations': [{ location_id: 'loc-outlet-1' }],
      });
      const service = new ScopeService();
      const result = await service.resolveLocationIds(client as never, { sub: 'user-2', roleKey });
      expect(result).toEqual(['loc-outlet-1']);
    });
  }

  /**
   * THE regression test the coordinator flagged: if RLS were ever silently
   * bypassed (the exact failure mode of the rejected "app owns these
   * tables" design), a broken self-read policy, or a query that forgot its
   * WHERE clause, this is what would quietly start returning OTHER users'
   * — or ALL — location assignments instead of an empty scope. A
   * scoped-role user who owns zero `user_locations` rows must get back
   * `[]`, never `null` (unrestricted) and never a non-empty set.
   */
  for (const roleKey of ['supervisor', 'leader_outlet', 'kasir']) {
    it(`returns an empty scope — not every location — for a ${roleKey} who owns zero user_locations rows`, async () => {
      client = makeClient({ 'FROM user_locations': [] });
      const service = new ScopeService();
      const result = await service.resolveLocationIds(client as never, { sub: 'ghost-user', roleKey });
      expect(result).toEqual([]);
      expect(result).not.toBeNull();
    });
  }

  it('scopes the user_locations lookup by the exact caller-supplied user id — never an unscoped read', async () => {
    client = makeClient({ 'FROM user_locations': [] });
    const service = new ScopeService();
    await service.resolveLocationIds(client as never, { sub: 'user-scoped-check', roleKey: 'kasir' });

    const call = client.query.mock.calls.find(([sql]: [string]) => sql.includes('FROM user_locations'));
    expect(call).toBeDefined();
    expect(call![0]).toContain('WHERE user_id = $1');
    expect(call![1]).toEqual(['user-scoped-check']);
  });

  it('resolves kepala_gudang to their warehouse(s) union shipping destinations', async () => {
    client = makeClient({
      'FROM user_locations': [{ location_id: 'loc-warehouse' }],
      'FROM sj_drops': [{ location_id: 'loc-outlet-a' }, { location_id: 'loc-outlet-b' }],
    });
    const service = new ScopeService();
    const result = await service.resolveLocationIds(client as never, { sub: 'user-3', roleKey: 'kepala_gudang' });
    expect(result).not.toBeNull();
    expect(new Set(result)).toEqual(new Set(['loc-warehouse', 'loc-outlet-a', 'loc-outlet-b']));
  });

  it('resolves kepala_gudang with no warehouse assignment to an empty scope, skipping the drops query', async () => {
    client = makeClient({ 'FROM user_locations': [] });
    const service = new ScopeService();
    const result = await service.resolveLocationIds(client as never, { sub: 'user-4', roleKey: 'kepala_gudang' });
    expect(result).toEqual([]);
  });

  it('resolves driver to the outlets on their active Surat Jalan plus the loading warehouse', async () => {
    client = makeClient({
      'FROM drivers': [{ id: 'driver-row-1' }],
      'FROM sj_drops': [{ location_id: 'loc-outlet-x' }],
      'FROM surat_jalan': [{ origin_location_id: 'loc-warehouse' }],
    });
    const service = new ScopeService();
    const result = await service.resolveLocationIds(client as never, { sub: 'user-5', roleKey: 'driver' });
    expect(new Set(result)).toEqual(new Set(['loc-outlet-x', 'loc-warehouse']));
  });

  it('resolves a driver with no matching drivers row to an empty scope', async () => {
    client = makeClient({ 'FROM drivers': [] });
    const service = new ScopeService();
    const result = await service.resolveLocationIds(client as never, { sub: 'user-6', roleKey: 'driver' });
    expect(result).toEqual([]);
  });
});
