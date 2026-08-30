import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RlsContextGuard, RequestWithDbContext } from './rls-context.guard';
import { RlsCleanupInterceptor } from '../interceptors/rls-cleanup.interceptor';

function makeContext(request: RequestWithDbContext, isPublic = false): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getHandler: () => ({ __public: isPublic }),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('RlsContextGuard', () => {
  let mockClient: { query: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> };
  let mockPool: { connect: ReturnType<typeof vi.fn> };
  let scope: { resolveLocationIds: ReturnType<typeof vi.fn> };
  let reflector: Reflector;
  let guard: RlsContextGuard;
  let callLog: string[];

  beforeEach(() => {
    callLog = [];
    mockClient = {
      query: vi.fn(async (sql: string) => {
        callLog.push(sql);
        // `app_tenant_of_user` is the one query whose RESULT the guard acts on
        // — it refuses the request when no tenant comes back. A blanket
        // `{ rows: [] }` therefore makes every test fail for the wrong reason.
        if (sql.includes('app_tenant_of_user')) return { rows: [{ tenant_id: 'tenant-1' }] };
        return { rows: [] };
      }),
      release: vi.fn(() => callLog.push('RELEASE')),
    };
    mockPool = { connect: vi.fn(async () => mockClient) };
    scope = { resolveLocationIds: vi.fn() };
    reflector = new Reflector();
    // Public bypass is driven by getAllAndOverride, which reads SetMetadata —
    // since we build ExecutionContext by hand in these tests, stub the
    // reflector method directly rather than wiring real Nest metadata.
    guard = new RlsContextGuard(mockPool as never, scope as never, reflector);
  });

  it('returns true and skips everything for a @Public() route', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
    const request: RequestWithDbContext = {};
    const result = await guard.canActivate(makeContext(request, true));
    expect(result).toBe(true);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('returns false when request.user is missing (defensive — JwtAuthGuard should already reject)', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const request: RequestWithDbContext = {};
    const result = await guard.canActivate(makeContext(request));
    expect(result).toBe(false);
    expect(mockPool.connect).not.toHaveBeenCalled();
  });

  it('sets app.user_id / app.role / app.location_ids via bound set_config, never string interpolation', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    scope.resolveLocationIds.mockResolvedValue(['loc-1', 'loc-2']);
    const request: RequestWithDbContext = {
      user: { sub: 'user-1', username: 'kasir1', roleKey: 'kasir', locationIds: ['loc-1'] },
    };

    const result = await guard.canActivate(makeContext(request));

    expect(result).toBe(true);
    expect(mockClient.query).toHaveBeenCalledWith('BEGIN');
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('set_config'), [
      'user-1',
    ]);
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('set_config'), ['kasir']);
    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('set_config'), [
      'loc-1,loc-2',
    ]);
    expect(request.dbClient).toBe(mockClient);
    expect(request.locationScope).toEqual(['loc-1', 'loc-2']);
  });

  /**
   * Phase 0 — the incident fix. `SET LOCAL ROLE app_user` is THE line that
   * closes the RLS-bypass hole: everything else in this guard was already
   * correct, but nothing ever dropped out of a superuser/BYPASSRLS login
   * role, so `FORCE ROW LEVEL SECURITY` (W1-C) never actually applied. This
   * must run before phase 1's session vars — a role switch after the vars
   * were set would still have executed phase 2's RLS-dependent reads under
   * the wrong (privileged) role.
   */
  it('issues SET LOCAL ROLE app_user as phase 0, immediately after BEGIN and before any session var is set', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    scope.resolveLocationIds.mockResolvedValue([]);
    const request: RequestWithDbContext = {
      user: { sub: 'user-7', username: 'u7', roleKey: 'kasir', locationIds: [] },
    };

    await guard.canActivate(makeContext(request));

    expect(callLog[0]).toBe('BEGIN');
    expect(callLog[1]).toBe('SET LOCAL ROLE app_user');
    // Nothing that looks like a session var is set before the role switch.
    expect(callLog.slice(0, 2).some((sql) => sql.includes('set_config'))).toBe(false);
  });

  it('uses no bind parameter for SET LOCAL ROLE — the role name is a fixed literal, never user input', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    scope.resolveLocationIds.mockResolvedValue([]);
    const request: RequestWithDbContext = {
      user: { sub: 'user-8', username: 'u8', roleKey: 'kasir', locationIds: [] },
    };

    await guard.canActivate(makeContext(request));

    const roleCall = mockClient.query.mock.calls.find(([sql]) => sql === 'SET LOCAL ROLE app_user');
    expect(roleCall).toEqual(['SET LOCAL ROLE app_user']); // exactly one arg — no params array
  });

  it('runs the phases in order: app.user_id/app.role/app.tenant_id set BEFORE ScopeService runs, app.location_ids set AFTER — on the SAME client', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    // CAPTURE inside the mock, ASSERT outside it.
    //
    // This used to `expect(...)` directly inside `resolveLocationIds`, where
    // the guard's own try/catch swallows the thrown assertion and turns the
    // failure into `return false` — after which the test's remaining
    // expectations still pass. It was proven inert when phase 1.5 took the
    // set_config count from 2 to 3 and this test kept reporting green.
    let sawAtScopeTime: string[] = [];
    scope.resolveLocationIds.mockImplementation(async () => {
      sawAtScopeTime = callLog.filter((sql) => sql.includes('set_config'));
      return ['loc-9'];
    });
    const request: RequestWithDbContext = {
      user: { sub: 'user-9', username: 'u9', roleKey: 'supervisor', locationIds: ['loc-9'] },
    };

    await guard.canActivate(makeContext(request));

    // Exactly the three that must precede scope resolution — user_id, role and
    // tenant_id — and NOT location_ids, which is phase 2's own output.
    expect(sawAtScopeTime).toHaveLength(3);
    expect(sawAtScopeTime.some((sql) => sql.includes('app.tenant_id'))).toBe(true);
    expect(sawAtScopeTime.some((sql) => sql.includes('app.location_ids'))).toBe(false);

    // ScopeService is called with THIS request's client (phase 2 runs under
    // the same RLS transaction phase 1 opened, never a separate connection)
    // and the plain {sub, roleKey} shape — not the raw JwtAccessPayload.
    expect(scope.resolveLocationIds).toHaveBeenCalledWith(mockClient, {
      sub: 'user-9',
      roleKey: 'supervisor',
    });
    // And app.location_ids is set only after phase 2 resolves: four in total.
    expect(callLog.filter((sql) => sql.includes('set_config'))).toHaveLength(4);
  });

  it('REFUSES the request when no tenant resolves, rather than opening a scopeless session', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    // A user row with no tenant. `app_in_tenant()` fails closed, so such a
    // session would see nothing anyway — but "sees nothing" is
    // indistinguishable from "this client has no data", which is the shape a
    // silent tenancy bug takes. Refusing says so out loud.
    mockClient.query.mockImplementation(async (sql: string) => {
      callLog.push(sql);
      if (sql.includes('app_tenant_of_user')) return { rows: [{ tenant_id: null }] };
      return { rows: [] };
    });
    scope.resolveLocationIds.mockResolvedValue([]);
    const request: RequestWithDbContext = {
      user: { sub: 'user-nt', username: 'nt', roleKey: 'kasir', locationIds: [] },
    };

    expect(await guard.canActivate(makeContext(request))).toBe(false);
    // And it must not leave the connection checked out — this guard is the one
    // that leaked the whole pool once already (see app.module.ts).
    expect(callLog).toContain('RELEASE');
    expect(callLog.some((sql) => sql.includes('app.tenant_id'))).toBe(false);
  });

  it('resolves the tenant from the user id ONLY — never from anything the caller can set', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    scope.resolveLocationIds.mockResolvedValue([]);
    // A hostile payload: headers and body carrying another tenant. The guard
    // reads neither. This is the tenant-escape vector the whole boundary
    // exists to prevent, and it is cheap to assert we never opened the door.
    const request = {
      user: { sub: 'user-t', username: 't', roleKey: 'kasir', locationIds: [] },
      headers: { 'x-tenant-id': 'attacker-tenant' },
      body: { tenantId: 'attacker-tenant' },
      query: { tenantId: 'attacker-tenant' },
    } as unknown as RequestWithDbContext;

    await guard.canActivate(makeContext(request));

    // No parameter annotation: `mock.calls` is `any[][]`, so declaring the
    // element as the tuple `[string]` is a narrowing TypeScript refuses (an
    // `any[]` may be empty). The inferred `any` is what line 120 already does.
    const tenantCall = mockClient.query.mock.calls.find(([sql]) =>
      sql.includes('app_tenant_of_user'),
    );
    expect(tenantCall?.[1]).toEqual(['user-t']);
    const setTenant = mockClient.query.mock.calls.find(([sql]) => sql.includes('app.tenant_id'));
    expect(setTenant?.[1]).toEqual(['tenant-1']);
    expect(JSON.stringify(mockClient.query.mock.calls)).not.toContain('attacker-tenant');
  });

  it('sets an empty app.location_ids for an unrestricted (central) role', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    scope.resolveLocationIds.mockResolvedValue(null);
    const request: RequestWithDbContext = {
      user: { sub: 'owner-1', username: 'owner', roleKey: 'owner', locationIds: [] },
    };

    await guard.canActivate(makeContext(request));

    expect(mockClient.query).toHaveBeenCalledWith(expect.stringContaining('set_config'), ['']);
    expect(request.locationScope).toBeNull();
  });

  it('rolls back and releases the client if setting session vars fails', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    scope.resolveLocationIds.mockResolvedValue([]);
    mockClient.query = vi
      .fn()
      .mockResolvedValueOnce(undefined) // BEGIN
      .mockRejectedValueOnce(new Error('set_config failed')) // first set_config
      .mockResolvedValue(undefined); // ROLLBACK (and anything after)

    const request: RequestWithDbContext = {
      user: { sub: 'user-2', username: 'u2', roleKey: 'kasir', locationIds: [] },
    };

    const result = await guard.canActivate(makeContext(request));

    expect(result).toBe(false);
    expect(mockClient.query).toHaveBeenCalledWith('ROLLBACK');
    expect(mockClient.release).toHaveBeenCalled();
  });

  /**
   * THE test that matters (per the W1-D brief): a connection released back
   * to the pool must never leak one request's session vars into the next
   * request that happens to receive the SAME underlying connection. We
   * simulate pool reuse by having `pool.connect()` return the identical
   * mock client both times, and drive the full guard→interceptor cycle for
   * two different users in sequence.
   */
  it('never leaks session state across two requests sharing one pooled connection', async () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(false);
    const interceptor = new RlsCleanupInterceptor();

    // --- Request A: Kasir at outlet loc-A ---------------------------------
    scope.resolveLocationIds.mockResolvedValueOnce(['loc-A']);
    const requestA: RequestWithDbContext = {
      user: { sub: 'user-A', username: 'a', roleKey: 'kasir', locationIds: ['loc-A'] },
    };
    await guard.canActivate(makeContext(requestA));
    expect(requestA.dbClient).toBe(mockClient);

    // Drive the interceptor's cleanup for request A the same way the real
    // rxjs pipeline does (see rls-cleanup.interceptor.spec.ts for the full
    // Observable-chain test) — invoke the documented rollback-then-release
    // contract directly so this test's signal stays on session isolation,
    // not on re-proving rxjs wiring already covered there.
    await (interceptor as unknown as { release(r: RequestWithDbContext): Promise<void> }).release(
      requestA,
    );

    expect(callLog).toContain('ROLLBACK');
    expect(callLog[callLog.length - 1]).toBe('RELEASE');
    expect(requestA.dbClient).toBeUndefined();

    const callsAfterRequestA = mockClient.query.mock.calls.length;

    // --- Request B: a DIFFERENT user, Owner, reusing the SAME connection --
    scope.resolveLocationIds.mockResolvedValueOnce(null);
    const requestB: RequestWithDbContext = {
      user: { sub: 'user-B', username: 'b', roleKey: 'owner', locationIds: [] },
    };
    await guard.canActivate(makeContext(requestB));

    // Request B must have issued its OWN fresh BEGIN + role switch +
    // set_config calls — it never reads or reuses anything from request A's
    // session, and critically is NOT still running as app_user from a role
    // switch that leaked past request A's ROLLBACK.
    const callsForRequestB = mockClient.query.mock.calls.slice(callsAfterRequestA);
    expect(callsForRequestB[0]).toEqual(['BEGIN']);
    expect(callsForRequestB[1]).toEqual(['SET LOCAL ROLE app_user']);
    expect(callsForRequestB).toContainEqual([expect.stringContaining('set_config'), ['user-B']]);
    expect(callsForRequestB).toContainEqual([expect.stringContaining('set_config'), ['owner']]);
    expect(callsForRequestB).toContainEqual([expect.stringContaining('set_config'), ['']]);
    // And crucially: request A's values never appear in request B's calls.
    expect(callsForRequestB.some((c) => c[1]?.[0] === 'user-A')).toBe(false);
    expect(callsForRequestB.some((c) => c[1]?.[0] === 'kasir')).toBe(false);

    expect(requestB.dbClient).toBe(mockClient);
    expect(requestB.locationScope).toBeNull();
  });
});
