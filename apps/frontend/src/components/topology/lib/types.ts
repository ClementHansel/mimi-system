/**
 * F12 `topology` wire types — transcribed from `TopologyTree` (CONTRACTS.md
 * §7.4) as actually implemented by `apps/backend/src/modules/device-registry/
 * topology.service.ts` (read directly rather than guessed from the contract
 * doc, per the ticket). One divergence from the CONTRACTS §7.4 sketch:
 * `TopologyLocation` carries `nodeEnabled: boolean` (BUILD-PLAN D-26) — the
 * Owner's location-level "this outlet is supposed to have a branch node"
 * setting, independent of whether `node` is currently non-null. That is the
 * field this whole feature leans on to tell "no node, by design" apart from
 * "node missing/unpaired, worth a look".
 */
import type { UUID, ISODateTime } from '@/lib/shared-types';

export interface TopologyCounts {
  online: number;
  stale: number;
  offline: number;
  total: number;
}

export interface TopologyNode {
  id: UUID;
  name: string;
  status: 'online' | 'stale' | 'offline';
  version: string | null;
  lastSeenAt: ISODateTime | null;
  relayQueueDepth: number;
  discoveredNewCount: number;
}

export interface TopologyDevice {
  id: UUID;
  name: string;
  category: 'tablet' | 'pos_terminal' | 'printer' | 'laptop' | 'router' | 'branch_node' | 'other';
  status: 'online' | 'stale' | 'offline' | 'unpaired' | 'retired';
  appVersion: string | null;
  queueDepth: number;
  lastSeenAt: ISODateTime | null;
  ipAddress: string | null;
}

export interface TopologySyncHealth {
  queueDepth: number;
  quarantineDepth: number;
  lastSyncAt: ISODateTime | null;
  conflictsOpen: number;
  exceptionsOpen: number;
  offlineAuthPending: number;
}

export interface TopologyLocation {
  location: { id: UUID; code: string; name: string; type: 'warehouse' | 'outlet'; city: string };
  /** D-26: whether the Owner switched a branch node ON for this outlet — see file docblock. */
  nodeEnabled: boolean;
  node: TopologyNode | null;
  devices: TopologyDevice[];
  counts: TopologyCounts;
  syncHealth: TopologySyncHealth;
  outletStatus: 'online' | 'degraded' | 'offline';
}

export interface TopologyCityGroup {
  city: string;
  counts: TopologyCounts;
  outlets: TopologyLocation[];
}

export interface TopologyTree {
  generatedAt: ISODateTime;
  pusat: TopologyLocation | null;
  cities: TopologyCityGroup[];
  totals: TopologyCounts & {
    outletsOffline: number;
    openConflicts: number;
    openExceptions: number;
  };
}

export interface TopologySummary {
  totals: TopologyCounts & {
    outletsOffline: number;
    openConflicts: number;
    openExceptions: number;
  };
  byCity: { city: string; counts: TopologyCounts; outletsOffline: number }[];
}

/** `GET /api/sync/status` row (CONTRACTS §4.23). */
export interface SyncStatusRow {
  locationId: UUID;
  locationName: string;
  devices: {
    deviceId: UUID;
    name: string;
    queueDepth: number;
    quarantineDepth: number;
    lastSyncAt: ISODateTime | null;
    cursorLag: number;
    status: string;
  }[];
  node: { nodeId: UUID } | null;
  openConflicts: number;
  openExceptions: number;
}

/** `GET /api/sync/conflicts` row (CONTRACTS §4.23). */
export interface SyncConflictRow {
  id: UUID;
  kind: string;
  queue: 'conflict' | 'exception' | 'finance' | 'hr';
  entity: string;
  entityId: UUID;
  locationId: UUID | null;
  winnerEventId: UUID | null;
  loserEventId: UUID | null;
  detail: Record<string, unknown>;
  physicalEffectSuspected: boolean;
  status: string;
  createdAt: ISODateTime;
  resolveInUrl: string;
}

/** `GET /api/sync/reconciliations` row (CONTRACTS §4.23, D-16). */
export interface ReconciliationRow {
  id: UUID;
  locationName: string;
  storageAreaName: string | null;
  itemName: string;
  tier: string;
  expectedQty: string;
  storedQty: string;
  divergence: string;
  status: string;
  detectedAt: ISODateTime;
}
