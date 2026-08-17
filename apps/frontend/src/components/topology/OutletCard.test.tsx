import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OutletCard } from './OutletCard';
import type { TopologyLocation, TopologyDevice } from './lib/types';

function device(overrides: Partial<TopologyDevice> = {}): TopologyDevice {
  return {
    id: 'd1',
    name: 'Tablet Kasir 1',
    category: 'tablet',
    status: 'online',
    appVersion: '1.4.0',
    queueDepth: 0,
    lastSeenAt: new Date().toISOString(),
    ipAddress: '10.0.0.5',
    ...overrides,
  };
}

function outlet(overrides: Partial<TopologyLocation> = {}): TopologyLocation {
  return {
    location: { id: 'l1', code: 'OUT1', name: 'Outlet Balikpapan Baru', type: 'outlet', city: 'Balikpapan' },
    nodeEnabled: false,
    node: null,
    devices: [device()],
    counts: { online: 1, stale: 0, offline: 0, total: 1 },
    syncHealth: { queueDepth: 0, quarantineDepth: 0, lastSyncAt: new Date().toISOString(), conflictsOpen: 0, exceptionsOpen: 0, offlineAuthPending: 0 },
    outletStatus: 'online',
    ...overrides,
  };
}

describe('OutletCard — status rollup', () => {
  it('renders the outlet name and its rolled-up status badge', () => {
    render(<OutletCard location={outlet({ outletStatus: 'online' })} />);
    expect(screen.getByText('Outlet Balikpapan Baru')).toBeInTheDocument();
    // The outlet-level badge plus the one online device's own badge both read "Online".
    expect(screen.getAllByText('Online').length).toBe(2);
  });

  it('shows the outlet as fully offline (red signal) when every device under it is dark and there is no node', () => {
    render(
      <OutletCard
        location={outlet({
          outletStatus: 'offline',
          devices: [device({ status: 'offline' }), device({ id: 'd2', name: 'Printer Dapur', category: 'printer', status: 'offline' })],
          counts: { online: 0, stale: 0, offline: 2, total: 2 },
        })}
      />,
    );
    // Outlet-level badge + both device rows — three "Offline" labels, all the same muted tone
    // (the alarm signal is the single outlet-level badge existing at all, not per-device styling, W6-06).
    expect(screen.getAllByText('Offline').length).toBe(3);
  });

  it('shows degraded when only some devices are down', () => {
    render(
      <OutletCard
        location={outlet({
          outletStatus: 'degraded',
          devices: [device({ status: 'online' }), device({ id: 'd2', status: 'offline' })],
          counts: { online: 1, stale: 0, offline: 1, total: 2 },
        })}
      />,
    );
    expect(screen.getByText('Sebagian Bermasalah')).toBeInTheDocument();
  });
});

describe('OutletCard — D-26 no-node case', () => {
  it('reads as "no branch node" (not a missing/degraded state) when nodeEnabled is false and node is null', () => {
    render(<OutletCard location={outlet({ nodeEnabled: false, node: null })} />);
    expect(screen.getByText('Tanpa node cabang')).toBeInTheDocument();
    // Must NOT render as a warning/degraded badge for the node itself.
    expect(screen.queryByText('Sebagian Bermasalah')).not.toBeInTheDocument();
  });

  it('flags the pairing-pending state distinctly when the node setting is on but no node has paired', () => {
    render(<OutletCard location={outlet({ nodeEnabled: true, node: null })} />);
    expect(screen.queryByText('Tanpa node cabang')).not.toBeInTheDocument();
    expect(screen.getByText('Sebagian Bermasalah')).toBeInTheDocument();
  });

  it('shows the node name and its own live status once a node is paired', () => {
    render(
      <OutletCard
        location={outlet({
          nodeEnabled: true,
          node: { id: 'n1', name: 'Node Outlet 1', status: 'online', version: '2.0.0', lastSeenAt: new Date().toISOString(), relayQueueDepth: 0, discoveredNewCount: 0 },
        })}
      />,
    );
    expect(screen.getByText('Node: Node Outlet 1')).toBeInTheDocument();
  });
});
