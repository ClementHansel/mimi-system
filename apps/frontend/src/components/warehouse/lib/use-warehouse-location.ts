'use client';

import { useEffect, useState } from 'react';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

interface SessionLocation {
  id: string;
  name: string;
  city: string;
  type: string;
}

/**
 * The warehouse this session works against, plus the outlets it ships to.
 *
 * Kepala Gudang is not a central role: `Me.locations` for a KGD account is
 * server-side resolved to the one `warehouse` location plus the specific
 * outlets that warehouse ships to. This hook never re-derives that scoping
 * client-side; it picks the `warehouse` entry as the working location.
 *
 * THE FALLBACK BELOW EXISTS BECAUSE CENTRAL ROLES HAVE NO LOCATIONS AT ALL.
 * `Me.locations` is `[]` for owner, superadmin, manager and finance — they are
 * scoped by RLS rather than by explicit location rows, which is correct and is
 * how `app_is_central()` works. But every warehouse panel keys off this hook,
 * so the effect was that the owner opening Stok Gudang, Penerimaan PO, Waste,
 * Retur or Stock Opname got "Akun ini belum terhubung ke lokasi gudang
 * manapun" — the entire warehouse section unusable for exactly the people who
 * oversee it, while their permissions said otherwise.
 *
 * So: when the session carries no warehouse of its own, ask the API for one.
 * `GET /locations` is itself RLS-scoped, so this grants nothing — a central
 * role sees the warehouse it was always allowed to see, and a branch role with
 * no warehouse gets an empty list back exactly as before. The distinction the
 * hook draws is "does this session need to be told which warehouse", not "may
 * this session see it".
 *
 * `loading` matters: without it every consumer renders its "no warehouse"
 * empty state for a frame before the fetch resolves, which is the same
 * misleading message this change exists to remove.
 */
export function useWarehouseLocation(): {
  locationId: string | null;
  locationName: string | null;
  outlets: { id: string; name: string; city: string }[];
  loading: boolean;
} {
  const user = useSessionStore((s) => s.user);
  const sessionWarehouse = user?.locations.find((l) => l.type === 'warehouse') ?? null;
  const [fetched, setFetched] = useState<SessionLocation | null>(null);
  // Start in the loading state only when we will actually go and look, so a
  // branch account that already has its warehouse never flickers.
  const needsLookup = !!user && !sessionWarehouse;
  const [loading, setLoading] = useState(needsLookup);

  useEffect(() => {
    if (!needsLookup) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      // `{ rows }` — verified against the running API, not assumed. My first
      // attempt guessed `{ data }`, got an empty list every time, and shipped a
      // fix that changed nothing: the panels still told the owner they had no
      // warehouse. `Array.isArray` and `data` are kept as fallbacks so this does
      // not break if the envelope is ever normalised.
      .get<SessionLocation[] | { rows?: SessionLocation[]; data?: SessionLocation[] }>(
        '/locations?active=true',
      )
      .then((res) => {
        if (cancelled) return;
        const rows = Array.isArray(res) ? res : (res.rows ?? res.data ?? []);
        setFetched(rows.find((l) => l.type === 'warehouse') ?? null);
      })
      .catch(() => {
        // Leave `fetched` null — consumers fall back to their existing "no
        // warehouse" state, which is the honest outcome when we cannot find out.
      })
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [needsLookup]);

  const warehouse = sessionWarehouse ?? fetched;
  const outlets = (user?.locations ?? [])
    .filter((l) => l.type === 'outlet')
    .map((l) => ({ id: l.id, name: l.name, city: l.city }));

  return {
    locationId: warehouse?.id ?? null,
    locationName: warehouse?.name ?? null,
    outlets,
    loading,
  };
}
