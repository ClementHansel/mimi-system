'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { useSessionStore } from '@/stores/session-store';

export interface OutletOption {
  id: string;
  name: string;
}

/**
 * Which outlet the Outlet surface works against.
 *
 * THE BUG THIS REPLACES (owner, 2026-08-27): this hook used to be one line —
 * `user.locations.find(l => l.type === 'outlet') ?? user.locations[0]` — and
 * every panel guards on `if (!locationId) return;`. A central role
 * (owner/superadmin/manager/finance) has `Me.locations: []` by design (D-05),
 * so `locationId` was `null`, the guard swallowed every fetch, and all six
 * panels sat on their loading skeleton FOREVER. Not a slow request: the request
 * was never made. The owner reported it as "not properly wired", and from the
 * screen that is exactly what it looks like.
 *
 * The old comment even conceded the gap — "No location switcher exists yet for
 * a multi-outlet outlet account — flagged in the report as a scope note, not
 * invented here." That scope note is now the requirement: an owner needs to
 * switch outlets to monitor them.
 *
 * SHAPE IS COPIED, DELIBERATELY, from `components/pos/pos-runtime.ts`'s
 * `usePosLocation` — the POS hit this identical problem (F02-FIX) and its
 * solution is proven in production: a terminal state machine rather than a
 * nullable id, so a role with no assignment gets a PICKER instead of an
 * infinite spinner, and every branch ends somewhere the UI can render.
 *
 * The two hooks are near-duplicates and should be unified into one shared
 * `useWorkingLocation`. They are not unified yet only because `pos-runtime.ts`
 * is being changed concurrently for channel pricing, and racing two agents on
 * one file to save a dozen lines is a bad trade. The duplication is small,
 * marked here, and the POS copy is the authority on behaviour.
 */
export type OutletLocationState =
  | { status: 'loading' }
  | { status: 'ready'; location: OutletOption; canChange: boolean; change: () => void }
  | { status: 'choose'; options: OutletOption[]; select: (id: string) => void }
  | { status: 'error'; retry: () => void };

/**
 * Deliberately a DIFFERENT storage key from the POS's `pos.selectedOutletId`.
 * A supervisor monitoring outlet B in the back office should not silently
 * re-point a till that is mid-shift on outlet A — the two surfaces answer
 * different questions and must not share one answer.
 */
const SELECTED_OUTLET_KEY = 'outlet.selectedOutletId';

function readStoredOutletId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(SELECTED_OUTLET_KEY);
  } catch {
    // Private mode / blocked site data — fall through to the picker rather than throw.
    return null;
  }
}

function storeOutletId(id: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SELECTED_OUTLET_KEY, id);
  } catch {
    // Persistence is a convenience; losing it must not break the surface.
  }
}

function clearStoredOutletId(): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(SELECTED_OUTLET_KEY);
  } catch {
    /* see storeOutletId */
  }
}

/** The outlet this session works against — see `OutletLocationState`. */
export function useOutletLocation(): OutletLocationState {
  const user = useSessionStore((s) => s.user);
  // Only outlet-type assignments are candidates here: a warehouse assignment
  // must not become the "outlet" whose stock and petty cash these panels edit.
  const assigned = (user?.locations ?? []).filter((l) => l.type === 'outlet');
  const needsFetch = assigned.length === 0;

  const [selectedId, setSelectedId] = useState<string | null>(() => readStoredOutletId());
  const [fetchedOutlets, setFetchedOutlets] = useState<OutletOption[] | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!needsFetch) return;
    let cancelled = false;
    setFetchError(false);
    // The SERVER is the RBAC authority on which outlets are offered — this is
    // `location.read`-filtered, so the hook never pre-guesses a caller's scope.
    api
      .get<{ rows: (OutletOption & { type?: string })[] }>(
        '/locations?type=outlet&active=true&pageSize=200',
      )
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

  // Exactly one assignment: unchanged pre-fix behaviour for the roles this
  // surface was built for (Leader/Staff Outlet), and no picker to get wrong.
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
  if (!options) return { status: 'loading' };

  // A stored id that is no longer offered (outlet retired, scope changed) must
  // fall through to the picker, never resolve to a stale outlet.
  const selected = selectedId ? (options.find((o) => o.id === selectedId) ?? null) : null;
  if (selected) return { status: 'ready', location: selected, canChange: true, change };

  return { status: 'choose', options, select };
}
