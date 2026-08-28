import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { SalesReportPanel } from './SalesReportPanel';
import { useSessionStore } from '@/stores/session-store';
import { ApiError } from '@/lib/api';
import { reportApi } from './lib/report-api';
import type { SalesReportRow, SalesReportResult } from './lib/report-types';

/**
 * CONTRACTS §0: Money travels as a decimal STRING end to end — the totals
 * footer must sum via `sumMoney`'s BigInt-cents path, never
 * `parseFloat`/`Number()`, which is exactly the kind of thing that looks
 * right in a 0.10 + 0.20 = 0.3 test and silently drifts on a real day's
 * revenue. `report.export` gates the `ExportButton` the same way
 * `PurchaseOrdersPanel.test.tsx` gates its price column, and the error/empty
 * states must render distinctly per `ReportsPanel`'s house rule (a failed
 * request must never look like "no data").
 */
vi.mock('./lib/report-api', () => ({
  reportApi: {
    getSales: vi.fn(),
    listLocations: vi.fn(),
  },
}));

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'owner1',
      name: 'Owner',
      roleKey: 'owner',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

function salesRow(overrides: Partial<SalesReportRow> = {}): SalesReportRow {
  return {
    groupKey: '2026-08-20',
    groupLabel: '2026-08-20',
    txCount: 5,
    gross: '100000.00',
    discount: '0.00',
    platformFees: '0.00',
    net: '100000.00',
    ...overrides,
  };
}

function salesResult(rows: SalesReportRow[]): SalesReportResult {
  return { groupBy: 'day', from: '2026-08-01', to: '2026-08-27', rows };
}

describe('SalesReportPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(reportApi.getSales).mockReset();
    vi.mocked(reportApi.listLocations).mockReset();
    vi.mocked(reportApi.listLocations).mockResolvedValue([]);
  });

  it('sums the totals footer from decimal-string Money without float drift (0.10 + 0.20)', async () => {
    setPermissions(['report.sales.read']);
    vi.mocked(reportApi.getSales).mockResolvedValue(
      salesResult([
        salesRow({ groupKey: 'a', groupLabel: 'A', gross: '0.10', net: '0.10' }),
        salesRow({ groupKey: 'b', groupLabel: 'B', gross: '0.20', net: '0.20' }),
      ]),
    );

    render(<SalesReportPanel from="2026-08-01" to="2026-08-27" />);

    await screen.findByText('A');
    // 0.10 + 0.20 must read as exactly Rp0,30 — a float sum would render
    // Rp0,30000000000000004-shaped drift or fail this exact-string match.
    expect(screen.getAllByText('Rp0,30')).toHaveLength(2); // gross column total + net column total
  });

  it('hides ExportButton without report.export, shows it once granted', async () => {
    setPermissions(['report.sales.read']);
    vi.mocked(reportApi.getSales).mockResolvedValue(salesResult([salesRow()]));

    const { rerender } = render(<SalesReportPanel from="2026-08-01" to="2026-08-27" />);
    await screen.findByText('2026-08-20');
    expect(screen.queryAllByRole('button', { name: /ekspor/i })).toHaveLength(0);

    setPermissions(['report.sales.read', 'report.export']);
    rerender(<SalesReportPanel from="2026-08-01" to="2026-08-27" />);
    await waitFor(() => {
      expect(screen.getAllByRole('button', { name: /ekspor/i }).length).toBeGreaterThan(0);
    });
  });

  it('locked mode renders no outlet dropdown and always requests the pinned locationId', async () => {
    setPermissions(['report.sales.read']);
    vi.mocked(reportApi.getSales).mockResolvedValue(salesResult([salesRow()]));

    render(
      <SalesReportPanel
        from="2026-08-01"
        to="2026-08-27"
        lockedLocationId="loc-1"
        lockedLocationName="Outlet Balikpapan Baru"
      />,
    );

    await screen.findByText('2026-08-20');
    expect(screen.queryByText('Semua Outlet')).not.toBeInTheDocument();
    // Locked mode has no outlet picker to populate, so the locations list is
    // never fetched at all.
    expect(reportApi.listLocations).not.toHaveBeenCalled();
    expect(reportApi.getSales).toHaveBeenCalledWith('day', '2026-08-01', '2026-08-27', 'loc-1');
  });

  it('company mode omits the locationId param for "Semua Outlet" (never sends \'\')', async () => {
    setPermissions(['report.sales.read']);
    vi.mocked(reportApi.getSales).mockResolvedValue(salesResult([salesRow()]));

    render(<SalesReportPanel from="2026-08-01" to="2026-08-27" />);

    await screen.findByText('2026-08-20');
    expect(reportApi.getSales).toHaveBeenCalledWith('day', '2026-08-01', '2026-08-27', undefined);
  });

  it('renders the error state distinctly from the empty state', async () => {
    setPermissions(['report.sales.read']);
    vi.mocked(reportApi.getSales).mockRejectedValueOnce(
      new ApiError(500, 'ERR_INTERNAL', 'Terjadi kesalahan server'),
    );

    const { unmount } = render(<SalesReportPanel from="2026-08-01" to="2026-08-27" />);
    await waitFor(() => {
      expect(screen.getByText(/Terjadi kesalahan server/)).toBeInTheDocument();
    });
    expect(
      screen.queryByText('Belum ada penjualan pada periode dan filter ini.'),
    ).not.toBeInTheDocument();
    unmount();

    vi.mocked(reportApi.getSales).mockResolvedValue(salesResult([]));
    render(<SalesReportPanel from="2026-08-01" to="2026-08-27" />);
    await waitFor(() => {
      expect(
        screen.getByText('Belum ada penjualan pada periode dan filter ini.'),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(/Terjadi kesalahan server/)).not.toBeInTheDocument();
  });
});
