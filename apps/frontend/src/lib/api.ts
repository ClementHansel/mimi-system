'use client';

import { getAccessToken, getRefreshToken, useSessionStore } from '@/stores/session-store';
import { ERR_AUTH_TOKEN_EXPIRED, type ApiErrorShape, type Paginated } from '@/lib/shared-types';

export type { Paginated };

/**
 * Typed API client — fetch wrapper for the cloud REST surface (CONTRACTS.md
 * §0/§4). Attaches the bearer token, retries once through `/auth/refresh` on
 * 401, and parses the exception filter's error shape into a typed `ApiError`
 * so callers can branch on the stable `code` (e.g. `ERR_STOCK_INSUFFICIENT`)
 * instead of matching on `message` text — `message` is not for display;
 * Wave 4/5 screens resolve user-facing copy from i18n keyed by `code`.
 *
 * Money/Qty/Temp boundary (CONTRACTS §0): these fields are decimal STRINGS
 * end to end. `apiFetch` never touches `JSON.parse`d values beyond the
 * generic pass-through — it does not coerce numbers to strings or vice versa.
 * The safety comes from the TS request/response interfaces Wave 3/4 modules
 * write against (`Money = string`, from `@/lib/shared-types`): never type a
 * money/qty/temp field as `number`, and this boundary stays exact by
 * construction. Use `parseMoneyInput`/`parseQtyInput`/`parseTempInput`
 * (`@/lib/formatters`) to turn user keystrokes into that string, never
 * `Number()`/`parseFloat`.
 *
 * Offline-first surfaces (F02/F04/F11/F13) do NOT call this client to
 * mutate — they enqueue sync events via W2-E's local runtime
 * (`src/lib/local/**`, SYNC-PROTOCOL §2.2). This client is the online path:
 * laptop/back-office surfaces, and the read path for everyone when online.
 */

const API_BASE = process.env.NEXT_PUBLIC_API_URL || '/api';

export const API_BASE_URL = API_BASE;

/** The exception filter's error shape (CONTRACTS §0 `ApiErrorShape`), thrown for any non-2xx response. */
export class ApiError extends Error {
  /** HTTP status code. */
  statusCode: number;
  /** Stable machine key, e.g. `ERR_STOCK_INSUFFICIENT`, `ERR_APPROVAL_STEP_ROLE`. Branch on this, not `message`. */
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function buildUrl(path: string): string {
  const base = API_BASE.endsWith('/') ? API_BASE.slice(0, -1) : API_BASE;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${base}${p}`;
}

async function tryRefresh(): Promise<boolean> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return false;
  try {
    const res = await fetch(buildUrl('/auth/refresh'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) return false;
    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    useSessionStore
      .getState()
      .setTokens({ accessToken: data.accessToken, refreshToken: data.refreshToken });
    return true;
  } catch {
    return false;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {},
  retry = true,
): Promise<T> {
  const token = getAccessToken();
  const isFormData = typeof FormData !== 'undefined' && options.body instanceof FormData;
  const headers: Record<string, string> = {
    ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(buildUrl(path), { ...options, headers });

  if (res.status === 401 && retry) {
    const refreshed = await tryRefresh();
    if (refreshed) return apiFetch<T>(path, options, false);
    useSessionStore.getState().clearSession();
    if (typeof window !== 'undefined') window.location.href = '/login';
    throw new ApiError(401, ERR_AUTH_TOKEN_EXPIRED, 'Session expired');
  }

  if (res.status === 204) return undefined as T;

  const body: Partial<ApiErrorShape> | null = await res.json().catch(() => null);

  if (!res.ok) {
    const statusCode = typeof body?.statusCode === 'number' ? body.statusCode : res.status;
    const code = typeof body?.code === 'string' ? body.code : 'ERR_UNKNOWN';
    const message =
      typeof body?.message === 'string' ? body.message : `Request failed (${res.status})`;
    throw new ApiError(statusCode, code, message, body?.details);
  }

  return body as T;
}

export const api = {
  get: <T = unknown>(path: string) => apiFetch<T>(path, { method: 'GET' }),
  post: <T = unknown>(path: string, data?: unknown) =>
    apiFetch<T>(path, {
      method: 'POST',
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  put: <T = unknown>(path: string, data?: unknown) =>
    apiFetch<T>(path, {
      method: 'PUT',
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  patch: <T = unknown>(path: string, data?: unknown) =>
    apiFetch<T>(path, {
      method: 'PATCH',
      body: data !== undefined ? JSON.stringify(data) : undefined,
    }),
  delete: <T = unknown>(path: string) => apiFetch<T>(path, { method: 'DELETE' }),
  /** Multipart upload (attachment presign confirm, CSV import, …). */
  upload: <T = unknown>(path: string, formData: FormData, method: 'PUT' | 'POST' = 'POST') =>
    apiFetch<T>(path, { method, body: formData }),
};
