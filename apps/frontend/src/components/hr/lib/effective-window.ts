/**
 * Effective-dated rate table helpers for the BPJS / PPh21 TER / PTKP /
 * Article-17 editors (CONTRACTS §4.15 Amendment 1). These tables never
 * overwrite a rate in place — inserting a new `effectiveFrom` window closes
 * the previous one (`ERR_EFFECTIVE_OVERLAP` if the server finds an overlap)
 * — so the ONE thing this UI must get right is showing which vintage is
 * "active now" versus which is a future or historical window, since picking
 * the wrong one silently mis-computes everyone's tax (ticket brief).
 *
 * Pure, backend-shape-agnostic: works over anything with
 * `{ effectiveFrom, effectiveTo }`, so it serves BPJS rows, TER brackets,
 * PTKP rows and Article-17 brackets alike without four near-identical copies.
 */
import type { EffectiveDatedRow } from './types';

export type WindowState = 'active' | 'future' | 'past';

/** `'YYYY-MM-DD'` for "today", in the app's fixed timezone — callers pass this explicitly (never a hidden `new Date()`) so the function stays deterministic and testable. */
export function isoToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Whether `asOf` falls inside `[effectiveFrom, effectiveTo]` (both inclusive; `effectiveTo: null` = open-ended). Mirrors `@mimi/shared`'s `selectEffective` exactly (payroll/statutory.ts) so the UI and the calculator never disagree about which window is "the" active one. */
export function isEffectiveAt(row: EffectiveDatedRow, asOf: string): boolean {
  return row.effectiveFrom <= asOf && (row.effectiveTo === null || asOf <= row.effectiveTo);
}

/** Classifies a row relative to `asOf` for display: badge/highlight state, not a business rule. */
export function windowState(row: EffectiveDatedRow, asOf: string): WindowState {
  if (row.effectiveFrom > asOf) return 'future';
  if (row.effectiveTo !== null && row.effectiveTo < asOf) return 'past';
  return 'active';
}

/** Sorts newest-first by `effectiveFrom` — the vintage a rate editor should default to showing/highlighting is always the most recent one, never array order from the API. */
export function sortByEffectiveFromDesc<T extends EffectiveDatedRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? 1 : a.effectiveFrom > b.effectiveFrom ? -1 : 0,
  );
}

/** Groups rows sharing the same `effectiveFrom` into one "vintage" — Article-17/TER submit a full bracket SET per effective date (CONTRACTS §4.15 PUT bodies), so the editor must let the user build/replace a whole set at once, not one row. */
export function groupByEffectiveFrom<T extends EffectiveDatedRow>(
  rows: readonly T[],
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const row of rows) {
    const list = map.get(row.effectiveFrom) ?? [];
    list.push(row);
    map.set(row.effectiveFrom, list);
  }
  return map;
}

/**
 * Validates a NEW `effectiveFrom` date against the existing rows before
 * submit: rejects a date that already has a vintage (ambiguous — which one
 * wins?) and rejects a date in the past relative to the most recent existing
 * vintage (silently backdating a rate change is exactly the mistake this
 * screen exists to prevent). Returns an i18n-ready error key, or `null` when
 * the date is safe to submit — the server is still the actual
 * `ERR_EFFECTIVE_OVERLAP` authority; this is a same-day UX guard only.
 */
export function validateNewEffectiveFrom(
  existing: readonly EffectiveDatedRow[],
  newEffectiveFrom: string,
): 'duplicate' | 'beforeLatest' | null {
  if (existing.some((r) => r.effectiveFrom === newEffectiveFrom)) return 'duplicate';
  const latest = sortByEffectiveFromDesc(existing)[0];
  if (latest && newEffectiveFrom < latest.effectiveFrom) return 'beforeLatest';
  return null;
}
