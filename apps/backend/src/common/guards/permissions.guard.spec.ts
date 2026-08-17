import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';

// Mocking `can` isolates PermissionsGuard's OWN logic (metadata reading,
// 403 shaping) from the real RBAC matrix's content, which is `rbac.ts`'s
// concern, not this guard's — a real-matrix integration test belongs
// alongside `rbac.test.ts` instead. `ERR_FORBIDDEN` is passed through for
// real (it's a fixed string constant, not matrix logic) so the 403 shape
// assertions below check against the actual `ErrorCode` value.
vi.mock('@mimi/shared', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  can: vi.fn(),
}));

import { can, ERR_FORBIDDEN } from '@mimi/shared';
import { PermissionsGuard } from './permissions.guard';
import { REQUIRE_PERMISSION_KEY } from '../decorators/require-permission.decorator';

function makeContext(user: unknown, required?: string[]): ExecutionContext {
  const request = { user };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}), getNext: () => ({}) }),
    getHandler: () => ({ [REQUIRE_PERMISSION_KEY]: required }),
    getClass: () => ({}),
  } as unknown as ExecutionContext;
}

describe('PermissionsGuard', () => {
  let reflector: Reflector;
  let guard: PermissionsGuard;

  beforeEach(() => {
    vi.mocked(can).mockReset();
    reflector = new Reflector();
    guard = new PermissionsGuard(reflector);
  });

  it('allows the request through when the route declares no @RequirePermission()', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(undefined);
    const ctx = makeContext({ sub: 'u1', roleKey: 'kasir' });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(can).not.toHaveBeenCalled();
  });

  it('allows the request when the role holds one of the required permission keys', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['pos.sale.create']);
    vi.mocked(can).mockReturnValue(true);
    const ctx = makeContext({ sub: 'u1', roleKey: 'kasir' });
    expect(guard.canActivate(ctx)).toBe(true);
    expect(can).toHaveBeenCalledWith('kasir', 'pos.sale.create');
  });

  it('throws 403 ERR_FORBIDDEN when the role holds none of the required keys', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['supplier.price.manage']);
    vi.mocked(can).mockReturnValue(false);
    const ctx = makeContext({ sub: 'u1', roleKey: 'kasir' });
    expect(() => guard.canActivate(ctx)).toThrow();
    try {
      guard.canActivate(ctx);
    } catch (err: unknown) {
      const response = (err as { getResponse(): { code: string } }).getResponse();
      expect(response.code).toBe(ERR_FORBIDDEN);
    }
  });

  it('throws 403 when @RequirePermission() is set but request.user is missing', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['pos.sale.create']);
    const ctx = makeContext(undefined);
    expect(() => guard.canActivate(ctx)).toThrow();
  });

  it('passes when any ONE of multiple required keys is held (OR semantics)', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(['pos.void.approve', 'replenishment.approve.supervisor']);
    vi.mocked(can).mockImplementation(
      (roleKey: string, key: string) => roleKey === 'supervisor' && key === 'replenishment.approve.supervisor',
    );
    const ctx = makeContext({ sub: 'u1', roleKey: 'supervisor' });
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
