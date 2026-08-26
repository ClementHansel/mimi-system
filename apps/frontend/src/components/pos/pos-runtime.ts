'use client';

/**
 * POS-local glue code: everything this surface needs to talk to W2-E's
 * `LocalRuntime` (`src/lib/local/api/local-runtime.ts`, the only file of
 * that package this surface may import from) plus the bits the runtime
 * deliberately does NOT own — the product catalog cache and actor metadata.
 * Cart/shift totals themselves always go through `@mimi/shared`'s cart
 * calculator, never hand-rolled here.
 */
import { useEffect, useState } from 'react';
import { api, ApiError } from '@/lib/api';
import { useSessionStore } from '@/stores/session-store';
import { newUuid } from '@/lib/uuid';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { PosCatalog, PosProduct } from './types';
import { dropStaleProductPhotoCaches, prefetchProductPhotos } from './product-photo-cache';

const APP_VERSION = process.env.NEXT_PUBLIC_APP_VERSION ?? 'dev';

/** Actor metadata every `commit*` call on `LocalRuntime` requires (SYNC-PROTOCOL §2.2 payload meta). */
export function useActorMeta(): ActorMeta | null {
  const user = useSessionStore((s) => s.user);
  if (!user) return null;
  return { actorUserId: user.id, actorRole: user.roleKey, appVersion: APP_VERSION };
}

export interface PosOutletOption {
  id: string;
  name: string;
}

/**
 * Result of resolving which outlet this POS session should transact
 * against (F02-FIX). A cashier device is assigned to exactly one outlet
 * ('ready', `canChange: false` — identical to the pre-fix behaviour); a
 * head-office role (Owner/Manager/Finance, D-05) has `Me.locations: []` and
 * must pick one before anything else can load ('choose', options come from
 * `GET /api/locations` — the server, via `location.read`, is the RBAC
 * authority on which outlets are offered); a supervisor account holding
 * several assigned locations gets the same picker built from
 * `Me.locations` directly, no fetch needed. 'loading'/'error' give the
 * zero-location fetch a terminal state instead of spinning forever.
 */
export type PosLocationState =
  | { status: 'loading' }
  | { status: 'ready'; location: PosOutletOption; canChange: boolean; change: () => void }
  | { status: 'choose'; options: PosOutletOption[]; select: (id: string) => void }
  | { status: 'error'; retry: () => void };

const SELECTED_OUTLET_KEY = 'pos.selectedOutletId';

function readStoredOutletId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.localStorage.getItem(SELECTED_OUTLET_KEY);
}

function storeOutletId(id: string): void {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(SELECTED_OUTLET_KEY, id);
}

function clearStoredOutletId(): void {
  if (typeof window === 'undefined') return;
  window.localStorage.removeItem(SELECTED_OUTLET_KEY);
}

/** The outlet this session works against — see `PosLocationState`. */
export function usePosLocation(): PosLocationState {
  const user = useSessionStore((s) => s.user);
  const assigned = user?.locations ?? [];
  const needsFetch = assigned.length === 0;

  const [selectedId, setSelectedId] = useState<string | null>(() => readStoredOutletId());
  const [fetchedOutlets, setFetchedOutlets] = useState<PosOutletOption[] | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    setFetchError(false);
    api
      .get<{ rows: PosOutletOption[] }>('/locations?type=outlet&active=true&pageSize=200')
      .then((res) => {
        if (!cancelled) setFetchedOutlets(res.rows.map((l) => ({ id: l.id, name: l.name })));
      })
      .catch(() => {
        if (!cancelled) setFetchError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [needsFetch, attempt]);

  function select(id: string): void {
    storeOutletId(id);
    setSelectedId(id);
  }

  function change(): void {
    clearStoredOutletId();
    setSelectedId(null);
  }

  const single = assigned.length === 1 ? assigned[0] : undefined;
  if (single) {
    return {
      status: 'ready',
      location: { id: single.id, name: single.name },
      canChange: false,
      change: () => {},
    };
  }

  if (needsFetch && fetchError) {
    return { status: 'error', retry: () => setAttempt((a) => a + 1) };
  }

  const options =
    assigned.length > 1 ? assigned.map((l) => ({ id: l.id, name: l.name })) : fetchedOutlets;
  if (!options) {
    return { status: 'loading' };
  }

  const selected = selectedId ? (options.find((o) => o.id === selectedId) ?? null) : null;
  if (selected) {
    return { status: 'ready', location: selected, canChange: true, change };
  }

  return { status: 'choose', options, select };
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
      // NO `/api` PREFIX. `apiFetch` prepends `API_BASE` (`NEXT_PUBLIC_API_URL`,
      // `/api` by default), so passing `/api/pos/catalog` here requested
      // `/api/api/pos/catalog` and got a 404 every time — the till fell back to
      // its last cached catalog and, on a device that had never had one, showed
      // "Katalog produk belum tersedia" with no way forward. Every other call in
      // this codebase passes the bare path; this one did not.
      `/pos/catalog?locationId=${encodeURIComponent(locationId)}`,
    );
    const catalog: PosCatalog = { ...res, fetchedAt: new Date().toISOString() };
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(catalogCacheKey(locationId), JSON.stringify(catalog));
    }
    // Warm the photo cache WHILE STILL ONLINE and off the critical path — this
    // is what makes menu photos survive an outage, since lazy per-tile loading
    // would only ever have cached whatever the cashier happened to look at
    // before the link dropped. Deliberately not awaited: the catalog is what the
    // caller is waiting for, and a slow image fetch must never delay opening a
    // shift. Photos are cosmetic; a failure here is silent by design.
    void dropStaleProductPhotoCaches()
      .then(() => prefetchProductPhotos(res.products.map((p) => p.photoPath)))
      .catch(() => {});
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
  return newUuid();
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
