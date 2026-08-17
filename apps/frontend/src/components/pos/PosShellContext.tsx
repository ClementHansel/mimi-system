'use client';

import { createContext, useContext, type ReactNode } from 'react';
import { useActorMeta, usePosLocation, type PosLocationState } from './pos-runtime';
import type { ActorMeta } from '@/lib/local/api/local-runtime';

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
 * Deliberately a plain React context, not a zustand store — this is
 * request-scoped UI wiring (one provider per POS mount), not persisted
 * cross-component state.
 */
interface PosShellCtx {
  actor: ActorMeta | null;
  posLocation: PosLocationState;
}

const Ctx = createContext<PosShellCtx | null>(null);

export function PosShellProvider({ children }: { children: ReactNode }) {
  const actor = useActorMeta();
  const posLocation = usePosLocation();
  return <Ctx.Provider value={{ actor, posLocation }}>{children}</Ctx.Provider>;
}

export function usePosShell(): PosShellCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('usePosShell must be used inside <PosShellProvider>');
  return ctx;
}
