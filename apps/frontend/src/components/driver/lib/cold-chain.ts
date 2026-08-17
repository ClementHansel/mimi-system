/**
 * Cold-chain pure helpers for F13 `driver` (D-14, OBJ-03). No I/O, no React —
 * plain predicates so the breach rule and per-drop gating are unit-testable
 * without a rendered form.
 *
 * The frozen range (-25.0..-15.0°C) is the same reference `TempInput`'s own
 * doc comment cites ("frozen chicken runs -25.0..-15.0, D-14") — kept as one
 * named constant here rather than re-typed at each call site.
 */
import type { Temp, UUID } from '@/lib/shared-types';
import type { Drop, Seal, SuratJalan } from './types';

export const FROZEN_TEMP_RANGE = { min: -25, max: -15 } as const;

/**
 * Breach check for a `frozen` shipment's cold-chain reading. Display-only
 * threshold comparison (never a wire computation, never re-serialized) —
 * the one place CONTRACTS §0's "never `parseFloat` for anything
 * money/qty/temp-shaped" rule doesn't apply, same carve-out `formatters.ts`
 * documents for its own display helpers. A reading outside the range is
 * flagged, never rejected — "record it honestly" (this ticket's brief);
 * the UI must not discourage entering a bad number.
 */
export function isFrozenBreach(tempC: Temp | null, shipmentType: 'frozen' | 'dry'): boolean {
  if (shipmentType !== 'frozen' || tempC === null || tempC === '') return false;
  const n = Number(tempC);
  if (Number.isNaN(n)) return false;
  return n < FROZEN_TEMP_RANGE.min || n > FROZEN_TEMP_RANGE.max;
}

/** The seal that applies to one drop: a drop-specific seal if the SJ tracked one, otherwise the SJ-wide seal (single freezer box covering the whole route). */
export function sealForDrop(sj: SuratJalan, dropId: UUID): Seal | null {
  return sj.seals.find((s) => s.dropId === dropId) ?? sj.seals.find((s) => s.dropId === null) ?? null;
}

/** Temp logs for one drop stage, most recent first — read-only history shown alongside the action forms. */
export function tempLogsForDrop(sj: SuratJalan, dropId: UUID): SuratJalan['tempLogs'] {
  return sj.tempLogs
    .filter((l) => l.dropId === dropId)
    .slice()
    .sort((a, b) => b.loggedAt.localeCompare(a.loggedAt));
}

export type DropAction = 'depart' | 'arrive' | 'receive' | 'fail' | 'none';

/**
 * The per-drop gating rule (D-14's multi-drop sequence): exactly one action
 * is ever available for a given drop at a time, driven entirely by its own
 * status/timestamps — never by dropSeq order (a driver may need to skip
 * ahead if an earlier drop's outlet is unreachable, D-14's "fail" path), so
 * this never blocks drop N+1 on drop N's completion.
 */
export function nextActionForDrop(drop: Drop): DropAction {
  if (drop.status === 'completed' || drop.status === 'completed_discrepancy' || drop.status === 'failed') return 'none';
  if (!drop.departedAt) return 'depart';
  if (!drop.arrivedAt) return 'arrive';
  return 'receive';
}
