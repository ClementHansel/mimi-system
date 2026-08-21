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

/** Every href that is an AREA inside the dashboard, never a hub card. */
const DASHBOARD_AREAS = [
  '/approvals',
  '/chat',
  '/delivery',
  '/purchasing',
  '/finance',
  '/hr',
  '/assets',
  '/admin',
  '/topology',
];

function hrefs(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('a[href]')).map((a) => a.getAttribute('href')!);
}

/**
 * The hub is a directory of the seven interfaces (owner's rulings,
 * 2026-08-21), and it is no longer owner-only: `employee` (`/me`) became an
 * interface of its own, so a Kasir has two places to be — the till and their
 * own account — and gets the same chooser the owner has. Only someone who can
 * reach a single interface is redirected past it.
 *
 * These tests use the REAL `lib/nav.ts` + `usePermissions` (no mock), so they
 * fail the moment the hub starts listing something that is not an interface
 * (the pre-rework hub listed all 14 nav routes) or drifts from `INTERFACES`.
 */
describe('HomePage (home hub — interface directory)', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    replace.mockClear();
  });

  it('gives an Owner all seven interfaces — and nothing that is a dashboard area', () => {
    setUser({
      roleKey: 'owner',
      permissions: [...PERMISSION_KEYS],
      name: 'Siti Rahma',
      locations: [
        { id: 'l1', code: 'LJN', name: 'Outlet Loa Janan', type: 'outlet', city: 'Samarinda' },
      ],
    });
    const { container } = render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();

    for (const [name, href] of [
      ['Dasbor', '/dashboard'],
      ['Kasir \\(POS\\)', '/pos'],
      ['Outlet', '/outlet'],
      ['Gudang Pusat', '/warehouse'],
      ['Pengiriman \\(Driver\\)', '/driver'],
      ['Akun Saya', '/me'],
      ['Dokumentasi', '/docs'],
    ] as const) {
      expect(screen.getByRole('link', { name: new RegExp(name) })).toHaveAttribute('href', href);
    }

    // Seven, exactly — the regression this rework fixes is EXTRA cards.
    expect(screen.getAllByRole('link')).toHaveLength(7);

    for (const href of DASHBOARD_AREAS) {
      expect(
        container.querySelector(`a[href="${href}"]`),
        `${href} is not an interface`,
      ).toBeNull();
    }

    expect(screen.getByText(/Halo, Siti/)).toBeInTheDocument();
    expect(screen.getByText(/Pemilik · Outlet Loa Janan/)).toBeInTheDocument();
  });

  it('gives a Kasir their three: the till, their own account, and the manual', () => {
    // The old contract redirected a Kasir straight past the hub. Once `/me`
    // became an interface, that stopped being right — they have somewhere else
    // to be than the till, so they get the chooser too.
    setUser({ roleKey: 'kasir', permissions: ['pos.catalog.read', 'payroll.slip.read.own'] });
    const { container } = render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();
    expect(hrefs(container).sort()).toEqual(['/docs', '/me', '/pos']);
  });

  it('gives a Driver their job list, their account, and the manual', () => {
    setUser({ roleKey: 'driver', permissions: ['delivery.drop.execute', 'payroll.slip.read.own'] });
    const { container } = render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();
    expect(hrefs(container).sort()).toEqual(['/docs', '/driver', '/me']);
  });

  it('gives a Kepala Gudang the warehouse plus the dashboard areas they hold', () => {
    setUser({
      roleKey: 'kepala_gudang',
      permissions: ['delivery.read', 'purchasing.read', 'asset.read', 'delivery.drop.execute'],
    });
    const { container } = render(<HomePage />);

    const links = hrefs(container);
    expect(links).toContain('/warehouse');
    // `delivery.read`/`purchasing.read`/`asset.read` are dashboard areas, so
    // the dashboard interface is reachable — as a card, not as nine cards.
    expect(links).toContain('/dashboard');
    expect(links).toContain('/me');
    for (const href of DASHBOARD_AREAS) {
      expect(container.querySelector(`a[href="${href}"]`)).toBeNull();
    }
  });

  it('still gives a user with no permissions their own account and the manual', () => {
    // Neither reading the manual nor opening your own payslip is privileged,
    // so even a misconfigured account is never left with a dead page.
    setUser({ roleKey: 'kasir', permissions: [] });
    const { container } = render(<HomePage />);

    expect(replace).not.toHaveBeenCalled();
    expect(hrefs(container).sort()).toEqual(['/docs', '/me']);
  });

  it('renders nothing before the session user is available', () => {
    const { container } = render(<HomePage />);
    expect(container).toBeEmptyDOMElement();
    expect(replace).not.toHaveBeenCalled();
  });
});
