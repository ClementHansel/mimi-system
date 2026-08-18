import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SyncStatusPill, SyncRetryButton } from './SyncStatusPill';
import { useConnectivityStore } from '@/stores/connectivity-store';
import { useManualConnectivityCheck } from '@/components/layout/useManualConnectivityCheck';

vi.mock('@/components/layout/useManualConnectivityCheck', () => ({
  useManualConnectivityCheck: vi.fn(),
}));

const mockedUseManualConnectivityCheck = vi.mocked(useManualConnectivityCheck);

/**
 * D-25b: connectivity (online/offline) and sync (synced/not-synced) are two
 * genuinely independent states. These tests exist specifically to pin down
 * the two combinations a single combined indicator would hide: online-with-
 * a-backlog, and offline-but-fully-drained.
 */
describe('SyncStatusPill', () => {
  beforeEach(() => {
    useConnectivityStore.setState({
      tier: 'online',
      queueDepth: 0,
      isSyncing: false,
      lastSyncAt: null,
      cloudReachable: true,
      manualCheckStatus: 'idle',
      manualCheckErrorKey: null,
    });
  });

  it('online + synced: shows Online and Tersinkron together', () => {
    render(<SyncStatusPill />);
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('Tersinkron')).toBeInTheDocument();
  });

  it('online + backlog: still shows Online, but the sync pill shows the queue — connectivity being fine must not hide a pending backlog', () => {
    useConnectivityStore.setState({ tier: 'online', queueDepth: 5 });
    render(<SyncStatusPill />);
    expect(screen.getByText('Online')).toBeInTheDocument();
    expect(screen.getByText('5 menunggu')).toBeInTheDocument();
  });

  it('offline + backlog: shows Offline and the queue count together', () => {
    useConnectivityStore.setState({ tier: 'isolated', queueDepth: 3 });
    render(<SyncStatusPill />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('3 menunggu')).toBeInTheDocument();
  });

  it('offline + drained: shows Offline for connectivity but Tersinkron for sync — this is the combination a combined indicator would misreport as just "offline"', () => {
    useConnectivityStore.setState({ tier: 'isolated', queueDepth: 0 });
    render(<SyncStatusPill />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
    expect(screen.getByText('Tersinkron')).toBeInTheDocument();
  });

  it('shows the syncing state distinctly while a push/pull cycle is in flight', () => {
    useConnectivityStore.setState({ tier: 'online', queueDepth: 2, isSyncing: true });
    render(<SyncStatusPill />);
    expect(screen.getByText('Menyinkronkan…')).toBeInTheDocument();
  });

  it('LAN-only tier reads as connectivity-offline (the device cannot reach the cloud, only the paired node)', () => {
    useConnectivityStore.setState({ tier: 'lan', queueDepth: 0 });
    render(<SyncStatusPill />);
    expect(screen.getByText('Offline')).toBeInTheDocument();
  });

  it('surfaces the last-sync time via the title attribute', () => {
    useConnectivityStore.setState({ lastSyncAt: new Date().toISOString() });
    render(<SyncStatusPill />);
    expect(screen.getByTitle(/Sinkron terakhir/)).toBeInTheDocument();
  });

  it('surfaces "never synced" when this device has no sync history', () => {
    render(<SyncStatusPill />);
    expect(screen.getByTitle('Belum pernah tersinkron')).toBeInTheDocument();
  });
});

describe('SyncRetryButton — the D-25b manual "Coba Sinkron" action', () => {
  it('is idle by default, labelled "Coba Sinkron"', () => {
    mockedUseManualConnectivityCheck.mockReturnValue({
      status: 'idle',
      errorKey: null,
      run: vi.fn(),
    });
    render(<SyncRetryButton />);
    expect(screen.getByRole('button', { name: 'Coba Sinkron' })).toBeInTheDocument();
    expect(screen.queryByText('Berhasil')).not.toBeInTheDocument();
  });

  it('shows an in-progress state and disables the button while checking', () => {
    mockedUseManualConnectivityCheck.mockReturnValue({
      status: 'checking',
      errorKey: null,
      run: vi.fn(),
    });
    render(<SyncRetryButton />);
    const button = screen.getByRole('button', { name: 'Memeriksa…' });
    expect(button).toBeDisabled();
  });

  it('shows an honest success outcome', () => {
    mockedUseManualConnectivityCheck.mockReturnValue({
      status: 'success',
      errorKey: null,
      run: vi.fn(),
    });
    render(<SyncRetryButton />);
    expect(screen.getByText('Berhasil')).toBeInTheDocument();
  });

  it('shows an honest failure outcome with its reason when the device is still offline', () => {
    mockedUseManualConnectivityCheck.mockReturnValue({
      status: 'error',
      errorKey: 'offline',
      run: vi.fn(),
    });
    render(<SyncRetryButton />);
    expect(screen.getByText('Masih offline — server tidak dapat dihubungi')).toBeInTheDocument();
  });

  it('shows an honest failure outcome when connectivity was fine but the sync attempt itself failed', () => {
    mockedUseManualConnectivityCheck.mockReturnValue({
      status: 'error',
      errorKey: 'syncFailed',
      run: vi.fn(),
    });
    render(<SyncRetryButton />);
    expect(screen.getByText('Sinkronisasi gagal — coba lagi')).toBeInTheDocument();
  });

  it('invokes the hook action when clicked', () => {
    const run = vi.fn();
    mockedUseManualConnectivityCheck.mockReturnValue({ status: 'idle', errorKey: null, run });
    render(<SyncRetryButton />);
    fireEvent.click(screen.getByRole('button', { name: 'Coba Sinkron' }));
    expect(run).toHaveBeenCalledTimes(1);
  });
});
