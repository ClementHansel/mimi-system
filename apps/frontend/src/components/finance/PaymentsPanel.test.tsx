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
    proofAttachmentId: null,
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
      if (path.startsWith('/accounting/payments/'))
        return Promise.resolve(pv({ proofAttachmentId: null }));
      return Promise.resolve({
        rows: [pv({ proofAttachmentId: null })],
        total: 1,
        page: 1,
        pageSize: 25,
      });
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
        return Promise.resolve(pv({ proofAttachmentId: 'att-proof-1' }));
      return Promise.resolve({
        rows: [pv({ proofAttachmentId: 'att-proof-1' })],
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
        return Promise.resolve(pv({ status: 'verified', proofAttachmentId: 'att-proof-1' }));
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
        return Promise.resolve(pv({ proofAttachmentId: 'att-proof-1' }));
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

/**
 * "CATAT PEMBAYARAN BARU" ASKS FOR THE FIELDS IT DISPLAYS.
 *
 * The form used to send `refType`, `payeeType`, `amount`, `referenceNumber`
 * and `notes` — and nothing else. `CreatePaymentDto` accepted `payeeId` and
 * `locationId` the whole time; the form never asked for either. Since
 * "Penerima" is a JOIN on `payee_id` and "Lokasi" a JOIN on `location_id`,
 * both columns rendered as a permanent em-dash on every hand-created voucher,
 * with nothing the user could do about it. A client asked exactly that on
 * 2026-09-09 ("ini field ini bakal keisinya drmn") and the honest answer was
 * "from nowhere".
 *
 * It also offered ref types it cannot honour: picking "Purchase Order" made a
 * voucher linked to no PO, which can never satisfy `PurchaseOrderService
 * .close`'s payment check — an orphan that looks like a real supplier payment.
 */
describe('PaymentsPanel — Catat Pembayaran Baru', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  /** Empty queue + the two lookups the modal fires on open. */
  function mockCreateFormLookups(
    suppliers: { id: string; code: string; name: string }[] = [
      { id: 'sup-1', code: 'SUP001', name: 'CV Ayam Segar Kaltim' },
    ],
  ) {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/locations'))
        return Promise.resolve({ rows: [{ id: 'loc-1', name: 'Outlet Sanur', code: 'SNR' }] });
      if (path.startsWith('/suppliers/directory'))
        return Promise.resolve({
          rows: suppliers,
          total: suppliers.length,
          page: 1,
          pageSize: 200,
        });
      if (path.startsWith('/hr/employees'))
        return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 50 });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });
  }

  async function openCreateModal() {
    render(<PaymentsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Catat Pembayaran/ }));
    return screen.findByText('Catat Pembayaran Baru');
  }

  /**
   * `MoneyInput` strips non-digits on change and commits the canonical Money
   * string on BLUR (see its own tests) — a bare `fireEvent.change` leaves the
   * form's `amount` null, which keeps Simpan disabled and makes the assertion
   * fail for a reason that has nothing to do with what is under test.
   */
  function fillAmount(digits: string) {
    const input = screen.getByLabelText(/Jumlah/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: digits } });
    fireEvent.blur(input);
  }

  it('offers only the source-less ref types, never Purchase Order or Penggajian', async () => {
    setPermissions(['payment.read', 'payment.proof.upload']);
    mockCreateFormLookups();

    await openCreateModal();

    const refTypeSelect = screen.getByLabelText(/Jenis Referensi/) as HTMLSelectElement;
    const offered = Array.from(refTypeSelect.options).map((o) => o.value);
    expect(offered).toEqual(
      expect.arrayContaining(['other', 'sale_payment', 'online_order', 'incentive', 'thr']),
    );
    // The five created by their own flow, which pass refId/payeeId/locationId.
    expect(offered).not.toContain('purchase_order');
    expect(offered).not.toContain('payroll_run');
    expect(offered).not.toContain('petty_cash');
    expect(offered).not.toContain('maintenance_job');
    expect(offered).not.toContain('employee_loan');
  });

  it('sends the chosen locationId, so Lokasi is no longer a permanent em-dash', async () => {
    setPermissions(['payment.read', 'payment.proof.upload']);
    mockCreateFormLookups();
    vi.mocked(api.post).mockResolvedValue(pv());

    await openCreateModal();

    fireEvent.click(await screen.findByRole('combobox', { name: 'Lokasi' }));
    fireEvent.click(await screen.findByText('Outlet Sanur'));
    fillAmount('250000');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/accounting/payments',
        expect.objectContaining({ locationId: 'loc-1' }),
      ),
    );
  });

  it('asks WHICH supplier once Jenis Penerima is supplier, and sends payeeId', async () => {
    setPermissions(['payment.read', 'payment.proof.upload']);
    mockCreateFormLookups();
    vi.mocked(api.post).mockResolvedValue(pv());

    await openCreateModal();

    // No payee picker while the type has no table behind it.
    expect(screen.queryByRole('combobox', { name: 'Penerima' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/Jenis Penerima/), { target: { value: 'supplier' } });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Penerima' }));
    fireEvent.click(await screen.findByText('CV Ayam Segar Kaltim'));
    fillAmount('250000');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/accounting/payments',
        expect.objectContaining({ payeeType: 'supplier', payeeId: 'sup-1' }),
      ),
    );
  });

  it('drops a stale payeeId when Jenis Penerima changes, never submitting an id that joins to nothing', async () => {
    setPermissions(['payment.read', 'payment.proof.upload']);
    mockCreateFormLookups();
    vi.mocked(api.post).mockResolvedValue(pv());

    await openCreateModal();

    fireEvent.change(screen.getByLabelText(/Jenis Penerima/), { target: { value: 'supplier' } });
    fireEvent.click(await screen.findByRole('combobox', { name: 'Penerima' }));
    fireEvent.click(await screen.findByText('CV Ayam Segar Kaltim'));

    // Switching to "Lainnya" has no picker at all — a supplier id left behind
    // here would submit a payee_id that resolves to no name.
    fireEvent.change(screen.getByLabelText(/Jenis Penerima/), { target: { value: 'other' } });
    fillAmount('250000');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));

    await waitFor(() => expect(api.post).toHaveBeenCalled());
    const body = vi.mocked(api.post).mock.calls[0]![1] as Record<string, unknown>;
    expect(body.payeeId).toBeUndefined();
  });
});
