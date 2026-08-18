import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useSessionStore } from '@/stores/session-store';
import { StockPanel } from './StockPanel';
import { StockOpnamePanel } from './StockOpnamePanel';
import { WastePanel } from './WastePanel';

/**
 * FIX-LOADS #1/#2 — a company-wide role with no `warehouse`-type location
 * (Owner: `locations: []`, same shape that broke POS) hit either a
 * misleading "Gagal memuat data" (StockPanel/StockOpnamePanel, which reads
 * as "the request failed" when no request was ever attempted) or nothing
 * rendered at all (WastePanel's old `return null` — worse than an empty
 * state). All three now render one honest, consistent message instead.
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
  });

  it('StockPanel shows the no-location message instead of a generic error', () => {
    render(<StockPanel />);
    expect(
      screen.getByText('Akun ini belum terhubung ke lokasi gudang manapun.'),
    ).toBeInTheDocument();
  });

  it('StockOpnamePanel shows the no-location message instead of a generic error', () => {
    render(<StockOpnamePanel />);
    expect(
      screen.getByText('Akun ini belum terhubung ke lokasi gudang manapun.'),
    ).toBeInTheDocument();
  });

  it('WastePanel shows the no-location message instead of rendering nothing', () => {
    render(<WastePanel />);
    expect(
      screen.getByText('Akun ini belum terhubung ke lokasi gudang manapun.'),
    ).toBeInTheDocument();
  });
});
