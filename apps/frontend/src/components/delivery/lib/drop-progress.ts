/**
 * The drop status ladder (D-14) for the DISPATCHER's read-only tracking view
 * — "where is each drop right now, and how far along is it". This is a
 * different concern from `components/driver/lib/cold-chain.ts`'s
 * `nextActionForDrop` (which gates which ACTION button a driver may press
 * next); a dispatcher never executes depart/arrive/receive themselves
 * (`delivery.drop.execute`/`delivery.receive` are driver/outlet-held
 * permissions per the RBAC matrix, CONTRACTS §3), so no action-gating helper
 * is needed here — only a stable progress rank for a progress bar / timeline
 * UI, plus the "is this drop done" predicate the list/detail views need for
 * a truck-level rollup (e.g. "3 of 5 drops complete").
 *
 * `pending`/`en_route`/`arrived` sit on the live route in strict order;
 * `completed`/`completed_discrepancy`/`failed` are the three terminal
 * outcomes (D-14) and all rank equally "done" — a discrepancy or a failure
 * is still the end of that drop's journey, not a step backward.
 */
import type { UUID } from '@/lib/shared-types';

export type DropStatusKey = 'pending' | 'en_route' | 'arrived' | 'completed' | 'completed_discrepancy' | 'failed';

const LADDER: readonly DropStatusKey[] = ['pending', 'en_route', 'arrived'];
const TERMINAL: ReadonlySet<DropStatusKey> = new Set(['completed', 'completed_discrepancy', 'failed']);

export function isDropTerminal(status: DropStatusKey): boolean {
  return TERMINAL.has(status);
}

/**
 * 0-based rank on the live ladder for `pending`/`en_route`/`arrived`; every
 * terminal status ranks one past the end (`LADDER.length`) — "further along
 * than 'arrived'" holds regardless of which terminal outcome it was, so a
 * progress bar never regresses when a drop fails instead of completing.
 */
export function dropProgressRank(status: DropStatusKey): number {
  const idx = LADDER.indexOf(status);
  return idx === -1 ? LADDER.length : idx;
}

export function dropProgressTotal(): number {
  return LADDER.length + 1;
}

interface DropForRollup {
  id: UUID;
  status: DropStatusKey;
}

/** "N of M drops done" for a Surat Jalan's drop list — the truck-level rollup the list/detail screens show alongside each route. */
export function routeCompletion(drops: readonly DropForRollup[]): { done: number; total: number } {
  return { done: drops.filter((d) => isDropTerminal(d.status)).length, total: drops.length };
}
