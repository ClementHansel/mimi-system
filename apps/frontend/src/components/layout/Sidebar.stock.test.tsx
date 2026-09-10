import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from './Sidebar';
import { useSessionStore } from '@/stores/session-store';

/**
 * STOK GUDANG IS REACHABLE FROM THE OFFICE SIDEBAR.
 *
 * Owner, 2026-09-10: "add menu in the office to see the stocks in gudang too."
 * The screen itself already existed at `/warehouse/stock`; what was missing was
 * a way in that did not drop an office user into gudang's sidebar.
 *
 * `nav.test.ts` covers the CONFIG — that the entry exists in both trees, that
 * `/warehouse/stock` is shared while the other six gudang panels are not. This
 * file covers what the config cannot: that `Sidebar` actually draws the link
 * for a real office account, and that being ON that route does not swap the
 * office tree for gudang's. Those are two different failure modes and the
 * second one is the whole reason the route had to be declared shared.
 */
const mockPathname = vi.fn(() => '/dashboard');
vi.mock('next/navigation', () => ({
  usePathname: () => mockPathname(),
}));

/** A Manajer Pusat: `inventory.balance.read`, no location rows (central role). */
function signInAsOfficeManager() {
  useSessionStore.setState({
    accessToken: 'token',
    refreshToken: 'refresh',
    user: {
      id: 'u-mgr',
      username: 'manager_pusat',
      name: 'Gilang Handayani',
      roleKey: 'manager',
      permissions: ['dashboard.view', 'inventory.balance.read', 'delivery.read', 'purchasing.read'],
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

describe('Sidebar — Stok Gudang in the office', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    mockPathname.mockReturnValue('/dashboard');
  });

  it('draws the Stok Gudang link for an office manager on the dashboard', () => {
    signInAsOfficeManager();
    render(<Sidebar />);

    const link = screen.getByRole('link', { name: /Stok Gudang/i });
    expect(link).toHaveAttribute('href', '/warehouse/stock');
  });

  it('keeps the OFFICE sidebar once the office user is on that route', () => {
    // The failure this guards against: `/warehouse/*` is owned by the gudang
    // interface, so without the SHARED_ROUTES entry the sidebar would swap the
    // moment the link was followed — the office user would land on the stock
    // screen surrounded by gudang's tree, with no way back to Keuangan or
    // Persetujuan. Exactly the Pembelian bug, one interface over.
    signInAsOfficeManager();
    mockPathname.mockReturnValue('/warehouse/stock');
    render(<Sidebar />);

    // Office-only areas are still there...
    expect(screen.getByRole('link', { name: /Pembelian/i })).toBeInTheDocument();
    // ...and gudang's own work surfaces are not.
    expect(screen.queryByRole('link', { name: /Stock Opname|Opname/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Penerimaan/i })).not.toBeInTheDocument();
  });

  it('hides the link from someone without inventory.balance.read', () => {
    // HR Admin is the role the RBAC matrix denies it to, so the nav-level gate
    // has to hide it rather than offering a screen that renders "no access".
    useSessionStore.setState({
      accessToken: 'token',
      refreshToken: 'refresh',
      user: {
        id: 'u-hr',
        username: 'hr1',
        name: 'HR Satu',
        roleKey: 'hr_admin',
        permissions: ['hr.employee.read'],
        locations: [],
        employeeId: null,
        mustSetPin: false,
      },
    });
    render(<Sidebar />);

    expect(screen.queryByRole('link', { name: /Stok Gudang/i })).not.toBeInTheDocument();
  });
});
