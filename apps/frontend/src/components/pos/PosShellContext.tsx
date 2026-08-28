'use client';

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useActorMeta, usePosLocation, loadCatalog, type PosLocationState } from './pos-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';
import type { PosCatalog } from './types';

/**
 * F-POS-2 — shares the two things both `app/pos/layout.tsx` (the top bar +
 * branch line) and `app/pos/page.tsx` (the actual gating/catalog/cart flow)
 * need to agree on: who's operating this till, and which outlet it's
 * ringing into. Both used to call `useActorMeta()`/`usePosLocation()`
 * directly from the page; lifting them here means the layout's header can
 * show the same live branch name/reason without a second `/locations` fetch
 * racing the page's own (a head-office user's outlet list would otherwise
 * be fetched twice, independently, on every load).
 *
 * F-POS-3 — the catalog moved in here too (it used to be `app/pos/page.tsx`
 * local state). The channel toggle now lives in `PosTopBar` (the tab row),
 * and switching channel with a non-empty cart re-prices every line from the
 * catalog (`ChannelToggle.tsx`) — that needs the same catalog the page
 * renders the grid from, so both read one fetch instead of the toggle
 * re-fetching its own copy that could drift from what the grid shows.
 *
 * Deliberately a plain React context, not a zustand store — this is
 * request-scoped UI wiring (one provider per POS mount), not persisted
 * cross-component state.
 */
interface PosShellCtx {
  actor: ActorMeta | null;
  posLocation: PosLocationState;
  catalog: PosCatalog | null;
  catalogError: boolean;
}

const Ctx = createContext<PosShellCtx | null>(null);

export function PosShellProvider({ children }: { children: ReactNode }) {
  const actor = useActorMeta();
  const posLocation = usePosLocation();
  const [catalog, setCatalog] = useState<PosCatalog | null>(null);
  const [catalogError, setCatalogError] = useState(false);

  const location = posLocation.status === 'ready' ? posLocation.location : null;

  useEffect(() => {
    if (!location) return;
    setCatalogError(false);
    loadCatalog(location.id)
      .then(setCatalog)
      .catch(() => setCatalogError(true));
  }, [location]);

  return (
    <Ctx.Provider value={{ actor, posLocation, catalog, catalogError }}>{children}</Ctx.Provider>
  );
}

export function usePosShell(): PosShellCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePosShell must be used inside <PosShellProvider>');
  return ctx;
}
