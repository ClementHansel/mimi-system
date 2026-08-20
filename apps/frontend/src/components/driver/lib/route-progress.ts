import type { Drop, DropStatus } from './types';

/**
 * "Where am I up to on this run" — derived in one place so the header count,
 * the map's highlighted pin and the expanded stop card can never disagree
 * about which stop is next.
 *
 * A drop is FINISHED when it can no longer be acted on. `failed` counts as
 * finished for sequencing (the driver moves on) but is reported separately,
 * because a run with three failures is not the same day as a clean one and
 * the end-of-day summary must not round that away.
 */

const TERMINAL: ReadonlySet<DropStatus> = new Set<DropStatus>([
  'completed',
  'completed_discrepancy',
  'failed',
]);

export function isFinished(drop: Drop): boolean {
  return TERMINAL.has(drop.status);
}

export interface RouteProgress {
  total: number;
  /** Delivered, including deliveries that had a discrepancy — the goods still arrived. */
  done: number;
  /** Arrived but recorded short/damaged. A subset of `done`, surfaced for the summary. */
  withDiscrepancy: number;
  failed: number;
  remaining: number;
  /** The stop the driver is heading to now: the lowest-`dropSeq` stop still open. `null` once the run is finished. */
  nextDropId: string | null;
  complete: boolean;
}

/** Sorted by `dropSeq` — the order gudang loaded the truck in, which is the order the driver must follow. */
export function orderedDrops(drops: readonly Drop[]): Drop[] {
  return [...drops].sort((a, b) => a.dropSeq - b.dropSeq);
}

export function routeProgress(drops: readonly Drop[]): RouteProgress {
  const ordered = orderedDrops(drops);
  const done = ordered.filter(
    (d) => d.status === 'completed' || d.status === 'completed_discrepancy',
  ).length;
  const withDiscrepancy = ordered.filter((d) => d.status === 'completed_discrepancy').length;
  const failed = ordered.filter((d) => d.status === 'failed').length;
  const next = ordered.find((d) => !isFinished(d)) ?? null;

  return {
    total: ordered.length,
    done,
    withDiscrepancy,
    failed,
    remaining: ordered.length - done - failed,
    nextDropId: next?.id ?? null,
    // An EMPTY route is not a completed one. Reporting "selesai" for a truck
    // that was never given any stops would send a driver home mid-shift.
    complete: ordered.length > 0 && next === null,
  };
}
