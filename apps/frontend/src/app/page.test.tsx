import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';
import { useSessionStore, type SessionUser } from '@/stores/session-store';

function setUser(overrides: Partial<SessionUser>) {
  useSessionStore.setState({
    accessToken: 'token',
    refreshToken: 'refresh',
    user: {
      id: 'u1',
      username: 'user01',
      name: 'Budi Santoso',
      roleKey: 'kasir',
      permissions: [],
      locations: [],
      employeeId: null,
      mustSetPin: false,
      ...overrides,
    },
  });
}

/**
 * F-BRAND — the home hub is the one place every role lands after login, so
 * its permission gating IS the security-relevant behaviour under test here
 * (a hidden card is only a UX nicety; the real RBAC boundary is still the
 * server, per `usePermissions`'s own doc comment — but a cashier seeing an
 * Admin/HR/Finance card at all would be a bad UX regression worth a test).
 * Uses real `lib/nav.ts` + `usePermissions` rather than a mock, so this
 * fails the moment the hub's filtering drifts from the sidebar's.
 */
describe('HomePage (home hub)', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
  });

  it('shows a Kasir essentially one enormous POS target — no back-office destinations', () => {
    setUser({
      roleKey: 'kasir',
      permissions: ['pos.catalog.read', 'payroll.slip.read.own'],
    });
    render(<HomePage />);

    // POS is the role's landing route -> promoted to the hero card.
    expect(screen.getByText('Kasir (POS)')).toBeInTheDocument();
    // Only "Akun Saya" remains as a secondary card.
    expect(screen.getByText('Akun Saya')).toBeInTheDocument();

    // Admin/HR/Finance/Warehouse/Purchasing/Topology must NOT be reachable.
    expect(screen.queryByText('Administrasi')).not.toBeInTheDocument();
    expect(screen.queryByText('SDM & Absensi')).not.toBeInTheDocument();
    expect(screen.queryByText('Keuangan')).not.toBeInTheDocument();
    expect(screen.queryByText('Gudang Pusat')).not.toBeInTheDocument();
    expect(screen.queryByText('Pembelian')).not.toBeInTheDocument();
    expect(screen.queryByText('Topologi Perangkat')).not.toBeInTheDocument();
    expect(screen.queryByText('Persetujuan Saya')).not.toBeInTheDocument();
  });

  it("links the Kasir's hero card straight to /pos", () => {
    setUser({ roleKey: 'kasir', permissions: ['pos.catalog.read', 'payroll.slip.read.own'] });
    render(<HomePage />);
    expect(screen.getByRole('link', { name: /Kasir \(POS\)/ })).toHaveAttribute('href', '/pos');
  });

  it('gives an Owner the full set, with Dasbor as the primary hero', () => {
    setUser({
      roleKey: 'owner',
      permissions: [
        'dashboard.view', 'pos.catalog.read', 'user.read', 'audit.read', 'settings.manage',
        'hr.employee.read', 'payment.read', 'delivery.read', 'purchasing.read',
        'payroll.slip.read.own', 'asset.read', 'topology.read',
        'replenishment.approve.supervisor', 'opname.approve', 'return.approve',
        'purchasing.pr.approve', 'purchasing.po.approve', 'pos.void.approve',
        'payroll.run.approve', 'payroll.loan.approve', 'hr.leave.approve', 'payment.verify',
      ],
    });
    render(<HomePage />);

    // Dashboard is Owner's landing route -> hero, so it shouldn't also
    // appear a second time as a secondary card.
    const dashboardMatches = screen.getAllByText('Dasbor');
    expect(dashboardMatches).toHaveLength(1);

    expect(screen.getByText('Administrasi')).toBeInTheDocument();
    expect(screen.getByText('SDM & Absensi')).toBeInTheDocument();
    expect(screen.getByText('Persetujuan Saya')).toBeInTheDocument();
  });

  it('shows the signed-in user, role, and outlet', () => {
    setUser({
      name: 'Siti Rahma',
      roleKey: 'kasir',
      permissions: ['pos.catalog.read', 'payroll.slip.read.own'],
      locations: [{ id: 'l1', code: 'LJN', name: 'Outlet Loa Janan', type: 'outlet', city: 'Samarinda' }],
    });
    render(<HomePage />);

    expect(screen.getByText(/Halo, Siti/)).toBeInTheDocument();
    expect(screen.getByText(/Kasir · Outlet Loa Janan/)).toBeInTheDocument();
  });

  it('renders nothing before the session user is available', () => {
    const { container } = render(<HomePage />);
    expect(container).toBeEmptyDOMElement();
  });
});
