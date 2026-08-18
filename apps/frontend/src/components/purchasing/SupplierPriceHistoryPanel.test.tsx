import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SupplierPriceHistoryPanel } from './SupplierPriceHistoryPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';
import { ApiError } from '@/lib/api';

/**
 * FR-SUP-04/06, D-20 — outlet roles may see a supplier's name/contact but
 * never its price history. `PurchasingShell` hides this tab entirely for
 * such a role; this suite covers the panel's own defensive behavior when
 * reached anyway (stale session, deep link) and the "pick a supplier first"
 * empty state, not just the happy path table.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn() } };
});

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'fin1',
      name: 'Finance Satu',
      roleKey: 'finance',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

describe('SupplierPriceHistoryPanel — role-locked pricing (D-20)', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
  });

  it('renders a "no access" empty state, never a table, without supplier.price.read', () => {
    setPermissions(['purchasing.read']);

    render(<SupplierPriceHistoryPanel />);

    expect(screen.getByText('Anda tidak memiliki akses ke bagian ini.')).toBeInTheDocument();
    expect(api.get).not.toHaveBeenCalled();
  });

  it('shows a real error message, not an indefinite spinner, when the supplier list call 403s', async () => {
    setPermissions(['supplier.read', 'supplier.price.read']);
    vi.mocked(api.get).mockRejectedValue(new ApiError(403, 'ERR_FORBIDDEN', 'Forbidden'));

    render(<SupplierPriceHistoryPanel />);

    expect(await screen.findByText('Forbidden')).toBeInTheDocument();
  });

  it('prompts to pick a supplier before it ever calls the price-history endpoint', async () => {
    setPermissions(['supplier.read', 'supplier.price.read']);
    vi.mocked(api.get).mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 25 });

    render(<SupplierPriceHistoryPanel />);

    await waitFor(() =>
      expect(screen.getByText('Pilih supplier untuk melihat riwayat harga.')).toBeInTheDocument(),
    );
    expect(api.get).not.toHaveBeenCalledWith(expect.stringContaining('/price-history'));
  });
});
