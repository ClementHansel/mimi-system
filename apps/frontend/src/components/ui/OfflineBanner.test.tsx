import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { OfflineBanner } from './OfflineBanner';
import { useConnectivityStore } from '@/stores/connectivity-store';
import { useManualConnectivityCheck } from '@/components/layout/useManualConnectivityCheck';

vi.mock('@/components/layout/useManualConnectivityCheck', () => ({
  useManualConnectivityCheck: vi.fn(),
}));

vi.mocked(useManualConnectivityCheck).mockReturnValue({
  status: 'idle',
  errorKey: null,
  run: vi.fn(),
});

describe('OfflineBanner', () => {
  beforeEach(() => {
    useConnectivityStore.setState({
      tier: 'online',
      queueDepth: 0,
      lastSyncAt: null,
      isSyncing: false,
      cloudReachable: true,
    });
  });

  it('renders nothing while fully online', () => {
    const { container } = render(<OfflineBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it('explains LAN-only mode distinctly from full isolation', () => {
    useConnectivityStore.setState({ tier: 'lan' });
    render(<OfflineBanner />);
    expect(screen.getByText('Mode LAN (Node Cabang)')).toBeInTheDocument();
  });

  it('explains full isolation with its own wording, not a re-use of the LAN copy', () => {
    useConnectivityStore.setState({ tier: 'isolated' });
    render(<OfflineBanner />);
    expect(screen.getByText('Offline — Tidak Ada Koneksi')).toBeInTheDocument();
  });

  it('shows the queue depth only when there is one — no false alarm while drained', () => {
    useConnectivityStore.setState({ tier: 'isolated', queueDepth: 0 });
    render(<OfflineBanner />);
    expect(screen.queryByText(/menunggu sinkronisasi/)).not.toBeInTheDocument();
  });

  it('shows the queue depth when the outbox has a backlog', () => {
    useConnectivityStore.setState({ tier: 'isolated', queueDepth: 12 });
    render(<OfflineBanner />);
    expect(screen.getByText('12 transaksi menunggu sinkronisasi')).toBeInTheDocument();
  });

  it('always surfaces the manual "Coba Sinkron" action while degraded', () => {
    useConnectivityStore.setState({ tier: 'lan' });
    render(<OfflineBanner />);
    expect(screen.getByRole('button', { name: 'Coba Sinkron' })).toBeInTheDocument();
  });
});
