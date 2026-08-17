import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PaymentPanel } from './PaymentPanel';
import { usePosCartStore } from './cart-store';
import type { LocalRuntime } from '@/lib/local/api/local-runtime';
import type { OpenShift } from './shift-store';
import type { CartSummary } from '@mimi/shared';

const runtime = {} as unknown as LocalRuntime;
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
    render(<PaymentPanel runtime={runtime} actor={actor} shift={shift} locationId="loc1" locationName="Outlet A" summary={emptySummary} onCompleted={() => {}} />);
    expect(screen.getByText('Dibayar')).toBeInTheDocument();
  });

  it('shows QRIS as verified, never as fully paid', () => {
    render(<PaymentPanel runtime={runtime} actor={actor} shift={shift} locationId="loc1" locationName="Outlet A" summary={emptySummary} onCompleted={() => {}} />);
    fireEvent.click(screen.getByText('QRIS'));
    expect(screen.getByText('Terverifikasi')).toBeInTheDocument();
    expect(screen.queryByText('Dibayar')).not.toBeInTheDocument();
  });

  it('shows bank transfer as pending, with an explicit not-yet-verified note — never implying it is settled', () => {
    render(<PaymentPanel runtime={runtime} actor={actor} shift={shift} locationId="loc1" locationName="Outlet A" summary={emptySummary} onCompleted={() => {}} />);
    fireEvent.click(screen.getByText('Transfer'));
    expect(screen.getByText('Belum Terverifikasi')).toBeInTheDocument();
    expect(screen.getByText(/menunggu verifikasi Finance/i)).toBeInTheDocument();
    expect(screen.queryByText('Dibayar')).not.toBeInTheDocument();
    expect(screen.queryByText('Terverifikasi')).not.toBeInTheDocument();
  });

  it('disables the submit action while the cart is empty, regardless of payment method', () => {
    render(<PaymentPanel runtime={runtime} actor={actor} shift={shift} locationId="loc1" locationName="Outlet A" summary={emptySummary} onCompleted={() => {}} />);
    expect(screen.getByText('Selesaikan & Cetak Struk').closest('button')).toBeDisabled();
  });
});
