import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ConflictDetailDrawer } from './ConflictDetailDrawer';
import { useSessionStore } from '@/stores/session-store';
import type { SyncConflictRow } from './lib/types';

const dismiss = vi.fn();
vi.mock('./lib/topology-api', () => ({
  dismissSyncConflict: (...args: unknown[]) => dismiss(...args),
}));

function row(overrides: Partial<SyncConflictRow> = {}): SyncConflictRow {
  return {
    id: 'c1',
    kind: 'negative_balance',
    queue: 'conflict',
    entity: 'stock_movements',
    entityId: 'e1',
    locationId: null,
    winnerEventId: 'w1',
    loserEventId: 'l1',
    detail: { note: 'balance went below zero' },
    physicalEffectSuspected: false,
    status: 'open',
    createdAt: '2026-08-20T02:00:00.000Z',
    resolveInUrl: '/warehouse',
    ...overrides,
  };
}

function signIn(permissions: string[]) {
  useSessionStore.setState({
    accessToken: 'token',
    refreshToken: 'refresh',
    user: {
      id: 'u1',
      username: 'owner',
      name: 'Owner',
      roleKey: 'owner',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

/**
 * The drawer's job is to offer the action that FITS the row.
 *
 * `double_count`, `duplicate_receipt` and `decision_race` are refused by the
 * server (`ERR_RESOLVE_IN_DOMAIN`) because only a recount or a re-decision in
 * the owning document can settle them. Rendering a dismiss button for those
 * would train people to expect a failure, so these tests pin the split rather
 * than the styling.
 */
describe('ConflictDetailDrawer', () => {
  beforeEach(() => {
    dismiss.mockReset().mockResolvedValue(undefined);
    signIn(['topology.read', 'sync.status.read', 'sync.conflict.resolve']);
  });

  it('offers dismissal with a mandatory reason for an engine-settled race', () => {
    render(<ConflictDetailDrawer conflict={row()} onClose={() => {}} onResolved={() => {}} />);

    const button = screen.getByRole('button', { name: /Tutup Konflik/ });
    // Disabled until a reason exists — the server requires one, so the UI must
    // not let someone click into a rejection.
    expect(button).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/Alasan Menutup/), {
      target: { value: 'event pemenang sudah benar' },
    });
    expect(button).toBeEnabled();
  });

  it('sends the typed reason to the API', async () => {
    const onResolved = vi.fn();
    render(<ConflictDetailDrawer conflict={row()} onClose={() => {}} onResolved={onResolved} />);

    fireEvent.change(screen.getByLabelText(/Alasan Menutup/), {
      target: { value: 'sudah dicek manual' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Tutup Konflik/ }));

    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('c1', 'sudah dicek manual'));
    await waitFor(() => expect(onResolved).toHaveBeenCalled());
  });

  it('never offers dismissal for a conflict the server resolves in its own domain', () => {
    for (const kind of ['double_count', 'duplicate_receipt', 'decision_race']) {
      const { unmount } = render(
        <ConflictDetailDrawer conflict={row({ kind })} onClose={() => {}} onResolved={() => {}} />,
      );
      expect(
        screen.queryByRole('button', { name: /Tutup Konflik/ }),
        `${kind} must not offer dismissal`,
      ).toBeNull();
      // ...and it says where to go instead, rather than leaving a dead end.
      expect(screen.getByRole('link', { name: /Buka Dokumen Terkait/ })).toHaveAttribute(
        'href',
        '/warehouse',
      );
      unmount();
    }
  });

  it('hides the dismiss form from a user without sync.conflict.resolve', () => {
    signIn(['topology.read', 'sync.status.read']);
    render(<ConflictDetailDrawer conflict={row()} onClose={() => {}} onResolved={() => {}} />);

    expect(screen.queryByRole('button', { name: /Tutup Konflik/ })).toBeNull();
    // The detail itself stays readable — seeing the queue is a different
    // permission from acting on it.
    expect(screen.getByText(/Stok jadi minus/)).toBeInTheDocument();
  });

  it('flags a suspected physical effect, because that changes the urgency', () => {
    render(
      <ConflictDetailDrawer
        conflict={row({ physicalEffectSuspected: true })}
        onClose={() => {}}
        onResolved={() => {}}
      />,
    );
    expect(screen.getByText(/Diduga sudah ada dampak fisik/)).toBeInTheDocument();
  });
});
