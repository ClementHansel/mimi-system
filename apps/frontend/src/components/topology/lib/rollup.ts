/**
 * Pure rollup helpers for F12 `topology` — kept separate from rendering so
 * the two things the ticket calls out as easy to get wrong (the no-node
 * read, and not turning "offline" into an alarm) are unit-testable without a
 * DOM.
 *
 * The outlet-level `online | degraded | offline` verdict itself is computed
 * server-side (`topology.service.ts#buildLocation`, mirroring the
 * CONTRACTS §7.3 "ALL devices AND node offline for >10 min" alert-precision
 * rule) — this file does not recompute it, only interprets it and the
 * node/outlet shape for display.
 */
import type { TopologyLocation, TopologyTree } from './types';

/**
 * D-26: `node: null` alone is ambiguous — it means either "this outlet was
 * never supposed to have one" (the default deployment) or "the setting is on
 * but pairing hasn't happened / the node dropped out without the setting
 * being turned off". `nodeEnabled` is what disambiguates the two, and only
 * the second is worth an operator's attention.
 *
 *  - `none`            nodeEnabled=false, node=null   — expected; nothing to show
 *  - `pairing_pending`  nodeEnabled=true,  node=null   — flag: setting on, no node seen
 *  - `paired`          node present                    — render its own status
 */
export type NodeDisplayState = 'none' | 'pairing_pending' | 'paired';

export function nodeDisplayState(
  location: Pick<TopologyLocation, 'nodeEnabled' | 'node'>,
): NodeDisplayState {
  if (location.node) return 'paired';
  return location.nodeEnabled ? 'pairing_pending' : 'none';
}

/** Outlet status -> StatusBadge status token (`status.topologyOutlet.*`, VOCAB `degraded`/`online`/`offline`). */
export function outletStatusToken(
  outletStatus: TopologyLocation['outletStatus'],
): 'online' | 'degraded' | 'offline' {
  return outletStatus;
}

/**
 * A single offline device is never itself the alarm (W6-06 alert precision —
 * "an alert that always fires is one nobody reads"). Only surface a
 * device-level warning affordance when the WHOLE outlet has rolled up to
 * `offline` (i.e. every device AND the node, if any, are dark) — otherwise a
 * lone offline tablet at a closed outlet renders as quiet/neutral, matching
 * `StatusBadge`'s existing muted tone for `offline`.
 */
export function isDeviceAlarmWorthy(
  deviceStatus: string,
  outletStatus: TopologyLocation['outletStatus'],
): boolean {
  return deviceStatus === 'offline' && outletStatus === 'offline';
}

/** Sort key so the worst outlets (offline first, then degraded, then online) surface at the top of a city group. */
const OUTLET_SEVERITY: Record<TopologyLocation['outletStatus'], number> = {
  offline: 0,
  degraded: 1,
  online: 2,
};

export function sortOutletsBySeverity(outlets: TopologyLocation[]): TopologyLocation[] {
  return [...outlets].sort((a, b) => {
    const bySeverity = OUTLET_SEVERITY[a.outletStatus] - OUTLET_SEVERITY[b.outletStatus];
    if (bySeverity !== 0) return bySeverity;
    return a.location.name.localeCompare(b.location.name);
  });
}

/**
 * Every location in the tree (Pusat + every outlet across every city), for
 * the "add device"/"move device" pickers — reusing the tree the panel
 * already fetched rather than a second `GET /locations` call, and staying
 * consistent with exactly what this monitoring surface can already see (an
 * outlet a Supervisor's `topology.read` scope excludes never appears here
 * either, matching the tree it came from).
 */
export function flattenTopologyLocations(tree: TopologyTree): { id: string; name: string }[] {
  const outlets = tree.cities.flatMap((city) =>
    city.outlets.map((o) => ({ id: o.location.id, name: o.location.name })),
  );
  return tree.pusat
    ? [{ id: tree.pusat.location.id, name: tree.pusat.location.name }, ...outlets]
    : outlets;
}
