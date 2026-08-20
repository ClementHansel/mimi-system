import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SuppliersPanel } from './SuppliersPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';

/**
 * FR-SUP-01, D-20 — the supplier master list.
 *
 * The point of these tests is the PERMISSION SPLIT, not the table markup.
 * `supplier.read` lets you see suppliers; `supplier.manage` is what allows
 * creating or deactivating them. Rendering a control the server will 403 is
 * the exact failure that made "purchasing has no features" a reported bug
 * (owner held `supplier.read` but the create paths were gated elsewhere), so
 * it is worth a test rather than a glance.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn(), delete: vi.fn() } };
});

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'kgd1',
      name: 'Kepala Gudang',
      roleKey: 'kepala_gudang',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

const SUPPLIER = {
  id: 's1',
  code: 'SUP-001',
  name: 'CV Ayam Makmur',
  contactName: 'Pak Budi',
  phone: '0812345678',
  email: null,
  address: null,
  paymentTermsDays: 14,
  bankName: null,
  bankAccount: null,
  bankAccountName: null,
  outletVisible: false,
  isActive: true,
};

describe('SuppliersPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.get).mockResolvedValue({ rows: [SUPPLIER], total: 1, page: 1, pageSize: 200 });
  });

  it('lists suppliers with their payment terms', async () => {
    setPermissions(['supplier.read']);
    render(<SuppliersPanel />);

    expect(await screen.findByText('CV Ayam Makmur')).toBeInTheDocument();
    expect(screen.getByText('SUP-001')).toBeInTheDocument();
    // Terms are shown in days rather than as a bare number, because "14" alone
    // on a supplier row is ambiguous.
    expect(screen.getByText('14 hari')).toBeInTheDocument();
  });

  it('renders cash terms as words, not "0 hari"', async () => {
    setPermissions(['supplier.read']);
    vi.mocked(api.get).mockResolvedValue({
      rows: [{ ...SUPPLIER, paymentTermsDays: 0 }],
      total: 1,
      page: 1,
      pageSize: 200,
    });
    render(<SuppliersPanel />);

    expect(await screen.findByText('Tunai')).toBeInTheDocument();
    expect(screen.queryByText('0 hari')).not.toBeInTheDocument();
  });

  it('hides create and deactivate without supplier.manage', async () => {
    setPermissions(['supplier.read']);
    render(<SuppliersPanel />);

    await screen.findByText('CV Ayam Makmur');
    expect(screen.queryByRole('button', { name: 'Tambah Supplier' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Nonaktifkan' })).not.toBeInTheDocument();
    // Read-only users still get the way in to prices/history.
    expect(screen.getByRole('button', { name: 'Detail' })).toBeInTheDocument();
  });

  it('shows create and deactivate with supplier.manage', async () => {
    setPermissions(['supplier.read', 'supplier.manage']);
    render(<SuppliersPanel />);

    await screen.findByText('CV Ayam Makmur');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Tambah Supplier' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Nonaktifkan' })).toBeInTheDocument();
  });

  it('offers no deactivate for an already-inactive supplier', async () => {
    setPermissions(['supplier.read', 'supplier.manage']);
    vi.mocked(api.get).mockResolvedValue({
      rows: [{ ...SUPPLIER, isActive: false }],
      total: 1,
      page: 1,
      pageSize: 200,
    });
    render(<SuppliersPanel />);

    await screen.findByText('CV Ayam Makmur');
    expect(screen.queryByRole('button', { name: 'Nonaktifkan' })).not.toBeInTheDocument();
  });
});
