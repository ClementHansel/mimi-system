import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import HomePage from './page';
import { useSessionStore, type SessionUser } from '@/stores/session-store';
import { PERMISSION_KEYS } from '@mimi/shared';

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
 * The hub is now an INTERFACE DIRECTORY for the all-access roles only (owner's
 * ruling, 2026-08-18): owner and superadmin see one card per unique interface;
 * every other role is redirected past this page to its own surface.
 *
 * Like the chooser it replaces, these tests use the REAL `lib/nav.ts` +
 * `usePermissions` (no mock), so they fail the moment the hub's gating drifts
 * from the sidebar's — which is the whole point of deriving the cards from the
 * nav config rather than hand-listing them here.
 */
describe('HomePage (home hub — interface directory)', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    replace.mockClear();
  });

  it('sends a Kasir straight to /pos — the hub is not theirs to see', () => {
    setUser({ roleKey: 'kasir', permissions: ['pos.catalog.read', 'payroll.slip.read.own'] });
    const { container } = render(<HomePage />);

    expect(replace).toHaveBeenCalledWith('/pos');
    // The redirect is computed during render, so nothing should paint first.
    expect(container).toBeEmptyDOMElement();
  });

  it('sends a Kepala Gudang to /warehouse even though several surfaces are permitted', () => {
    // The OLD hub kept a multi-workspace role here on a chooser. That is
    // exactly the behaviour the owner rejected: only owner/superadmin get a
    // directory, everyone else goes to work.
    setUser({
      roleKey: 'kepala_gudang',
      permissions: ['delivery.read', 'purchasing.read', 'asset.read', 'delivery.drop.execute'],
    });
    const { container } = render(<HomePage />);

    expect(replace).toHaveBeenCalledWith('/warehouse');
    expect(container).toBeEmptyDOMElement();
  });

  it('sends a Driver to their own job list, not the hub', () => {
    setUser({ roleKey: 'driver', permissions: ['delivery.drop.execute', 'payroll.slip.read.own'] });
    render(<HomePage />);
    expect(replace).toHaveBeenCalledWith('/driver');
  });

  it('gives an Owner a card per unique interface, including /outlet and /driver', () => {
    // Owner now holds every permission that gates a nav entry (migration 222 +
    // the rbac.ts grants) — the two that were missing are asserted by name
    // below, because their absence is the exact bug this work fixed.
    setUser({
      roleKey: 'owner',
      permissions: [...PERMISSION_KEYS],
      name: 'Siti Rahma',
      locations: [
        { id: 'l1', code: 'LJN', name: 'Outlet Loa Janan', type: 'outlet', city: 'Samarinda' },
      ],
    });
    render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();

    for (const [name, href] of [
      ['Dasbor', '/dashboard'],
      ['Kasir (POS)', '/pos'],
      ['Outlet', '/outlet'],
      ['Pengiriman (Driver)', '/driver'],
      ['Pengiriman (Dispatcher)', '/delivery'],
      ['Gudang Pusat', '/warehouse'],
      ['Administrasi', '/admin'],
      ['Dokumentasi', '/docs'],
    ] as const) {
      expect(
        screen.getByRole('link', { name: new RegExp(name.replace(/[()]/g, '\\$&')) }),
      ).toHaveAttribute('href', href);
    }

    // Every nav surface plus Dokumentasi — asserted as "more than the old
    // three" rather than a brittle exact count that any new surface breaks.
    expect(screen.getAllByRole('link').length).toBeGreaterThan(10);

    expect(screen.getByText(/Halo, Siti/)).toBeInTheDocument();
    expect(screen.getByText(/Pemilik · Outlet Loa Janan/)).toBeInTheDocument();
  });

  it('gives a Super Admin the same full directory', () => {
    setUser({ roleKey: 'superadmin', permissions: [...PERMISSION_KEYS], name: 'Super Admin' });
    render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: /Pengiriman \(Driver\)/ })).toHaveAttribute(
      'href',
      '/driver',
    );
    expect(screen.getByText(/Super Admin · Semua Lokasi/)).toBeInTheDocument();
  });

  it('treats an empty locations array as "Semua Lokasi", not an error', () => {
    setUser({ roleKey: 'owner', permissions: [...PERMISSION_KEYS], locations: [] });
    render(<HomePage />);
    expect(screen.getByText(/Pemilik · Semua Lokasi/)).toBeInTheDocument();
  });

  it('shows an owner with no permissions the empty state, still offering Dokumentasi', () => {
    // Not a real configuration, but the hub must degrade to something
    // legible rather than a page of empty section headings.
    setUser({ roleKey: 'owner', permissions: [] });
    render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText('Belum ada akses ke modul manapun')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Dokumentasi/ })).toHaveAttribute('href', '/docs');
    expect(screen.queryByRole('link', { name: /Dasbor/ })).not.toBeInTheDocument();
  });

  it('renders nothing before the session user is available', () => {
    const { container } = render(<HomePage />);
    expect(container).toBeEmptyDOMElement();
    expect(replace).not.toHaveBeenCalled();
  });
});
