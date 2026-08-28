import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PaymentPanel } from './PaymentPanel';
import { usePosCartStore } from './cart-store';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { OpenShift } from './shift-store';
import type { CartSummary } from '@mimi/shared';

const actor = { actorUserId: 'u1', actorRole: 'kasir', appVersion: 'test' };
const shift: OpenShift = {
  shiftId: 's1',
  locationId: 'loc1',
  openingCash: '100000.00',
  openedAt: new Date().toISOString(),
  kasirName: 'Kasir Satu',
  cashCollected: '0.00',
  grossSales: '0.00',
  salesCount: 0,
  voidCount: 0,
};
const emptySummary: CartSummary = { lines: [], subtotal: '0.00', discount: '0.00', total: '0.00' };

function makeRuntime(): LocalRuntime {
  return {
    commitSale: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as LocalRuntime;
}

/**
 * Honesty checks (the brief: "cash completes, QRIS settles, transfer stays
 * pending until Finance verifies and the UI must not imply otherwise"). This
 * is a pure rendering test — the cart is empty, so the submit path (which
 * would touch `runtime.commitSale`) is never exercised; it only asserts the
 * status badge/copy shown for each payment method never overstates finality.
 */
describe('PaymentPanel — payment status rendering', () => {
  beforeEach(() => usePosCartStore.getState().clear());

  it('shows cash as paid ("Dibayar")', () => {
    render(
      <PaymentPanel
        runtime={makeRuntime()}
        actor={actor}
        shift={shift}
        locationId="loc1"
        locationName="Outlet A"
        summary={emptySummary}
        channel="walk_in"
        onCompleted={() => {}}
      />,
    );
    expect(screen.getByText('Dibayar')).toBeInTheDocument();
  });

  it('shows QRIS as verified, never as fully paid', () => {
    render(
      <PaymentPanel
        runtime={makeRuntime()}
        actor={actor}
        shift={shift}
        locationId="loc1"
        locationName="Outlet A"
        summary={emptySummary}
        channel="walk_in"
        onCompleted={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('QRIS'));
    expect(screen.getByText('Terverifikasi')).toBeInTheDocument();
    expect(screen.queryByText('Dibayar')).not.toBeInTheDocument();
  });

  it('shows bank transfer as pending, with an explicit not-yet-verified note — never implying it is settled', () => {
    render(
      <PaymentPanel
        runtime={makeRuntime()}
        actor={actor}
        shift={shift}
        locationId="loc1"
        locationName="Outlet A"
        summary={emptySummary}
        channel="walk_in"
        onCompleted={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('Transfer'));
    expect(screen.getByText('Belum Terverifikasi')).toBeInTheDocument();
    expect(screen.getByText(/menunggu verifikasi Finance/i)).toBeInTheDocument();
    expect(screen.queryByText('Dibayar')).not.toBeInTheDocument();
    expect(screen.queryByText('Terverifikasi')).not.toBeInTheDocument();
  });

  it('disables the submit action while the cart is empty, regardless of payment method', () => {
    render(
      <PaymentPanel
        runtime={makeRuntime()}
        actor={actor}
        shift={shift}
        locationId="loc1"
        locationName="Outlet A"
        summary={emptySummary}
        channel="walk_in"
        onCompleted={() => {}}
      />,
    );
    expect(screen.getByText('Selesaikan & Cetak Struk').closest('button')).toBeDisabled();
  });
});

/**
 * F-POS-3 — "the choice must be visible on the payment screen" (owner) and
 * the committed sale FACT must carry `channel`, not just whatever the UI
 * happened to show (SYNC-PROTOCOL: an offline sale's channel must survive
 * to the sync envelope). These pin both halves down: the on-screen badge
 * text per channel, and the exact `data.channel` `runtime.commitSale` is
 * called with.
 */
describe('PaymentPanel — channel (F-POS-3)', () => {
  beforeEach(() => {
    usePosCartStore.getState().clear();
    usePosCartStore.setState({
      lines: [
        {
          productId: 'p1',
          productName: 'Ayam Goreng',
          unitPrice: '20000.00',
          qty: '1',
          discount: '0.00',
        },
      ],
    });
  });

  const summary: CartSummary = {
    lines: [{ productId: 'p1', lineTotal: '20000.00' }],
    subtotal: '20000.00',
    discount: '0.00',
    total: '20000.00',
  } as CartSummary;

  it('badges the active channel on screen — GoFood', () => {
    render(
      <PaymentPanel
        runtime={makeRuntime()}
        actor={actor}
        shift={shift}
        locationId="loc1"
        locationName="Outlet A"
        summary={summary}
        channel="gofood"
        onCompleted={() => {}}
      />,
    );
    expect(screen.getByText('Transaksi ini: GoFood')).toBeInTheDocument();
  });

  it('badges the active channel on screen — ShopeeFood', () => {
    render(
      <PaymentPanel
        runtime={makeRuntime()}
        actor={actor}
        shift={shift}
        locationId="loc1"
        locationName="Outlet A"
        summary={summary}
        channel="shopeefood"
        onCompleted={() => {}}
      />,
    );
    expect(screen.getByText('Transaksi ini: ShopeeFood')).toBeInTheDocument();
  });

  it('commits the sale fact with the active channel, not just showing it in the UI', async () => {
    const runtime = makeRuntime();
    render(
      <PaymentPanel
        runtime={runtime}
        actor={actor}
        shift={shift}
        locationId="loc1"
        locationName="Outlet A"
        summary={summary}
        channel="gofood"
        onCompleted={() => {}}
      />,
    );
    fireEvent.click(screen.getByText('QRIS')); // any method that doesn't need a cash amount typed first
    fireEvent.click(screen.getByText('Selesaikan & Cetak Struk'));

    await waitFor(() => expect(runtime.commitSale).toHaveBeenCalled());
    const call = (runtime.commitSale as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.channel).toBe('gofood');
  });
});
