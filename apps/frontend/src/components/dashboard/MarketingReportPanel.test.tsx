import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MarketingReportPanel } from './MarketingReportPanel';
import { useSessionStore } from '@/stores/session-store';
import { reportApi } from './lib/report-api';
import type { SalesReportRow, SalesReportResult, OnlineOrderReportRow } from './lib/report-types';

/**
 * Marketing tab — a READ-ONLY report over EXISTING endpoints (no
 * promo/voucher/campaign/customer tables anywhere in this codebase). These
 * tests pin down the three things a wrong implementation would get wrong
 * silently: (1) every discount-%/contribution-% is computed off the decimal-
 * string `Money` fields via `moneySharePct` (BigInt cents), never
 * `parseFloat`; (2) a zero-gross basis renders the house em-dash, never a
 * lying "0,0%"; (3) the online-order recon table's near-always-empty state
 * explains WHY (migration 249 retired that write path) instead of looking
 * broken.
 */
vi.mock('./lib/report-api', () => ({
  reportApi: {
    getSales: vi.fn(),
    getOnlineOrders: vi.fn(),
    listLocations: vi.fn(),
  },
}));

function channelResult(rows: SalesReportRow[]): SalesReportResult {
  return { groupBy: 'channel', from: '2026-08-01', to: '2026-08-27', rows };
}

function productResult(rows: SalesReportRow[]): SalesReportResult {
  return { groupBy: 'product', from: '2026-08-01', to: '2026-08-27', rows };
}

function channelRow(overrides: Partial<SalesReportRow> = {}): SalesReportRow {
  return {
    groupKey: 'walk_in',
    groupLabel: 'walk_in',
    txCount: 1,
    gross: '0.00',
    discount: '0.00',
    platformFees: '0.00',
    net: '0.00',
    ...overrides,
  };
}

function setPermissions(permissions: string[]) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: 'owner1',
      name: 'Owner Satu',
      roleKey: 'owner',
      permissions,
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

function mockApi({
  channel = [],
  product = [],
  online = [],
}: {
  channel?: SalesReportRow[];
  product?: SalesReportRow[];
  online?: OnlineOrderReportRow[];
} = {}) {
  vi.mocked(reportApi.getSales).mockImplementation((groupBy) =>
    Promise.resolve(groupBy === 'channel' ? channelResult(channel) : productResult(product)),
  );
  vi.mocked(reportApi.getOnlineOrders).mockResolvedValue(online);
  vi.mocked(reportApi.listLocations).mockResolvedValue([]);
}

describe('MarketingReportPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(reportApi.getSales).mockReset();
    vi.mocked(reportApi.getOnlineOrders).mockReset();
    vi.mocked(reportApi.listLocations).mockReset();
  });

  it('computes discount-% and gross-contribution-% off decimal-string Money via BigInt cents (0.10/0.20 float trap)', async () => {
    setPermissions(['dashboard.view', 'report.export']);
    mockApi({
      channel: [
        channelRow({ groupKey: 'walk_in', groupLabel: 'walk_in', gross: '0.10', discount: '0.00' }),
        channelRow({ groupKey: 'gofood', groupLabel: 'gofood', gross: '0.20', discount: '0.10' }),
      ],
    });

    render(<MarketingReportPanel from="2026-08-01" to="2026-08-27" />);

    // Total gross = 0.10 + 0.20 = 0.30 (not 0.30000000000000004); total
    // discount = 0.10 -> spend strip's "Diskon terhadap Bruto" = 33,3% — the
    // same figure the walk_in row's own gross-contribution happens to land
    // on (0.10 / 0.30), so both are expected to be present, not exactly one.
    await waitFor(() => expect(screen.getAllByText('33,3%').length).toBeGreaterThanOrEqual(2));

    // The gofood row's own discount-% = 0.10 / 0.20 = 50,0%, and its
    // contribution to the period's total gross = 0.20 / 0.30 = 66,7%.
    expect(screen.getByText('50,0%')).toBeInTheDocument();
    expect(screen.getByText('66,7%')).toBeInTheDocument();
  });

  it('renders the em-dash "noBasis", never "0,0%", when the gross basis is zero', async () => {
    setPermissions(['dashboard.view']);
    mockApi({
      channel: [
        channelRow({ groupKey: 'walk_in', groupLabel: 'walk_in', gross: '0.00', discount: '0.00' }),
      ],
    });

    render(<MarketingReportPanel from="2026-08-01" to="2026-08-27" />);

    await waitFor(() => expect(screen.queryAllByText('—').length).toBeGreaterThan(0));
    expect(screen.queryByText('0,0%')).not.toBeInTheDocument();
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
  });

  it('explains the online-order recon empty state instead of rendering a bare empty table', async () => {
    setPermissions(['dashboard.view']);
    mockApi({ online: [] });

    render(<MarketingReportPanel from="2026-08-01" to="2026-08-27" />);

    expect(
      await screen.findByText(
        /Pesanan GoFood\/ShopeeFood kini dicatat sebagai penjualan kasir berkanal/,
      ),
    ).toBeInTheDocument();
  });

  it('hides every ExportButton without report.export', async () => {
    setPermissions(['dashboard.view']);
    mockApi({ channel: [channelRow()] });

    render(<MarketingReportPanel from="2026-08-01" to="2026-08-27" />);

    await waitFor(() => expect(reportApi.getSales).toHaveBeenCalled());
    expect(screen.queryByText('Ekspor CSV')).not.toBeInTheDocument();
  });

  it('shows ExportButton(s) with report.export', async () => {
    setPermissions(['dashboard.view', 'report.export']);
    mockApi({ channel: [channelRow()] });

    render(<MarketingReportPanel from="2026-08-01" to="2026-08-27" />);

    expect((await screen.findAllByText('Ekspor CSV')).length).toBeGreaterThan(0);
  });

  it('locked (outlet-scoped) mode renders no outlet dropdown and always requests the pinned locationId', async () => {
    setPermissions(['dashboard.outlet.view']);
    mockApi({ channel: [channelRow()] });

    render(
      <MarketingReportPanel
        from="2026-08-01"
        to="2026-08-27"
        lockedLocationId="loc-42"
        lockedLocationName="Outlet Sanur"
      />,
    );

    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(reportApi.getSales).toHaveBeenCalledWith(
        'channel',
        '2026-08-01',
        '2026-08-27',
        'loc-42',
      ),
    );
    expect(reportApi.getSales).toHaveBeenCalledWith(
      'product',
      '2026-08-01',
      '2026-08-27',
      'loc-42',
    );
    expect(reportApi.getOnlineOrders).toHaveBeenCalledWith('2026-08-01', '2026-08-27', 'loc-42');
    // Locked mode never fetches the outlet list either.
    expect(reportApi.listLocations).not.toHaveBeenCalled();
  });

  it('falls back to the raw groupLabel for a channel key the label map does not know', async () => {
    setPermissions(['dashboard.view']);
    mockApi({
      channel: [
        channelRow({ groupKey: 'kiosk_mystery', groupLabel: 'Kanal Aneh', gross: '100.00' }),
      ],
    });

    render(<MarketingReportPanel from="2026-08-01" to="2026-08-27" />);

    expect(await screen.findByText('Kanal Aneh')).toBeInTheDocument();
  });
});
