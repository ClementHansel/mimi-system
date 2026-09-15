import { describe, it, expect, beforeEach } from 'vitest';
import { useSessionStore, type SessionUser } from './session-store';

/**
 * MA-190 — a newly added employee logged in, set their PIN, landed on `/` and
 * got Next's "Application error: a client-side exception has occurred" screen.
 *
 * The cause was an asymmetry between the two ways a session enters the store:
 * HYDRATION from localStorage was guarded (`isUsableSession` discards a blob
 * with a non-array `permissions`/`locations`), but `setSession` stored whatever
 * `/auth/login` returned verbatim. `app/page.tsx` reads `user.locations` and
 * `usePermissions` reads `user.permissions`, so a `Me` missing either threw
 * during render — unreachable by reloading into a bad session, reachable by
 * logging in to one, which is exactly the reported sequence.
 *
 * The behaviour is real in `normalizeUser` but nothing held it: there was no
 * test for this store at all, so the fix was one careless edit from coming
 * back, and it comes back as a WHITE SCREEN on the first login of every new
 * hire rather than as a failing assertion.
 */
const COMPLETE: SessionUser = {
  id: 'u-1',
  username: 'newhire',
  name: 'Budi Santoso',
  roleKey: 'kasir',
  permissions: ['pos.sale.create'],
  locations: [{ id: 'loc-1', name: 'Outlet Kemang' }],
  employeeId: null,
  mustSetPin: true,
} as unknown as SessionUser;

function login(user: unknown) {
  useSessionStore.getState().setSession({
    accessToken: 'a-token',
    refreshToken: 'r-token',
    user: user as SessionUser,
  });
  return useSessionStore.getState().user!;
}

describe('session-store — MA-190: a login response is normalized, not trusted verbatim', () => {
  beforeEach(() => {
    useSessionStore.getState().clearSession();
  });

  it('keeps a structurally complete Me exactly as the server sent it', () => {
    const stored = login(COMPLETE);
    expect(stored.permissions).toEqual(['pos.sale.create']);
    expect(stored.locations).toHaveLength(1);
    expect(stored.name).toBe('Budi Santoso');
  });

  it('coerces a MISSING permissions/locations to [] instead of storing a Me that crashes the hub', () => {
    const withoutArrays: Record<string, unknown> = { ...COMPLETE };
    delete withoutArrays.permissions;
    delete withoutArrays.locations;
    const stored = login(withoutArrays);
    expect(Array.isArray(stored.permissions)).toBe(true);
    expect(Array.isArray(stored.locations)).toBe(true);
    expect(stored.permissions).toEqual([]);
    expect(stored.locations).toEqual([]);
    // Coerced, never rejected — refusing the login would turn a cosmetic gap
    // into a lockout, and the server still enforces both server-side.
    expect(stored.id).toBe('u-1');
    expect(useSessionStore.getState().accessToken).toBe('a-token');
  });

  it('coerces a NULL permissions/locations too — the shape JSON actually produces', () => {
    const stored = login({ ...COMPLETE, permissions: null, locations: null });
    expect(stored.permissions).toEqual([]);
    expect(stored.locations).toEqual([]);
  });

  it('keeps the arrays intact across updateUser, which is what /set-pin calls before navigating', () => {
    login(COMPLETE);
    useSessionStore.getState().updateUser({ mustSetPin: false });
    const after = useSessionStore.getState().user!;
    // The set-pin page merges one field and then routes to the hub. Losing
    // `name`, `permissions` or `locations` here lands on the same white screen.
    expect(after.mustSetPin).toBe(false);
    expect(after.name).toBe('Budi Santoso');
    expect(after.permissions).toEqual(['pos.sale.create']);
    expect(after.locations).toHaveLength(1);
  });
});
