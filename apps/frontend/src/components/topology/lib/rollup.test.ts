import { describe, it, expect } from 'vitest';
import { nodeDisplayState, isDeviceAlarmWorthy, sortOutletsBySeverity } from './rollup';
import type { TopologyLocation } from './types';

function loc(overrides: Partial<TopologyLocation> = {}): TopologyLocation {
  return {
    location: { id: 'l1', code: 'OUT1', name: 'Outlet 1', type: 'outlet', city: 'Balikpapan' },
    nodeEnabled: false,
    node: null,
    devices: [],
    counts: { online: 0, stale: 0, offline: 0, total: 0 },
    syncHealth: { queueDepth: 0, quarantineDepth: 0, lastSyncAt: null, conflictsOpen: 0, exceptionsOpen: 0, offlineAuthPending: 0 },
    outletStatus: 'online',
    ...overrides,
  };
}

const NODE = { id: 'n1', name: 'Node 1', status: 'online' as const, version: '1.0.0', lastSeenAt: null, relayQueueDepth: 0, discoveredNewCount: 0 };

describe('nodeDisplayState (D-26 no-node read)', () => {
  it('reads as "none" — never supposed to have one — when the Owner never enabled a node for this outlet', () => {
    expect(nodeDisplayState(loc({ nodeEnabled: false, node: null }))).toBe('none');
  });

  it('reads as "pairing_pending" — worth flagging — when the setting is on but no node has paired (or it dropped, without the setting being switched off)', () => {
    expect(nodeDisplayState(loc({ nodeEnabled: true, node: null }))).toBe('pairing_pending');
  });

  it('reads as "paired" whenever a node is actually present, regardless of the setting flag', () => {
    expect(nodeDisplayState(loc({ nodeEnabled: true, node: NODE }))).toBe('paired');
    // A node present with nodeEnabled somehow false (setting toggled off after pairing, before unpair)
    // still reports the real node — never hides live hardware.
    expect(nodeDisplayState(loc({ nodeEnabled: false, node: NODE }))).toBe('paired');
  });
});

describe('isDeviceAlarmWorthy (W6-06 alert precision — offline is not always a fault)', () => {
  it('does not flag a single offline device when the outlet overall is still online/degraded', () => {
    expect(isDeviceAlarmWorthy('offline', 'online')).toBe(false);
    expect(isDeviceAlarmWorthy('offline', 'degraded')).toBe(false);
  });

  it('flags an offline device only once the whole outlet has rolled up to offline', () => {
    expect(isDeviceAlarmWorthy('offline', 'offline')).toBe(true);
  });

  it('never flags a stale or online device, even in a fully offline outlet', () => {
    expect(isDeviceAlarmWorthy('stale', 'offline')).toBe(false);
    expect(isDeviceAlarmWorthy('online', 'offline')).toBe(false);
  });
});

describe('sortOutletsBySeverity', () => {
  it('surfaces offline outlets first, then degraded, then online, so a wallboard reader sees problems immediately', () => {
    const outlets = [
      loc({ location: { id: 'a', code: 'A', name: 'A', type: 'outlet', city: 'X' }, outletStatus: 'online' }),
      loc({ location: { id: 'b', code: 'B', name: 'B', type: 'outlet', city: 'X' }, outletStatus: 'offline' }),
      loc({ location: { id: 'c', code: 'C', name: 'C', type: 'outlet', city: 'X' }, outletStatus: 'degraded' }),
    ];
    const sorted = sortOutletsBySeverity(outlets);
    expect(sorted.map((o) => o.location.id)).toEqual(['b', 'c', 'a']);
  });

  it('breaks ties within the same severity alphabetically by name, and does not mutate the input array', () => {
    const outlets = [
      loc({ location: { id: 'z', code: 'Z', name: 'Zebra', type: 'outlet', city: 'X' }, outletStatus: 'offline' }),
      loc({ location: { id: 'a', code: 'A', name: 'Apple', type: 'outlet', city: 'X' }, outletStatus: 'offline' }),
    ];
    const sorted = sortOutletsBySeverity(outlets);
    expect(sorted.map((o) => o.location.id)).toEqual(['a', 'z']);
    expect(outlets.map((o) => o.location.id)).toEqual(['z', 'a']);
  });
});
