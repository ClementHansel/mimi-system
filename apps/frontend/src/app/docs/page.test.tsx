import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import DocsIndexPage from './page';
import { useSessionStore } from '@/stores/session-store';

/**
 * F-DOCS acceptance criterion: the manual list is grouped and filtered by
 * role, using the same `usePermissions()` gate as the rest of the app — a
 * kasir must never be handed the Keuangan/Kepala Gudang/Pemilik manuals, and
 * an owner (who holds every dashboard permission plus more) sees theirs.
 */
function setUser(permissions: string[], roleKey = 'kasir') {
  useSessionStore.setState({
    user: {
      id: 'u1', username: roleKey, name: 'Test User', roleKey,
      permissions, locations: [], employeeId: null, mustSetPin: false,
    },
  });
}

describe('DocsIndexPage — role-based filtering', () => {
  beforeEach(() => {
    useSessionStore.setState({ user: null });
  });

  it('shows only the Kasir manual to a user with just pos.catalog.read', () => {
    setUser(['pos.catalog.read'], 'kasir');
    render(<DocsIndexPage />);

    expect(screen.getByText('Panduan Kasir')).toBeInTheDocument();
    expect(screen.queryByText('Panduan Kepala Gudang')).not.toBeInTheDocument();
    expect(screen.queryByText('Panduan Keuangan')).not.toBeInTheDocument();
    expect(screen.queryByText('Panduan Driver')).not.toBeInTheDocument();
    expect(screen.queryByText('Panduan Supervisor Outlet')).not.toBeInTheDocument();
    expect(screen.queryByText('Panduan Pemilik / Manajer')).not.toBeInTheDocument();
  });

  it('shows only the Driver manual to a user with just delivery.drop.execute', () => {
    setUser(['delivery.drop.execute'], 'driver');
    render(<DocsIndexPage />);

    expect(screen.getByText('Panduan Driver')).toBeInTheDocument();
    expect(screen.queryByText('Panduan Kasir')).not.toBeInTheDocument();
  });

  it('shows every manual to a user with every gating permission (e.g. owner)', () => {
    setUser(
      [
        'pos.catalog.read',
        'replenishment.create', 'opname.create', 'waste.create', 'pettycash.create',
        'replenishment.approve.warehouse', 'delivery.read', 'purchasing.read',
        'delivery.drop.execute',
        'payment.read', 'accounting.journal.read',
        'dashboard.view',
      ],
      'owner',
    );
    render(<DocsIndexPage />);

    expect(screen.getByText('Panduan Kasir')).toBeInTheDocument();
    expect(screen.getByText('Panduan Supervisor Outlet')).toBeInTheDocument();
    expect(screen.getByText('Panduan Kepala Gudang')).toBeInTheDocument();
    expect(screen.getByText('Panduan Driver')).toBeInTheDocument();
    expect(screen.getByText('Panduan Keuangan')).toBeInTheDocument();
    expect(screen.getByText('Panduan Pemilik / Manajer')).toBeInTheDocument();
  });

  it('shows the empty state when the role has none of the gating permissions', () => {
    setUser([], 'hr_admin');
    render(<DocsIndexPage />);

    expect(screen.getByText('Belum ada manual untuk peran Anda')).toBeInTheDocument();
    expect(screen.queryByText('Panduan Kasir')).not.toBeInTheDocument();
  });
});
