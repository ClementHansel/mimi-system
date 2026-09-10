import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PurchaseOrdersPanel } from './PurchaseOrdersPanel';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';
import type { PurchaseOrderDetail, PurchaseOrderListRow } from './lib/types';
import type { PoPaymentState } from '@/lib/shared-types';

/**
 * FR-PO-01..04 — the draft -> pending_approval -> approved -> issued ->
 * partially_received/received -> closed ladder (plus cancel), and D-20's
 * price role lock: a `leader_outlet`-shaped session (has `purchasing.read`
 * + `purchasing.po.receive` but NOT `supplier.price.read`, per the
 * CONTRACTS §3 role matrix) must still be able to receive goods, just
 * without ever seeing unit price / line total / PO total on screen.
 */
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, get: vi.fn(), post: vi.fn() } };
});

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

function poRow(overrides: Partial<PurchaseOrderListRow> = {}): PurchaseOrderListRow {
  return {
    id: 'po-1',
    poNumber: 'PO-202608-00001',
    supplierId: 's1',
    supplierName: 'Supplier Ayam Segar',
    locationId: 'loc-1',
    status: 'issued',
    orderDate: '2026-08-10',
    expectedDate: '2026-08-15',
    total: '5000000.00',
    approval: null,
    paymentStatus: null,
    // Migration 268 — the aggregate the drawer actually renders. Default is a
    // wholly unpaid PO; the RLS-hidden case is `payment: null` and has its own
    // test, as does a PO with a DP against it.
    payment: {
      state: 'unpaid' as PoPaymentState,
      orderTotal: '5000000.00',
      paidTotal: '0.00',
      inFlightTotal: '0.00',
      outstanding: '5000000.00',
      advancePaid: '0.00',
      advanceUnapplied: '0.00',
    },
    ...overrides,
  };
}

function poDetail(overrides: Partial<PurchaseOrderDetail> = {}): PurchaseOrderDetail {
  return {
    ...poRow(),
    paymentTermsDays: 14,
    subtotal: '5000000.00',
    tax: '0.00',
    prId: null,
    cancelReason: null,
    notes: null,
    lines: [
      {
        id: 'l1',
        itemId: 'i1',
        itemName: 'Ayam Potong',
        unitCode: 'kg',
        qtyOrdered: '100.000',
        unitPrice: '50000.00',
        lineTotal: '5000000.00',
        qtyReceived: '0.000',
        qtyDifference: '100.000',
      },
    ],
    ...overrides,
  };
}

describe('PurchaseOrdersPanel — status ladder + D-20 price lock', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(api.get).mockReset();
    vi.mocked(api.post).mockReset();
  });

  it('shows the PO total column when supplier.price.read is granted', async () => {
    setPermissions(['purchasing.read', 'supplier.price.read', 'supplier.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);

    expect(await screen.findByText('PO-202608-00001')).toBeInTheDocument();
    expect(screen.getByText('Rp5.000.000')).toBeInTheDocument();
  });

  it('a leader_outlet-shaped session (po.receive, no supplier.price.read) never sees price, but CAN still open Terima Barang', async () => {
    setPermissions(['purchasing.read', 'purchasing.po.receive']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1')) return Promise.resolve(poDetail());
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations/'))
        return Promise.resolve([
          {
            id: 'area-1',
            locationId: 'loc-1',
            code: 'GD1',
            name: 'Gudang Kering',
            type: 'dry',
            isActive: true,
          },
        ]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);

    // No total column at all in the list.
    expect(await screen.findByText('PO-202608-00001')).toBeInTheDocument();
    expect(screen.queryByText('Rp5.000.000,00')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('PO-202608-00001'));

    // Drawer opened; unit price / line total never render, but the receive action is reachable.
    const receiveButton = await screen.findByRole('button', { name: 'Terima Barang' });
    expect(receiveButton).toBeInTheDocument();
    expect(screen.queryByText('Rp50.000,00')).not.toBeInTheDocument();
    expect(screen.queryByText('Rp5.000.000,00')).not.toBeInTheDocument();
  });

  it('issued -> receive posts the receipt and never exposes a price field in the receive form', async () => {
    setPermissions(['purchasing.read', 'purchasing.po.receive']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1')) return Promise.resolve(poDetail());
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations/'))
        return Promise.resolve([
          {
            id: 'area-1',
            locationId: 'loc-1',
            code: 'GD1',
            name: 'Gudang Kering',
            type: 'dry',
            isActive: true,
          },
        ]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });
    vi.mocked(api.post).mockResolvedValue(
      poDetail({
        status: 'received',
        lines: [
          {
            id: 'l1',
            itemId: 'i1',
            itemName: 'Ayam Potong',
            unitCode: 'kg',
            qtyOrdered: '100.000',
            unitPrice: '50000.00',
            lineTotal: '5000000.00',
            qtyReceived: '100.000',
            qtyDifference: '0.000',
          },
        ],
      }),
    );

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));
    fireEvent.click(await screen.findByRole('button', { name: 'Terima Barang' }));

    expect(await screen.findByText('Konfirmasi Penerimaan')).toBeInTheDocument();
    // No photo yet -> confirm stays disabled (FR-PO-04 wajib foto).
    expect(screen.getByRole('button', { name: 'Konfirmasi Penerimaan' })).toBeDisabled();
  });

  it('renders the approval chain timeline when the PO detail carries one, with currentStep null meaning the chain is complete', async () => {
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1')) {
        return Promise.resolve(
          poDetail({
            status: 'approved',
            approval: {
              approvalId: 'appr-1',
              state: 'approved',
              amount: '5000000.00',
              currentStep: null, // finalized — the documented completion signal, not an error.
              steps: [
                {
                  stepNo: 1,
                  approverRole: 'manager',
                  state: 'approved',
                  // `actedBy` is the approver's user ID; `actedByName` is the
                  // person the timeline shows. This fixture put the name in the
                  // ID field, which the API never does.
                  actedBy: '640218f4-cdbd-4d65-80ae-8b1c31ececc0',
                  actedByName: 'Manager Satu',
                  actedAt: '2026-08-11T00:00:00.000Z',
                  reason: null,
                  offlineAuthorized: false,
                  reverificationStatus: null,
                },
              ],
            },
          }),
        );
      }
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({
          rows: [poRow({ status: 'approved' })],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      if (path.startsWith('/locations/')) return Promise.resolve([]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    expect(await screen.findByText('Riwayat Persetujuan')).toBeInTheDocument();
    expect(screen.getByText('Manager Satu', { exact: false })).toBeInTheDocument();
  });

  it('a null payment summary (e.g. the kepala_gudang RLS gap) renders as "unavailable", never a crash or a misleading unpaid badge', async () => {
    // Was written against `paymentStatus`; migration 268 moved the drawer onto
    // the aggregate `payment` summary, and the invariant moved with it. The
    // point has never been the field name: a role that cannot SEE the vouchers
    // must not be shown a confident "Belum Dibayar" over an order that may be
    // fully settled.
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1'))
        return Promise.resolve(poDetail({ payment: null }));
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({
          rows: [poRow({ payment: null })],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      if (path.startsWith('/locations/')) return Promise.resolve([]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    expect(await screen.findByText('Status pembayaran belum tersedia')).toBeInTheDocument();
    expect(screen.queryByText('Belum Dibayar')).not.toBeInTheDocument();
  });

  it('a payment summary the server omits entirely does not take the drawer down', async () => {
    // A backend older than migration 268 sends no `payment` at all.
    // `undefined.state` would throw inside render, and an exception in a
    // drawer is the whole screen - the failure mode the app-level error
    // boundary exists for, and one that should not be reachable from a field
    // simply being absent.
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1')) {
        const withoutPayment: Record<string, unknown> = { ...poDetail() };
        delete withoutPayment.payment;
        return Promise.resolve(withoutPayment);
      }
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations/')) return Promise.resolve([]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    expect(await screen.findByText('Status pembayaran belum tersedia')).toBeInTheDocument();
  });

  it('a fully paid order reads Lunas', async () => {
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1'))
        return Promise.resolve(
          poDetail({
            payment: {
              state: 'paid' as PoPaymentState,
              orderTotal: '5000000.00',
              paidTotal: '5000000.00',
              inFlightTotal: '0.00',
              outstanding: '0.00',
              advancePaid: '0.00',
              advanceUnapplied: '0.00',
            },
          }),
        );
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations/')) return Promise.resolve([]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    expect(await screen.findByText('Lunas')).toBeInTheDocument();
    expect(screen.queryByText('Status pembayaran belum tersedia')).not.toBeInTheDocument();
  });

  it('a PO with a paid DP reads Dibayar Sebagian and shows what is still owed', async () => {
    // The case a single voucher status could not express at all: a settled DP
    // left the drawer reading "Dibayar" over an order 40% paid.
    setPermissions(['purchasing.read', 'purchasing.po.create', 'supplier.price.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1'))
        return Promise.resolve(
          poDetail({
            payment: {
              state: 'partial' as PoPaymentState,
              orderTotal: '5000000.00',
              paidTotal: '2000000.00',
              inFlightTotal: '0.00',
              outstanding: '3000000.00',
              advancePaid: '2000000.00',
              advanceUnapplied: '2000000.00',
            },
          }),
        );
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations/')) return Promise.resolve([]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    expect(await screen.findByText('Dibayar Sebagian')).toBeInTheDocument();
    expect(screen.getByText('Sisa Belum Dibayar')).toBeInTheDocument();
    // Money already out the door with nothing delivered against it.
    expect(screen.getByText('Uang Muka Belum Diperhitungkan')).toBeInTheDocument();
  });

  it('offers the DP action on an issued PO and posts the amount to the payments endpoint', async () => {
    setPermissions(['purchasing.read', 'purchasing.po.create', 'supplier.price.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1')) return Promise.resolve(poDetail());
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations/')) return Promise.resolve([]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });
    vi.mocked(api.post).mockResolvedValue(poDetail());

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    fireEvent.click(await screen.findByRole('button', { name: 'Catat Pembayaran / DP' }));
    // Nothing received yet, so the form must say so before the user commits:
    // this becomes uang muka, which needs the Owner at any amount, and that
    // is not something they can undo from here.
    expect(
      await screen.findByText(
        'Barang belum diterima, jadi ini dicatat sebagai UANG MUKA dan wajib disetujui Pemilik berapa pun nilainya.',
      ),
    ).toBeInTheDocument();

    // MoneyInput only commits on BLUR (it keeps a digits-only draft while
    // focused), so a bare `change` leaves the value null and the submit button
    // disabled - which is exactly how this test first failed.
    const amountInput = screen.getByLabelText(/Jumlah Dibayar/);
    fireEvent.focus(amountInput);
    fireEvent.change(amountInput, { target: { value: '2000000' } });
    fireEvent.blur(amountInput);
    fireEvent.click(screen.getByRole('button', { name: 'Ajukan' }));

    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        '/purchasing/orders/po-1/payments',
        expect.objectContaining({ amount: '2000000.00' }),
      ),
    );
  });

  it('hides the payment action once nothing is left to claim, so it cannot open a form that can only fail', async () => {
    setPermissions(['purchasing.read', 'purchasing.po.create', 'supplier.price.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1'))
        return Promise.resolve(
          poDetail({
            payment: {
              state: 'partial' as PoPaymentState,
              orderTotal: '5000000.00',
              paidTotal: '2000000.00',
              // The rest is already claimed by a voucher awaiting Finance.
              // Raising another would ask the business to pay the order twice.
              inFlightTotal: '3000000.00',
              outstanding: '3000000.00',
              advancePaid: '2000000.00',
              advanceUnapplied: '2000000.00',
            },
          }),
        );
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({ rows: [poRow()], total: 1, page: 1, pageSize: 25 });
      if (path.startsWith('/locations/')) return Promise.resolve([]);
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    expect(await screen.findByText('Dibayar Sebagian')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Catat Pembayaran / DP' })).not.toBeInTheDocument();
  });

  it('never renders Setujui/Tolak on a pending_approval PO without purchasing.po.approve', async () => {
    setPermissions(['purchasing.read']);
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/purchasing/orders/po-1'))
        return Promise.resolve(poDetail({ status: 'pending_approval' }));
      if (path.startsWith('/purchasing/orders?'))
        return Promise.resolve({
          rows: [poRow({ status: 'pending_approval' })],
          total: 1,
          page: 1,
          pageSize: 25,
        });
      return Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 25 });
    });

    render(<PurchaseOrdersPanel />);
    fireEvent.click(await screen.findByText('PO-202608-00001'));

    await waitFor(() =>
      expect(screen.getAllByText('Menunggu Persetujuan').length).toBeGreaterThan(0),
    );
    expect(screen.queryByRole('button', { name: 'Setujui' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tolak' })).not.toBeInTheDocument();
  });
});
