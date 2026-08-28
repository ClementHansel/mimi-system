import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DeliveryShell } from './DeliveryShell';
import { useSessionStore } from '@/stores/session-store';

/**
 * "Penugasan Pengiriman" (`/delivery/assign`) used to be its own sidebar
 * entry. Owner, 2026-08-27: "this should be displayed as a tab inside
 * pengiriman (dispatcher)" — folded into `DeliveryShell` as a third,
 * independently permission-gated tab (`delivery.sj.create`, same key the
 * standalone route used), same shape as `AdminShell`'s tabs. (A fourth tab,
 * "Rekap Harian", joined afterward on the same ruling — untested here since
 * these tests predate it; not this file's concern beyond mocking it out so
 * it doesn't drag in `RecapPanel`'s own dependencies.)
 *
 * The point of these tests is the TAB GATING, not the content of any one
 * tab — the list/live/assign panels are mocked out so a failure here can
 * only mean the shell showed (or hid) the wrong tab for a given permission
 * set, not that some unrelated panel broke.
 */
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn(), push: vi.fn() }) }));
vi.mock('./DeliverySuratJalanList', () => ({
  DeliverySuratJalanList: () => <div data-testid="panel-list" />,
}));
vi.mock('./LiveTrackingPanel', () => ({
  LiveTrackingPanel: () => <div data-testid="panel-live" />,
}));
vi.mock('./DispatchAssignScreen', () => ({
  DispatchAssignScreen: () => <div data-testid="panel-assign" />,
}));
vi.mock('@/components/warehouse/RecapPanel', () => ({
  RecapPanel: () => <div data-testid="panel-rekap" />,
}));

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

describe('DeliveryShell', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
  });

  it('shows only the list tab for a permission set without delivery.sj.create', () => {
    setPermissions(['delivery.read']);
    render(<DeliveryShell />);

    expect(screen.getByRole('tab', { name: /Pengiriman/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pantau Truk/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /Penugasan/i })).not.toBeInTheDocument();
    expect(screen.getByTestId('panel-list')).toBeInTheDocument();
  });

  it('shows the Penugasan tab for delivery.sj.create and mounts DispatchAssignScreen when selected', () => {
    setPermissions(['delivery.read', 'delivery.sj.create']);
    render(<DeliveryShell />);

    const assignTab = screen.getByRole('tab', { name: /Penugasan/i });
    expect(assignTab).toBeInTheDocument();
    expect(screen.queryByTestId('panel-assign')).not.toBeInTheDocument();

    fireEvent.click(assignTab);

    expect(screen.getByTestId('panel-assign')).toBeInTheDocument();
    expect(screen.queryByTestId('panel-list')).not.toBeInTheDocument();
  });

  it('opens directly on the Penugasan tab when initialTab="assign" and the permission is held', () => {
    setPermissions(['delivery.read', 'delivery.sj.create']);
    render(<DeliveryShell initialTab="assign" />);

    expect(screen.getByRole('tab', { name: /Penugasan/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('panel-assign')).toBeInTheDocument();
  });

  it('falls back to the list tab when initialTab="assign" is requested without the permission', () => {
    setPermissions(['delivery.read']);
    render(<DeliveryShell initialTab="assign" />);

    expect(screen.queryByRole('tab', { name: /Penugasan/i })).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Pengiriman/i })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByTestId('panel-list')).toBeInTheDocument();
  });
});
