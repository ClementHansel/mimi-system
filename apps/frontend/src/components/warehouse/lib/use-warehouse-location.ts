'use client';

import { useSessionStore } from '@/stores/session-store';

/**
 * The central warehouse location this session works against, plus the
 * outlets it ships to. Per the ticket brief: Kepala Gudang is NOT a central
 * role — `Me.locations` for a KGD account is server-side resolved to the one
 * `warehouse`-type location plus the specific `outlet`-type locations that
 * warehouse ships to (RLS-scoped), never the full location tree. This hook
 * never re-derives that scoping client-side; it just picks the `warehouse`
 * entry as the working location and exposes the rest as "outlets this
 * session can see" for drop-location pickers in the Surat Jalan builder.
 */
export function useWarehouseLocation(): {
  locationId: string | null;
  locationName: string | null;
  outlets: { id: string; name: string; city: string }[];
} {
  const user = useSessionStore((s) => s.user);
  const warehouse = user?.locations.find((l) => l.type === 'warehouse') ?? null;
  const outlets = (user?.locations ?? [])
    .filter((l) => l.type === 'outlet')
    .map((l) => ({ id: l.id, name: l.name, city: l.city }));
  return { locationId: warehouse?.id ?? null, locationName: warehouse?.name ?? null, outlets };
}
