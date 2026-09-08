import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SjCreateForm } from './SjCreateForm';
import type { Replenishment, Driver, Vehicle } from './lib/types';

const frozenRequest: Replenishment = {
  id: 'req-frozen',
  requestNumber: 'REQ-001',
  locationId: 'loc-1',
  locationName: 'Outlet Kemang',
  status: 'approved',
  source: 'manual',
  requestedBy: 'Budi',
  submittedAt: '2026-08-01T00:00:00Z',
  neededBy: '2026-08-05',
  sjId: null,
  sjNumber: null,
  approval: null,
  lines: [
    {
      id: 'line-1',
      itemId: 'item-frozen',
      itemName: 'Ayam Fillet Beku',
      unitCode: 'kg',
      storageType: 'frozen',
      qtyRequested: '10.000',
      qtyApproved: '10.000',
      qtyShipped: null,
      qtyReceived: null,
      amendReason: null,
    },
  ],
};

const mixedRequest: Replenishment = {
  id: 'req-mixed',
  requestNumber: 'REQ-002',
  locationId: 'loc-2',
  locationName: 'Outlet Balikpapan Baru',
  status: 'approved',
  source: 'manual',
  requestedBy: 'Sari',
  submittedAt: '2026-08-01T00:00:00Z',
  neededBy: null,
  sjId: null,
  sjNumber: null,
  approval: null,
  lines: [
    {
      id: 'line-2',
      itemId: 'item-frozen-2',
      itemName: 'Ayam Mentah Berbumbu',
      unitCode: 'kg',
      storageType: 'frozen',
      qtyRequested: '5.000',
      qtyApproved: '5.000',
      qtyShipped: null,
      qtyReceived: null,
      amendReason: null,
    },
    {
      id: 'line-3',
      itemId: 'item-dry',
      itemName: 'Beras',
      unitCode: 'kg',
      storageType: 'dry',
      qtyRequested: '20.000',
      qtyApproved: '20.000',
      qtyShipped: null,
      qtyReceived: null,
      amendReason: null,
    },
  ],
};

const drivers: Driver[] = [
  { id: 'drv-1', name: 'Joko', phone: null, licenseNumber: null, userId: null, isActive: true },
];
const freezerVehicle: Vehicle = {
  id: 'veh-freezer',
  plateNumber: 'KT 1 ABC',
  type: 'box',
  hasFreezer: true,
  isActive: true,
};
const plainVehicle: Vehicle = {
  id: 'veh-plain',
  plateNumber: 'KT 2 XYZ',
  type: 'box',
  hasFreezer: false,
  isActive: true,
};
const vehicles: Vehicle[] = [freezerVehicle, plainVehicle];

describe('SjCreateForm — FR-LOG-02 frozen/dry split rule', () => {
  it('only counts frozen-compatible lines toward a request when shipmentType is frozen (the default)', () => {
    render(
      <SjCreateForm
        requests={[mixedRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={vi.fn()}
      />,
    );
    // The mixed request's card should show only 1 compatible item (the frozen one), not 2.
    expect(screen.getByText('1 item')).toBeInTheDocument();
    expect(screen.getByText(/1 baris tidak disertakan/i)).toBeInTheDocument();
  });

  it('never builds a drop containing both a frozen and a dry item for the same shipment', () => {
    const onSubmit = vi.fn();
    render(
      <SjCreateForm
        requests={[mixedRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={onSubmit}
      />,
    );

    fireEvent.click(screen.getByLabelText(/REQ-002/));
    // Route preview should list only the frozen item, never "Beras" (dry).
    expect(screen.getByText(/Ayam Mentah Berbumbu/)).toBeInTheDocument();
    expect(screen.queryByText(/Beras/)).not.toBeInTheDocument();
  });

  it('excludes a request entirely when it has zero lines compatible with the chosen shipment type', () => {
    const dryOnlyRequest: Replenishment = {
      ...mixedRequest,
      id: 'req-dry-only',
      requestNumber: 'REQ-003',
      lines: [mixedRequest.lines[1]!],
    };
    render(
      <SjCreateForm
        requests={[dryOnlyRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={vi.fn()}
      />,
    );
    // Default shipmentType is 'frozen'; a dry-only request has no compatible lines.
    const checkbox = screen.getByLabelText(/REQ-003/) as HTMLInputElement;
    expect(checkbox).toBeDisabled();
    expect(screen.getByText(/Tidak ada barang yang cocok/i)).toBeInTheDocument();
  });

  it('switches which requests are selectable when the shipment type toggles to dry', () => {
    render(
      <SjCreateForm
        requests={[frozenRequest, mixedRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Kering/i }));

    // The pure-frozen request now has zero compatible lines -> disabled.
    const frozenCheckbox = screen.getByLabelText(/REQ-001/) as HTMLInputElement;
    expect(frozenCheckbox).toBeDisabled();

    // The mixed request now has 1 compatible (dry) line.
    fireEvent.click(screen.getByLabelText(/REQ-002/));
    expect(screen.getByText(/Beras/)).toBeInTheDocument();
    expect(screen.queryByText(/Ayam Mentah Berbumbu/)).not.toBeInTheDocument();
  });

  it('blocks submission when the selected vehicle has no freezer for a frozen shipment', () => {
    render(
      <SjCreateForm
        requests={[frozenRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByLabelText(/REQ-001/));

    const selects = screen.getAllByRole('combobox');
    const driverSelect = selects[0]!;
    const vehicleSelect = selects[1]!;
    fireEvent.change(driverSelect, { target: { value: 'drv-1' } });
    fireEvent.change(vehicleSelect, { target: { value: 'veh-plain' } });

    expect(screen.getByText(/tidak punya freezer/i)).toBeInTheDocument();
    const createBtn = screen.getByRole('button', { name: /Buat Surat Jalan/i });
    expect(createBtn).toBeDisabled();
  });

  it('enables submission once request, driver, freezer-capable vehicle and date are all set', () => {
    const onSubmit = vi.fn();
    render(
      <SjCreateForm
        requests={[frozenRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.click(screen.getByLabelText(/REQ-001/));

    const selects = screen.getAllByRole('combobox');
    fireEvent.change(selects[0]!, { target: { value: 'drv-1' } });
    fireEvent.change(selects[1]!, { target: { value: 'veh-freezer' } });

    const dateInputs = screen.getAllByDisplayValue('');
    const dateInput = dateInputs.find((el) => (el as HTMLInputElement).type === 'date')!;
    fireEvent.change(dateInput, { target: { value: '2026-08-20' } });

    const createBtn = screen.getByRole('button', { name: /Buat Surat Jalan/i });
    expect(createBtn).not.toBeDisabled();
    fireEvent.click(createBtn);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    const payload = onSubmit.mock.calls[0]![0];
    expect(payload.shipmentType).toBe('frozen');
    expect(payload.drops).toHaveLength(1);
    expect(payload.drops[0].lines).toHaveLength(1);
    expect(payload.drops[0].lines[0].itemId).toBe('item-frozen');
  });
});

/**
 * `docs/FUNCTIONAL-TEST-2026-09-07.md` §2d — "the create button cannot submit
 * and does not say why". The button has always carried `disabled={!canSubmit}`;
 * what was missing is the sentence naming the piece that is not filled in. With
 * three of four prerequisites done, a greyed-out button is indistinguishable
 * from a broken one, and that is what stopped a dispatcher (and the simulation)
 * from getting a Surat Jalan out of this form.
 */
describe('SjCreateForm — a disabled create button says what is missing', () => {
  it('names every unmet prerequisite, and clears them off the list as they are met', () => {
    const onSubmit = vi.fn();
    render(
      <SjCreateForm
        requests={[frozenRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={onSubmit}
      />,
    );

    const create = screen.getByRole('button', { name: 'Buat Surat Jalan' });
    expect(create).toBeDisabled();
    // Nothing chosen yet: all four, in the order they appear on the form.
    expect(screen.getByText(/pilih minimal satu permintaan/)).toBeInTheDocument();
    expect(screen.getByText(/pilih driver/)).toBeInTheDocument();
    expect(screen.getByText(/pilih kendaraan/)).toBeInTheDocument();
    expect(screen.getByText(/isi tanggal rencana kirim/)).toBeInTheDocument();

    // Ticking the request takes exactly that reason away and leaves the rest.
    fireEvent.click(screen.getByLabelText(/REQ-001/));
    expect(screen.queryByText(/pilih minimal satu permintaan/)).not.toBeInTheDocument();
    expect(screen.getByText(/pilih driver/)).toBeInTheDocument();
    expect(create).toBeDisabled();
  });

  it('asks for a freezer truck by name once a non-freezer vehicle is chosen for a frozen run', () => {
    render(
      <SjCreateForm
        requests={[frozenRequest]}
        drivers={drivers}
        vehicles={vehicles}
        onSubmit={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByLabelText(/REQ-001/));
    fireEvent.change(screen.getByLabelText('Driver'), { target: { value: 'drv-1' } });
    fireEvent.change(screen.getByLabelText('Kendaraan'), { target: { value: 'veh-plain' } });
    fireEvent.change(screen.getByLabelText('Tanggal Rencana Kirim'), {
      target: { value: '2026-09-10' },
    });

    // "pick a vehicle" is satisfied; the freezer rule is what is left.
    expect(screen.getByText(/pilih kendaraan berfreezer/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buat Surat Jalan' })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Kendaraan'), { target: { value: 'veh-freezer' } });
    expect(screen.queryByText(/Lengkapi dulu/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Buat Surat Jalan' })).toBeEnabled();
  });
});
