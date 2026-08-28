'use client';

import { createContext, useContext, type ReactNode } from 'react';
import type { OutletOption } from './use-outlet-location';

/**
 * The RESOLVED outlet, for the six panels beneath the Outlet surface.
 *
 * WHY A CONTEXT AND NOT THE HOOK DIRECTLY: `useOutletLocation()` returns a
 * state machine (loading / choose / error / ready) because a central role has
 * no assigned outlet and must pick one. Every panel handling those four states
 * itself would be six copies of the same branching, and the previous design —
 * a nullable `locationId` that each panel guarded with `if (!locationId)
 * return;` — is exactly how all six ended up silently never fetching for an
 * owner. The guard looked defensive and was actually the bug.
 *
 * So the SHELL resolves once, renders the picker / spinner / retry itself, and
 * mounts the panels only when an outlet is settled. Below this provider
 * `locationId` is a plain `string`, so "no outlet" is not a state a panel can
 * accidentally render as empty data.
 */
const OutletLocationContext = createContext<OutletOption | null>(null);

export function OutletLocationProvider({
  location,
  children,
}: {
  location: OutletOption;
  children: ReactNode;
}) {
  return (
    <OutletLocationContext.Provider value={location}>{children}</OutletLocationContext.Provider>
  );
}

/**
 * The settled outlet. Throws rather than returning null: reaching this without
 * a provider is a wiring mistake in a parent, and a loud failure in dev beats
 * six panels quietly rendering "no data" in production — the failure mode this
 * whole change exists to remove.
 */
export function useOutletLocationContext(): { locationId: string; locationName: string } {
  const loc = useContext(OutletLocationContext);
  if (!loc) {
    throw new Error(
      'useOutletLocationContext() used outside <OutletLocationProvider>. The Outlet shell must ' +
        'resolve the outlet (useOutletLocation) and mount panels only once it is settled.',
    );
  }
  return { locationId: loc.id, locationName: loc.name };
}
