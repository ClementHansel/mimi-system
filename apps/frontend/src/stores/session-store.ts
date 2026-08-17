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
if (typeof window !== 'undefined') {
  useSessionStore.persist.onFinishHydration(() => {
    useSessionStore.setState({ isHydrated: true });
  });
  if (useSessionStore.persist.hasHydrated()) {
    useSessionStore.setState({ isHydrated: true });
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
