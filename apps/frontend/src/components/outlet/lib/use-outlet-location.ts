'use client';

import { useSessionStore } from '@/stores/session-store';

/**
 * The outlet location this session works against. Leader/Staff Outlet and
 * Supervisor Cabang accounts are provisioned against exactly one `outlet`-type
 * location in practice (D-05); `Me.locations` is still an array on the wire,
 * so this picks the first outlet-type entry rather than assuming index 0 is
 * correct for every role. No location switcher exists yet for a multi-outlet
 * outlet account — flagged in the report as a scope note, not invented here.
 */
export function useOutletLocation(): { locationId: string | null; locationName: string | null } {
  const user = useSessionStore((s) => s.user);
  const loc = user?.locations.find((l) => l.type === 'outlet') ?? user?.locations[0] ?? null;
  return { locationId: loc?.id ?? null, locationName: loc?.name ?? null };
}
