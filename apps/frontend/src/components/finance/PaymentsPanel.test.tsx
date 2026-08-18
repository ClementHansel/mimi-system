import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PaymentsPanel } from './PaymentsPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';
import type { PaymentVerification } from './types';

/**
 * F07 finance — the Pending -> Verified -> Paid ladder is the daily work
 * (FR-ACCT-01..04): a transfer-method sale must sit `pending` until Finance
 * confirms the money arrived, `verify` must be impossible without proof
 * attached (`ERR_PROOF_REQUIRED` on the backend), and `pay` must only be
 * reachable from `verified`. These tests drive the real component tree
 * (queue row -> drawer) rather than asserting on internal state, and also
 * cover that money renders via `formatMoney` (Rupiah-grouped), never a raw
 * decimal string.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'finance1',
      name: 'Finance Satu',
      roleKey: 'finance',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

function pv(overrides: Partial<PaymentVerification> = {}): PaymentVerification {
  return {
    id: 'pv-1',
    pvNumber: 'PV-202608-00001',
    refType: 'sale_payment',
    refId: null,
    refNumber: null,
    payeeType: 'other',
    payeeName: 'Toko ABC',
    amount: '1250000.00',
    status: 'pending',
    proofUrl: null,
    referenceNumber: null,
    submittedBy: 'u2',
    verifiedBy: null,
    verifiedAt: null,
    paidBy: null,
    paidAt: null,
    paidVia: null,
    locationName: 'Outlet Sanur',
    ...overrides,
  };
}

describe('PaymentsPanel — payment verification queue', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it('renders the queue with Rupiah-formatted money and a status badge, never a raw decimal string', async () => {
    setPermissions(['payment.read']);
    vi.mocked(api.get).mockResolvedValue({ rows: [pv()], total: 1, page: 1, pageSize: 25 });

    render(<PaymentsPanel />);

    expect(await screen.findByText('PV-202608-00001')).toBeInTheDocument();
    expect(screen.getByText('Rp1.250.000,00')).toBeInTheDocument();
    expect(screen.queryByText('1250000.00')).not.toBeInTheDocument();
    expect(screen.getAllByText('Belum Terverifikasi').length).toBeGreaterThan(0);
  });

  it('disables Verifikasi on a pending PV with no proof attached yet', async () => {
    setPermissions(['payment.read', 'payment.verify']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/accounting/payments/')) return Promise.resolve(pv({ proofUrl: null }));
      return Promise.resolve({ rows: [pv({ proofUrl: null })], total: 1, page: 1, pageSize: 25 });
    });

    render(<PaymentsPanel />);
    fireEvent.click(await screen.findByText('PV-202608-00001'));

    const verifyButton = await screen.findByRole('button', { name: 'Verifikasi' });
    expect(verifyButton).toBeDisabled();
    expect(
      screen.getByText('Bukti pembayaran harus diunggah sebelum dapat diverifikasi.'),
    ).toBeInTheDocument();
  });

  it('enables Verifikasi once proof is attached, and calls the verify endpoint', async () => {
    setPermissions(['payment.read', 'payment.verify']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/accounting/payments/'))
        return Promise.resolve(pv({ proofUrl: 'https://storage/proof.jpg' }));
      return Promise.resolve({
        rows: [pv({ proofUrl: 'https://storage/proof.jpg' })],
        total: 1,
        page: 1,
        pageSize: 25,
      });
    });
    vi.mocked(api.post).mockResolvedValue(pv({ status: 'verified' }));

    render(<PaymentsPanel />);
    fireEvent.click(await screen.findByText('PV-202608-00001'));

    const verifyButton = await screen.findByRole('button', { name: 'Verifikasi' });
    expect(verifyButton).not.toBeDisabled();
    fireEvent.click(verifyButton);

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith('/accounting/payments/pv-1/verify', {
        note: undefined,
      }),
    );
  });

  it('shows the Bayar action (not Verifikasi) once a PV is verified, gated by payment.pay', async () => {
    setPermissions(['payment.read', 'payment.pay']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/accounting/payments/'))
        return Promise.resolve(pv({ status: 'verified', proofUrl: 'https://storage/proof.jpg' }));
      return Promise.resolve({
        rows: [pv({ status: 'verified' })],
        total: 1,
        page: 1,
        pageSize: 25,
      });
    });

    render(<PaymentsPanel />);
    fireEvent.click(await screen.findByText('PV-202608-00001'));

    expect(await screen.findByRole('button', { name: 'Tandai Dibayar' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verifikasi' })).not.toBeInTheDocument();
  });

  it('never renders Verifikasi/Bayar/Tolak actions without the matching permission', async () => {
    setPermissions(['payment.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/accounting/payments/'))
        return Promise.resolve(pv({ proofUrl: 'https://storage/proof.jpg' }));
      return Promise.resolve({ rows: [pv()], total: 1, page: 1, pageSize: 25 });
    });

    render(<PaymentsPanel />);
    fireEvent.click(await screen.findByText('PV-202608-00001'));

    // Drawer opened once its title (the PV number, duplicated from the row) renders a second time.
    await waitFor(() => expect(screen.getAllByText('PV-202608-00001').length).toBeGreaterThan(1));
    expect(screen.queryByRole('button', { name: 'Verifikasi' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tandai Dibayar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tolak' })).not.toBeInTheDocument();
  });
});
