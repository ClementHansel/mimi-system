import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSessionStore } from '@/stores/session-store';
import { api } from '@/lib/api';
import { StockPanel } from './StockPanel';
import { StockOpnamePanel } from './StockOpnamePanel';
import { WastePanel } from './WastePanel';

/**
 * FIX-LOADS #1/#2 — a company-wide role with no `warehouse`-type location
 * (Owner: `locations: []`, same shape that broke POS) hit either a misleading
 * "Gagal memuat data" (StockPanel/StockOpnamePanel, which reads as "the request
 * failed" when no request was ever attempted) or nothing rendered at all
 * (WastePanel's old `return null` — worse than an empty state). All three
 * render one honest message instead.
 *
 * WHY THIS TEST NOW AWAITS, AND WHY THE API IS MOCKED (2026-08-25):
 *
 * `useWarehouseLocation` used to read the warehouse out of `Me.locations` and
 * stop there. That made the empty state instant — and it also made the entire
 * warehouse section unreachable for owner, superadmin, manager and finance,
 * because central roles legitimately have `locations: []` (RLS scopes them
 * instead of location rows). "No location rows" and "no access" are different
 * facts and the hook conflated them.
 *
 * It now asks the API which warehouse to use when the session does not name
 * one. So the empty state is no longer synchronous: there is a lookup first,
 * and these tests have to let it resolve. Mocking `api.get` to return NO
 * warehouse is what reproduces the case this file is actually about — an
 * account for which no warehouse exists at all, rather than one that simply
 * was not told about it.
 */
describe('warehouse panels with no assigned warehouse location', () => {
  beforeEach(() => {
    useSessionStore.setState({
      user: {
        id: 'owner-1',
        username: 'owner',
        name: 'Test Owner',
        roleKey: 'owner',
        permissions: ['inventory.balance.read', 'opname.read', 'waste.read'],
        locations: [],
        employeeId: null,
        mustSetPin: false,
      },
    });
    // The lookup finds nothing: this account really has no warehouse, which is
    // the scenario these assertions describe.
    vi.spyOn(api, 'get').mockResolvedValue({ rows: [] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const NO_LOCATION = 'Akun ini belum terhubung ke lokasi gudang manapun.';

  it('StockPanel shows the no-location message instead of a generic error', async () => {
    render(<StockPanel />);
    expect(await screen.findByText(NO_LOCATION)).toBeInTheDocument();
  });

  it('StockOpnamePanel shows the no-location message instead of a generic error', async () => {
    render(<StockOpnamePanel />);
    expect(await screen.findByText(NO_LOCATION)).toBeInTheDocument();
  });

  it('WastePanel shows the no-location message instead of rendering nothing', async () => {
    render(<WastePanel />);
    expect(await screen.findByText(NO_LOCATION)).toBeInTheDocument();
  });

  it('finds the warehouse via the API when the session does not name one', async () => {
    // The regression that prompted the change: an owner opening Stok Gudang was
    // told they had no warehouse, while their permissions said otherwise and
    // one plainly existed. A lookup that succeeds must NOT show that message.
    vi.spyOn(api, 'get').mockResolvedValue({
      rows: [{ id: 'wh-1', name: 'Gudang Pusat', city: 'Balikpapan', type: 'warehouse' }],
    });
    render(<StockPanel />);
    // Something other than the no-location message must appear — the panel gets
    // as far as loading its data.
    await screen.findByText((text) => text !== NO_LOCATION && text.trim().length > 0);
    expect(screen.queryByText(NO_LOCATION)).not.toBeInTheDocument();
  });
});
