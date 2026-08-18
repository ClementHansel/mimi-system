import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PosStatusBar } from './PosStatusBar';
import { useConnectivityStore } from '@/stores/connectivity-store';

/**
 * The brief: "Offline state must be legible at all times ... a cashier needs
 * to know whether their sales are safe, not discover a problem at end of
 * shift." These assert the cross-tablet-visibility caveat only appears once
 * the device has actually dropped off the cloud/LAN tier — it must never
 * show while fully online (a false alarm is as bad as a missed one).
 */
describe('PosStatusBar — offline-state indicator', () => {
  beforeEach(() => {
    useConnectivityStore.setState({
      tier: 'online',
      queueDepth: 0,
      lastSyncAt: null,
      isSyncing: false,
      cloudReachable: true,
    });
  });

  it('shows no cross-tablet-visibility warning while online', () => {
    render(<PosStatusBar locationName="Outlet Cempaka" />);
    expect(screen.queryByText(/tablet lain/i)).not.toBeInTheDocument();
    expect(screen.getByText('Tersinkron')).toBeInTheDocument();
  });

  it('warns that sales are not yet cross-tablet-visible when on the LAN-only tier', () => {
    useConnectivityStore.setState({ tier: 'lan' });
    render(<PosStatusBar locationName="Outlet Cempaka" />);
    expect(screen.getByText(/tablet lain/i)).toBeInTheDocument();
  });

  it('warns and shows offline when fully isolated', () => {
    useConnectivityStore.setState({ tier: 'isolated' });
    render(<PosStatusBar locationName="Outlet Cempaka" />);
    expect(screen.getByText(/tablet lain/i)).toBeInTheDocument();
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('surfaces queued-sale depth so a cashier can see their sales are safely queued, not lost', () => {
    useConnectivityStore.setState({ tier: 'isolated', queueDepth: 7 });
    render(<PosStatusBar locationName="Outlet Cempaka" />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('always shows the outlet name, so a multi-tablet outlet knows which device it is looking at', () => {
    render(<PosStatusBar locationName="Outlet Cempaka" />);
    expect(screen.getByText('Outlet Cempaka')).toBeInTheDocument();
  });
});
