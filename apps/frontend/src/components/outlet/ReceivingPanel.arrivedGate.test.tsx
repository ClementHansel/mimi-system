import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { ReceivingPanel } from './ReceivingPanel';
import * as outletApi from './lib/outlet-api';

/**
 * A DROP CANNOT BE RECEIVED BEFORE THE DRIVER SAYS IT ARRIVED.
 *
 * MA-199, and the reported symptom understates it. The screen listed drops at
 * `pending` and `en_route` alongside `arrived` and made every card clickable, so
 * a Supervisor Cabang could open "Terima Barang" for a Surat Jalan still at
 * *siap kirim* — goods still in the warehouse.
 *
 * Receiving commits through the offline outbox
 * (`LocalRuntime.commitDropReceived`), not the REST endpoint, so nothing
 * refused it in the browser: the outlet filled in the mandatory photo, the
 * signature and the per-line quantities, and got a green "queued" toast. On the
 * server `applyReceive` returned `wrong_status` — it gates on `arrived` in both
 * `strict` and `fact` mode — and the projector treated `wrong_status` as an
 * expected idempotent replay and returned without logging. The receipt was
 * accepted by the UI and then discarded in silence: no stock movement, no
 * error, nothing in any log.
 *
 * So the guarantee under test is not "the button is disabled". It is that a
 * receipt which the server will refuse can never be composed in the first
 * place, because the alternative is an outlet that believes it has booked in
 * stock the books have never heard of.
 */
vi.mock('./lib/outlet-api', () => ({
  listIncomingSuratJalan: vi.fn(),
  getStorageAreas: vi.fn().mockResolvedValue([]),
}));

vi.mock('./lib/outlet-location-context', () => ({
  useOutletLocationContext: () => ({ locationId: 'loc-1', locationName: 'Outlet Satu' }),
}));

function sjWithDrop(dropStatus: string) {
  return {
    rows: [
      {
        id: 'sj-1',
        sjNumber: 'SJ/202609/0001',
        status: dropStatus === 'arrived' ? 'in_transit' : 'ready',
        shipmentType: 'dry',
        plannedDate: '2026-09-10',
        driver: { id: 'drv-1', name: 'Ayu Rahayu' },
        vehicle: { id: 'veh-1', plateNumber: 'KT 1 ABC', hasFreezer: false },
        drops: [
          {
            id: 'drop-1',
            dropSeq: 1,
            locationId: 'loc-1',
            locationName: 'Outlet Satu',
            city: 'Balikpapan',
            status: dropStatus,
            arrivedAt: dropStatus === 'arrived' ? '2026-09-10T02:00:00Z' : null,
            receivedBy: null,
            receivedAt: null,
            discrepancyNotes: null,
            lines: [
              {
                id: 'line-1',
                itemId: 'item-1',
                itemName: 'Air Mineral Botol',
                unitCode: 'pack',
                storageType: 'dry',
                qty: '3.000',
                qtyReceived: null,
                receivedStorageAreaId: null,
                discrepancyReason: null,
              },
            ],
          },
        ],
      },
    ],
    total: 1,
    page: 1,
    pageSize: 25,
  };
}

describe('ReceivingPanel — receiving is gated on the drop having arrived', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does NOT open the receive form for a drop still pending on a siap-kirim Surat Jalan', async () => {
    vi.mocked(outletApi.listIncomingSuratJalan).mockResolvedValue(sjWithDrop('pending') as never);

    render(<ReceivingPanel />);
    const card = await waitFor(() => screen.getByText('SJ/202609/0001'));

    // Still LISTED — the outlet should see what is coming.
    expect(card).toBeInTheDocument();
    // …and told why it cannot be received.
    expect(screen.getByText(/driver belum menandai tiba/i)).toBeInTheDocument();

    fireEvent.click(card);

    // No form. Before MA-199 this opened the full receiving dialog and the
    // resulting receipt was silently thrown away by the server.
    expect(
      screen.queryByRole('dialog'),
      'the receive form opened for goods still in the warehouse',
    ).not.toBeInTheDocument();
  });

  it('does not open it for a drop en route either', async () => {
    vi.mocked(outletApi.listIncomingSuratJalan).mockResolvedValue(sjWithDrop('en_route') as never);

    render(<ReceivingPanel />);
    const card = await waitFor(() => screen.getByText('SJ/202609/0001'));
    fireEvent.click(card);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('DOES open it once the driver has marked the drop arrived', async () => {
    vi.mocked(outletApi.listIncomingSuratJalan).mockResolvedValue(sjWithDrop('arrived') as never);

    render(<ReceivingPanel />);
    const card = await waitFor(() => screen.getByText('SJ/202609/0001'));

    // No "not arrived" note on a drop that has.
    expect(screen.queryByText(/driver belum menandai tiba/i)).not.toBeInTheDocument();

    fireEvent.click(card);
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });
});
