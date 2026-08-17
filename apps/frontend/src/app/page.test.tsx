import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';
import { useSessionStore, type SessionUser } from '@/stores/session-store';

const replace = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace, push: vi.fn() }) }));

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
 * F-HUB-2 — the home hub is now a standalone WORKSPACE CHOOSER with exactly
 * 3 possible cards (Dasbor / Kasir / Dokumentasi), each gated live off
 * `lib/nav.ts` + `usePermissions` rather than a hand-listed permission set —
 * so this, like the F-BRAND version it replaces, uses the real `lib/nav.ts`
 * + `usePermissions` (no mock) and fails the moment the hub's gating drifts
 * from the sidebar's. The single-workspace auto-redirect is the new
 * security/UX-relevant behaviour under test: a typical Kasir must never see
 * a Dasbor card, and must never see a pointless one-card chooser either —
 * they land straight in POS.
 */
describe('HomePage (home hub — workspace chooser)', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    replace.mockClear();
  });

  it('sends a typical Kasir straight to /pos — no Dasbor card, no one-card chooser flash', () => {
    setUser({ roleKey: 'kasir', permissions: ['pos.catalog.read', 'payroll.slip.read.own'] });
    const { container } = render(<HomePage />);

    expect(replace).toHaveBeenCalledWith('/pos');
    // Redirect fires synchronously off render-computed state — nothing (no
    // Dasbor card, no chooser at all) should have painted first.
    expect(container).toBeEmptyDOMElement();
  });

  it('sends a single-workspace Dasbor role (no POS access) straight there too', () => {
    // Kepala Gudang: only warehouse access, no POS, no "Akun Saya" — Dasbor
    // is the only workspace, so this exercises the OTHER redirect branch.
    setUser({ roleKey: 'kepala_gudang', permissions: ['delivery.read'] });
    render(<HomePage />);
    expect(replace).toHaveBeenCalledWith('/warehouse');
  });

  it('gives an Owner (Dasbor AND Kasir both reachable) the full 3-card chooser, unredirected', () => {
    setUser({
      roleKey: 'owner',
      permissions: [
        'dashboard.view', 'pos.catalog.read', 'user.read', 'audit.read', 'settings.manage',
        'hr.employee.read', 'payment.read', 'delivery.read', 'purchasing.read',
        'payroll.slip.read.own', 'asset.read', 'topology.read',
      ],
      name: 'Siti Rahma',
      locations: [{ id: 'l1', code: 'LJN', name: 'Outlet Loa Janan', type: 'outlet', city: 'Samarinda' }],
    });
    render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();

    // Exactly 3 cards: Dasbor, Kasir (POS), Dokumentasi — nothing per
    // sidebar-destination anymore (that was the rejected F-BRAND model).
    expect(screen.getByRole('link', { name: /Dasbor/ })).toHaveAttribute('href', '/dashboard');
    expect(screen.getByRole('link', { name: /Kasir \(POS\)/ })).toHaveAttribute('href', '/pos');
    expect(screen.getByRole('link', { name: /Dokumentasi/ })).toHaveAttribute('href', '/docs');
    expect(screen.getAllByRole('link')).toHaveLength(3);

    // Greeting/role/outlet still shown, same as the previous hub.
    expect(screen.getByText(/Halo, Siti/)).toBeInTheDocument();
    expect(screen.getByText(/Pemilik · Outlet Loa Janan/)).toBeInTheDocument();
  });

  it('treats an empty locations array as "Semua Lokasi", not an error', () => {
    setUser({
      roleKey: 'owner',
      permissions: ['dashboard.view', 'pos.catalog.read'],
      locations: [],
    });
    render(<HomePage />);
    expect(screen.getByText(/Pemilik · Semua Lokasi/)).toBeInTheDocument();
  });

  it('always offers Dokumentasi, even for a zero-permission account with no other workspace', () => {
    setUser({ roleKey: 'kasir', permissions: [] });
    render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Dokumentasi/ })).toHaveAttribute('href', '/docs');
    expect(screen.getByText('Belum ada akses ke modul manapun')).toBeInTheDocument();
    expect(screen.queryByText('Dasbor')).not.toBeInTheDocument();
    expect(screen.queryByText('Kasir (POS)')).not.toBeInTheDocument();
  });

  it('renders nothing before the session user is available', () => {
    const { container } = render(<HomePage />);
    expect(container).toBeEmptyDOMElement();
    expect(replace).not.toHaveBeenCalled();
  });
});
