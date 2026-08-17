'use client';

import { api, ApiError } from './api';
import { ERR_AUTH_INVALID_CREDENTIALS, type LoginRes } from '@/lib/shared-types';
import { useSessionStore, type SessionUser } from '@/stores/session-store';

/**
 * Auth actions (CONTRACTS.md §4.1 M01). Thin wrappers over the session store
 * + API client — the actual login form lives at `app/(auth)/login/page.tsx`.
 */

export async function login(username: string, password: string): Promise<SessionUser> {
  const res = await api.post<LoginRes>('/auth/login', { username, password });
  useSessionStore.getState().setSession(res);
  return res.user;
}

export async function logout(): Promise<void> {
  const refreshToken = useSessionStore.getState().refreshToken;
  try {
    if (refreshToken) await api.post('/auth/logout', { refreshToken });
  } catch {
    // Best-effort — the session is cleared locally regardless (M01, NFR-03).
  } finally {
    useSessionStore.getState().clearSession();
    if (typeof window !== 'undefined') window.location.href = '/login';
  }
}

export function isAuthenticated(): boolean {
  return useSessionStore.getState().accessToken !== null;
}

/** True when the API rejected a login attempt with a credentials error (as opposed to a network/server fault). */
export function isInvalidCredentials(err: unknown): boolean {
  return err instanceof ApiError && (err.statusCode === 401 || err.code === ERR_AUTH_INVALID_CREDENTIALS);
}
