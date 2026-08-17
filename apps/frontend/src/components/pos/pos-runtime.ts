'use client';

/**
 * POS-local glue code: everything this surface needs to talk to W2-E's
 * `LocalRuntime` (`src/lib/local/api/local-runtime.ts`, the only file of
 * that package this surface may import from) plus the bits the runtime
 * deliberately does NOT own — the product catalog cache and actor metadata.
 * Cart/shift totals themselves always go through `@mimi/shared`'s cart
 * calculator, never hand-rolled here.
 */
import { api, ApiError } from '@/lib/api';
import { useSessionStore } from '@/stores/session-store';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { PosCatalog, PosProduct } from './types';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

/** Actor metadata every `commit*` call on `LocalRuntime` requires (SYNC-PROTOCOL §2.2 payload meta). */
export function useActorMeta(): ActorMeta | null {
  const user = useSessionStore((s) => s.user);
  if (!user) return null;
  return { actorUserId: user.id, actorRole: user.roleKey, appVersion: APP_VERSION };
}

/** The outlet this device/cashier is scoped to. A cashier device is assigned to exactly one outlet in practice; if `Me.locations` ever carries more than one (a supervisor testing the POS), the first is used and a selector can be added later. */
export function usePosLocation(): { id: string; name: string } | null {
  const user = useSessionStore((s) => s.user);
  const loc = user?.locations?.[0];
  return loc ? { id: loc.id, name: loc.name } : null;
}

function catalogCacheKey(locationId: string): string {
  return `pos.catalog.${locationId}`;
}

/**
 * Read-through catalog cache (FR-POS-01). `GET /api/pos/catalog` isn't part
 * of W2-E's offline sync surface (it's a precache read, not a fact), so this
 * surface owns caching it to localStorage itself: fetch-and-store when
 * online, fall back to the last-cached copy when the request fails (LAN-only
 * or isolated — SYNC-PROTOCOL §8 row 20 treats catalog like any other
 * "local derivation", never blocking a sale on connectivity).
 */
export async function loadCatalog(locationId: string): Promise<PosCatalog> {
  try {
    const res = await api.get<{ products: PosProduct[]; categories: string[]; version: string }>(
      `/api/pos/catalog?locationId=${encodeURIComponent(locationId)}`,
    );
    const catalog: PosCatalog = { ...res, fetchedAt: new Date().toISOString() };
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(catalogCacheKey(locationId), JSON.stringify(catalog));
    }
    return catalog;
  } catch (err) {
    const cached = readCachedCatalog(locationId);
    if (cached) return cached;
    throw err;
  }
}

export function readCachedCatalog(locationId: string): PosCatalog | null {
  if (typeof window === 'undefined') return null;
  const raw = window.localStorage.getItem(catalogCacheKey(locationId));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PosCatalog;
  } catch {
    return null;
  }
}

/** Client-generated idempotency key — minted once at draft time and reused on every retry (SYNC-PROTOCOL §2.2 rule 3). */
export function mintClientId(): string {
  return crypto.randomUUID();
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

/**
 * A cached offline-approval credential, trimmed to what a void/refund PIN
 * prompt needs to show a picker ("Budi — Supervisor Cabang").
 *
 * `LocalRuntime` exposes `cacheOfflineCredential` (write) but no read/listing
 * counterpart, and `commitVoidApprovedOffline` requires a `credentialId` the
 * caller must already know — there's no public way to discover one. This
 * reads `runtime.db` directly (a field `LocalRuntime` already exposes
 * publicly, the same handle `getStockBalance` is a thin wrapper over) rather
 * than reaching into `credentials/*` internals; still, this is a real gap —
 * flagged in the handoff report as a follow-up for a first-class
 * `LocalRuntime.listCachedCredentials()`.
 */
export interface CachedApproverOption {
  credentialId: string;
  role: string;
}

export async function listCachedApproverCredentials(runtime: {
  db: { store<T>(name: string): { getAll(): Promise<T[]> } };
}): Promise<CachedApproverOption[]> {
  type Row = { credentialId: string; claims: { role: string } };
  const rows = await runtime.db.store<Row>('credentials').getAll();
  return rows.map((r) => ({ credentialId: r.credentialId, role: r.claims.role }));
}
