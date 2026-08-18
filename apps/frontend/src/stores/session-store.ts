import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { Me } from '@/lib/shared-types';

/**
 * Session store — holds CONTRACTS.md §4.1's `Me` exactly (imported from
 * `@mimi/shared`, not redefined here).
 *
 * `permissions` is the flat string array the backend already computed for
 * this user (`/api/auth/me` → `Me.permissions`); gating (`usePermissions`,
 * `PermissionGate`, nav filtering) checks membership in THIS array, never a
 * locally re-derived RBAC matrix — the matrix lives once, server-side
 * (SYNC-PROTOCOL §3.2: `role_permissions` is class M, pull-only, and is a
 * cache for offline display, not the enforcement path).
 *
 * Persisted to localStorage so a refresh doesn't bounce the user to /login —
 * `isHydrated` guards the one render where persisted state hasn't loaded yet,
 * so route protection doesn't flash a redirect before we know the answer.
 */

/** Re-exported under this name for readability at call sites (`SessionUser` = `Me`). */
export type SessionUser = Me;

interface SessionState {
  accessToken: string | null;
  refreshToken: string | null;
  user: SessionUser | null;
  isHydrated: boolean;
  setSession: (s: { accessToken: string; refreshToken: string; user: SessionUser }) => void;
  setTokens: (t: { accessToken: string; refreshToken: string }) => void;
  updateUser: (partial: Partial<SessionUser>) => void;
  clearSession: () => void;
}

/** Bump when `Me` (CONTRACTS §4.1) gains, loses, or renames a field. */
const SESSION_PERSIST_VERSION = 1;

/** The signed-out shape — the one state every discard path resolves to. */
const EMPTY_SESSION = { accessToken: null, refreshToken: null, user: null } as const;

/**
 * A persisted session is usable only if the token AND a structurally complete
 * `user` both survived. The array checks are not paranoia: `app/page.tsx`
 * reads `user.locations.length` and `usePermissions` reads `user.permissions`,
 * so a `Me` missing either throws during render and Next replaces the page
 * with its client-side-exception screen.
 */
function isUsableSession(s: Pick<SessionState, 'accessToken' | 'user'>): boolean {
  return (
    typeof s.accessToken === 'string' &&
    s.accessToken.length > 0 &&
    !!s.user &&
    typeof s.user.id === 'string' &&
    typeof s.user.name === 'string' &&
    typeof s.user.roleKey === 'string' &&
    Array.isArray(s.user.permissions) &&
    Array.isArray(s.user.locations)
  );
}

export const useSessionStore = create<SessionState>()(
  persist(
    (set) => ({
      accessToken: null,
      refreshToken: null,
      user: null,
      isHydrated: false,
      setSession: ({ accessToken, refreshToken, user }) => set({ accessToken, refreshToken, user }),
      setTokens: ({ accessToken, refreshToken }) => set({ accessToken, refreshToken }),
      updateUser: (partial) =>
        set((state) => ({ user: state.user ? { ...state.user, ...partial } : state.user })),
      clearSession: () => set({ accessToken: null, refreshToken: null, user: null }),
    }),
    {
      name: 'mimi-session',
      // Bump whenever `Me`'s shape changes. A stored blob written by an older
      // build arrives here as version 0, `migrate` throws it away, and the
      // visitor simply logs in again — which is the only safe answer, because
      // a HALF-VALID session is worse than none: `AppShell` used to gate on
      // `accessToken` alone while `app/page.tsx` gates on `user`, so a blob
      // carrying a token but no usable user passed the first gate, failed the
      // second, and rendered a permanently blank white page with no error and
      // no redirect (the redirect effect only fires when the token is falsy).
      version: SESSION_PERSIST_VERSION,
      migrate: () => EMPTY_SESSION,
      partialize: (state) => ({
        accessToken: state.accessToken,
        refreshToken: state.refreshToken,
        user: state.user,
      }),
    },
  ),
);

// Flip `isHydrated` once persisted state has loaded, so route protection
// never redirects on the one render before we know whether a session exists.
//
// `migrate` above only runs when the stored VERSION differs, so it cannot
// catch a same-version blob that is nonetheless unusable (hand-edited
// localStorage, a write interrupted mid-flight, a `Me` field that went
// missing without a version bump). Validating on every hydration closes that
// gap: anything that isn't a complete session is discarded here, so by the
// time `isHydrated` flips, `accessToken && user` is the only truthy shape the
// rest of the app can observe.
if (typeof window !== 'undefined') {
  const finishHydration = (state?: SessionState) => {
    if (state && !isUsableSession(state)) {
      useSessionStore.setState({ ...EMPTY_SESSION, isHydrated: true });
      return;
    }
    useSessionStore.setState({ isHydrated: true });
  };

  useSessionStore.persist.onFinishHydration(finishHydration);
  if (useSessionStore.persist.hasHydrated()) {
    finishHydration(useSessionStore.getState());
  }
}

/** Read the access token outside a React render (used by lib/api.ts). */
export function getAccessToken(): string | null {
  return useSessionStore.getState().accessToken;
}

/** Read the refresh token outside a React render (used by lib/api.ts). */
export function getRefreshToken(): string | null {
  return useSessionStore.getState().refreshToken;
}
