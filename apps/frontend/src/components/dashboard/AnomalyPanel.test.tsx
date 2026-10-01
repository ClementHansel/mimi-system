import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { AnomalyPanel } from './AnomalyPanel';
import { AnomalyStrip } from './AnomalyStrip';
import { useSessionStore } from '@/stores/session-store';
import { dashboardApi } from './lib/dashboard-api';
import type {
  AnomalyDetectorKey,
  AnomalyDetectorResult,
  AnomalyItem,
  AnomalyResponse,
} from './lib/anomaly-types';

/**
 * The Anomali panel. What a wrong implementation would get wrong silently:
 *
 *  - showing a number the owner cannot act on (raw decimal strings instead of
 *    Rupiah, a ratio with no sign of which way it is off);
 *  - "mark reviewed" that does not tell the server WHICH finding (the
 *    fingerprint is the whole identity) or does not refresh afterwards;
 *  - a thresholds control visible to someone the server will refuse;
 *  - an all-clear strip drawn when a detector actually FAILED.
 */
vi.mock('./lib/dashboard-api', () => ({
  dashboardApi: {
    getAnomalyDrilldown: vi.fn(),
    reviewAnomaly: vi.fn(),
    getAnomalyThresholds: vi.fn(),
    putAnomalyThresholds: vi.fn(),
  },
}));
vi.mock('@/components/ui/Toast', () => ({ toast: vi.fn() }));

const KEYS: AnomalyDetectorKey[] = [
  'sales_day_outlier',
  'product_qty_outlier',
  'usage_variance',
  'price_deviation',
  'payroll_outlier',
  'gl_sanity',
  'settlement_gap',
];

function item(overrides: Partial<AnomalyItem> = {}): AnomalyItem {
  return {
    fingerprint: 'sales_day_outlier:loc-1:2026-04-14',
    severity: 'high',
    locationId: 'loc-1',
    locationName: 'Mimi Chicken Banjarmasin',
    date: '2026-04-14',
    period: null,
    metric: 'revenue',
    unit: 'idr',
    expected: '17000000.00',
    actual: '507000000.00',
    ratio: 29.82,
    detail: { direction: 'high', txCount: 412 },
    ref: { locationId: 'loc-1', date: '2026-04-14' },
    link: null,
    reviewed: false,
    reviewedAt: null,
    reviewedByName: null,
    reviewNote: null,
    ...overrides,
  };
}

function detector(
  key: AnomalyDetectorKey,
  items: AnomalyItem[] = [],
  extra: Partial<AnomalyDetectorResult> = {},
): AnomalyDetectorResult {
  const open = items.filter((i) => !i.reviewed).length;
  return {
    key,
    count: open,
    reviewedCount: items.length - open,
    total: items.length,
    truncated: false,
    notice: null,
    failed: false,
    items,
    ...extra,
  };
}

function response(
  overrides: Partial<Record<AnomalyDetectorKey, AnomalyDetectorResult>> = {},
): AnomalyResponse {
  const detectors = KEYS.map((k) => overrides[k] ?? detector(k));
  return {
    from: '2026-04-01',
    to: '2026-04-30',
    detectors,
    openCount: detectors.reduce((n, d) => n + d.count, 0),
  };
}

function setRole(roleKey: string) {
  useSessionStore.setState({
    user: {
      id: 'u1',
      username: roleKey,
      name: roleKey,
      roleKey,
      permissions: ['dashboard.view'],
      locations: [],
      employeeId: null,
      mustSetPin: false,
    },
  });
}

function renderPanel(
  data: AnomalyResponse | null,
  props: Partial<React.ComponentProps<typeof AnomalyPanel>> = {},
) {
  const onChanged = vi.fn();
  const onShowReviewedChange = vi.fn();
  render(
    <AnomalyPanel
      from="2026-04-01"
      to="2026-04-30"
      data={data}
      loading={false}
      showReviewed={false}
      onShowReviewedChange={onShowReviewedChange}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { onChanged, onShowReviewedChange };
}

describe('AnomalyPanel', () => {
  beforeEach(() => {
    useSessionStore.setState({ accessToken: null, refreshToken: null, user: null });
    vi.mocked(dashboardApi.getAnomalyDrilldown).mockReset();
    vi.mocked(dashboardApi.reviewAnomaly).mockReset();
    vi.mocked(dashboardApi.getAnomalyThresholds).mockReset();
    vi.mocked(dashboardApi.putAnomalyThresholds).mockReset();
    setRole('owner');
  });

  it('shows one summary tile per detector with its open count, and a finding with outlet, date, expected, actual and ratio in Rupiah', () => {
    renderPanel(
      response({
        sales_day_outlier: detector('sales_day_outlier', [item()]),
        price_deviation: detector('price_deviation', [
          item({
            fingerprint: 'p1',
            metric: 'unit_price',
            unit: 'idr',
            detail: { product: 'Sayap', lines: 19, deviating: 4, sharePct: 21.1 },
            expected: '10000.00',
            actual: '8000.00',
            ratio: 0.211,
            date: null,
            period: { from: '2026-04-01', to: '2026-04-30' },
          }),
          item({
            fingerprint: 'p2',
            metric: 'unit_price',
            unit: 'idr',
            detail: { product: 'Paha', lines: 9, deviating: 5, sharePct: 55 },
            expected: '12000.00',
            actual: '9000.00',
            ratio: 0.55,
            date: null,
            period: { from: '2026-04-01', to: '2026-04-30' },
          }),
        ]),
      }),
    );

    expect(
      within(screen.getByTestId('anomaly-summary-sales_day_outlier')).getByText('1'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('anomaly-summary-price_deviation')).getByText('2'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('anomaly-summary-gl_sanity')).getByText('0'),
    ).toBeInTheDocument();
    for (const k of KEYS) expect(screen.getByTestId(`anomaly-summary-${k}`)).toBeInTheDocument();

    // The first detector with findings is open by default.
    const row = screen.getByTestId('anomaly-item');
    expect(within(row).getByText('Mimi Chicken Banjarmasin')).toBeInTheDocument();
    expect(within(row).getByText('2026-04-14')).toBeInTheDocument();
    expect(within(row).getByText('Rp17.000.000')).toBeInTheDocument(); // expected
    expect(within(row).getByText(/Rp507\.000\.000/)).toBeInTheDocument(); // actual
    expect(within(row).getByText('(×29,82)')).toBeInTheDocument();
    expect(within(row).getByText(/412 transaksi/)).toBeInTheDocument();
    expect(within(row).getByText('Tinggi')).toBeInTheDocument();
  });

  it('"Tandai sudah ditinjau" sends the finding\'s detector, fingerprint and outlet, then refreshes', async () => {
    vi.mocked(dashboardApi.reviewAnomaly).mockResolvedValue({
      detector: 'sales_day_outlier',
      fingerprint: 'sales_day_outlier:loc-1:2026-04-14',
      reviewed: true,
      reviewedAt: '2026-05-01T00:00:00.000Z',
    });
    const { onChanged } = renderPanel(
      response({ sales_day_outlier: detector('sales_day_outlier', [item()]) }),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tandai sudah ditinjau' }));

    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(dashboardApi.reviewAnomaly).toHaveBeenCalledWith({
      detector: 'sales_day_outlier',
      fingerprint: 'sales_day_outlier:loc-1:2026-04-14',
      locationId: 'loc-1',
      reviewed: true,
    });
  });

  it('a failed review does NOT refresh (the row must not look reviewed when it is not)', async () => {
    vi.mocked(dashboardApi.reviewAnomaly).mockRejectedValue(new Error('boom'));
    const { onChanged } = renderPanel(
      response({ sales_day_outlier: detector('sales_day_outlier', [item()]) }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Tandai sudah ditinjau' }));
    await waitFor(() => expect(dashboardApi.reviewAnomaly).toHaveBeenCalled());
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('a reviewed finding says who and when, and offers to take the review back', async () => {
    vi.mocked(dashboardApi.reviewAnomaly).mockResolvedValue({
      detector: 'sales_day_outlier',
      fingerprint: 'x',
      reviewed: false,
      reviewedAt: null,
    });
    const { onChanged } = renderPanel(
      response({
        sales_day_outlier: detector('sales_day_outlier', [
          item({
            reviewed: true,
            reviewedByName: 'Pak Budi',
            reviewedAt: '2026-05-01T03:00:00.000Z',
            reviewNote: 'ada acara',
          }),
        ]),
      }),
      { showReviewed: true },
    );
    expect(screen.getByText('Sudah ditinjau')).toBeInTheDocument();
    expect(screen.getByText(/Ditinjau oleh Pak Budi/)).toBeInTheDocument();
    expect(screen.getByText(/ada acara/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Tandai sudah ditinjau' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Batalkan tinjauan' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(dashboardApi.reviewAnomaly).toHaveBeenCalledWith(
      expect.objectContaining({ reviewed: false }),
    );
  });

  it('the "show reviewed" toggle asks the shell to refetch with includeReviewed', async () => {
    const { onShowReviewedChange } = renderPanel(response());
    fireEvent.click(screen.getByLabelText('Tampilkan yang sudah ditinjau'));
    expect(onShowReviewedChange).toHaveBeenCalledWith(true);
  });

  it('"Lihat baris terkait" loads the offending rows with the finding\'s own ref and window, and formats them by column type', async () => {
    vi.mocked(dashboardApi.getAnomalyDrilldown).mockResolvedValue({
      columns: [
        { key: 'receipt', type: 'text' },
        { key: 'at', type: 'datetime' },
        { key: 'total', type: 'money' },
      ],
      rows: [{ receipt: 'R-0042', at: '2026-04-14T05:00:00.000Z', total: '480000000.00' }],
    });
    renderPanel(response({ sales_day_outlier: detector('sales_day_outlier', [item()]) }));

    fireEvent.click(screen.getByRole('button', { name: 'Lihat baris terkait' }));

    expect(dashboardApi.getAnomalyDrilldown).toHaveBeenCalledWith(
      'sales_day_outlier',
      '2026-04-01',
      '2026-04-30',
      { locationId: 'loc-1', date: '2026-04-14' },
    );
    expect(await screen.findByText('R-0042')).toBeInTheDocument();
    expect(screen.getByText('Rp480.000.000')).toBeInTheDocument();
    expect(screen.getByText('No. Struk')).toBeInTheDocument();

    // A second open does not refetch.
    fireEvent.click(screen.getByRole('button', { name: 'Sembunyikan baris' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lihat baris terkait' }));
    expect(dashboardApi.getAnomalyDrilldown).toHaveBeenCalledTimes(1);
  });

  it('a settlement detector with nothing recorded explains why it is quiet instead of looking clean', async () => {
    renderPanel(
      response({
        settlement_gap: detector('settlement_gap', [], { notice: 'no_settlement_recorded' }),
      }),
    );
    fireEvent.click(screen.getByTestId('anomaly-summary-settlement_gap'));
    expect(await screen.findByText(/Belum ada penyelesaian/)).toBeInTheDocument();
  });

  it('a detector that failed shows "!" and a failure message — never a reassuring zero', async () => {
    renderPanel(response({ payroll_outlier: detector('payroll_outlier', [], { failed: true }) }));
    expect(
      within(screen.getByTestId('anomaly-summary-payroll_outlier')).getByText('!'),
    ).toBeInTheDocument();
    // all other detectors are clean, but the "all clear" empty state must not appear
    expect(screen.queryByText('Tidak ada anomali yang perlu ditinjau')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('anomaly-summary-payroll_outlier'));
    expect(await screen.findByText(/Pemeriksaan ini gagal dijalankan\./)).toBeInTheDocument();
  });

  it('says so when everything is clean', () => {
    renderPanel(response());
    expect(screen.getByText('Tidak ada anomali yang perlu ditinjau')).toBeInTheDocument();
  });

  it('says when a long list was cut off', async () => {
    renderPanel(
      response({
        sales_day_outlier: detector('sales_day_outlier', [item()], { truncated: true, total: 350 }),
      }),
    );
    expect(screen.getByText(/Menampilkan 1 dari 350 temuan/)).toBeInTheDocument();
  });

  // ── thresholds ─────────────────────────────────────────────────────────────

  const fields = [
    { detector: 'sales_day_outlier', key: 'hi', default: 3, min: 1.1, max: 1000 },
    {
      detector: 'sales_day_outlier',
      key: 'baselineDays',
      default: 28,
      min: 7,
      max: 90,
      integer: true,
    },
    { detector: 'gl_sanity', key: 'cashGrowthDays', default: 7, min: 1, max: 365, integer: true },
  ];
  const thresholdsPayload = {
    thresholds: {
      sales_day_outlier: { hi: 3, baselineDays: 28 },
      gl_sanity: { cashGrowthDays: 7 },
    },
    defaults: { sales_day_outlier: { hi: 3, baselineDays: 28 }, gl_sanity: { cashGrowthDays: 7 } },
    fields,
  };

  it('only the owner (and superadmin) sees the thresholds button', () => {
    setRole('manager');
    const { unmount } = render(
      <AnomalyPanel
        from="a"
        to="b"
        data={response()}
        loading={false}
        showReviewed={false}
        onShowReviewedChange={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Atur Ambang Batas' })).not.toBeInTheDocument();
    unmount();
    setRole('owner');
    render(
      <AnomalyPanel
        from="a"
        to="b"
        data={response()}
        loading={false}
        showReviewed={false}
        onShowReviewedChange={vi.fn()}
        onChanged={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Atur Ambang Batas' })).toBeInTheDocument();
  });

  it('the thresholds dialog edits, saves ONLY valid numbers, and re-runs the panel', async () => {
    vi.mocked(dashboardApi.getAnomalyThresholds).mockResolvedValue(thresholdsPayload);
    vi.mocked(dashboardApi.putAnomalyThresholds).mockResolvedValue(thresholdsPayload);
    const { onChanged } = renderPanel(response());

    fireEvent.click(screen.getByRole('button', { name: 'Atur Ambang Batas' }));
    const hi = await screen.findByLabelText('Batas atas (× median)');
    expect(hi).toHaveValue(3);

    // Out of range: refused client-side, save is disabled.
    fireEvent.change(hi, { target: { value: '0.5' } });
    expect(screen.getByText('Harus antara 1.1 dan 1000.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Simpan' })).toBeDisabled();

    // An integer-only field refuses a fraction.
    fireEvent.change(hi, { target: { value: '4.5' } });
    const days = screen.getByLabelText('Hari riwayat pembanding');
    fireEvent.change(days, { target: { value: '14.5' } });
    expect(screen.getByText('Harus bilangan bulat.')).toBeInTheDocument();
    fireEvent.change(days, { target: { value: '14' } });

    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(dashboardApi.putAnomalyThresholds).toHaveBeenCalledTimes(1));
    expect(dashboardApi.putAnomalyThresholds).toHaveBeenCalledWith({
      sales_day_outlier: { hi: 4.5, baselineDays: 14 },
      gl_sanity: { cashGrowthDays: 7 },
    });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('"Pulihkan Bawaan" puts every field back to its default', async () => {
    vi.mocked(dashboardApi.getAnomalyThresholds).mockResolvedValue({
      ...thresholdsPayload,
      thresholds: {
        sales_day_outlier: { hi: 9, baselineDays: 60 },
        gl_sanity: { cashGrowthDays: 30 },
      },
    });
    renderPanel(response());
    fireEvent.click(screen.getByRole('button', { name: 'Atur Ambang Batas' }));
    const hi = await screen.findByLabelText('Batas atas (× median)');
    expect(hi).toHaveValue(9);
    fireEvent.click(screen.getByRole('button', { name: 'Pulihkan Bawaan' }));
    expect(hi).toHaveValue(3);
    expect(screen.getByLabelText('Kas naik tanpa setoran (hari)')).toHaveValue(7);
  });

  it('a refused save shows the error CODE sentence, not the server message', async () => {
    vi.mocked(dashboardApi.getAnomalyThresholds).mockResolvedValue(thresholdsPayload);
    const { ApiError } = await import('@/lib/api');
    vi.mocked(dashboardApi.putAnomalyThresholds).mockRejectedValue(
      new ApiError(403, 'ERR_FORBIDDEN', 'Only the owner may change anomaly thresholds'),
    );
    renderPanel(response());
    fireEvent.click(screen.getByRole('button', { name: 'Atur Ambang Batas' }));
    await screen.findByLabelText('Batas atas (× median)');
    fireEvent.click(screen.getByRole('button', { name: 'Simpan' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Anda tidak punya akses untuk tindakan ini.',
    );
    expect(screen.queryByText(/Only the owner/)).not.toBeInTheDocument();
  });
});

describe('AnomalyStrip', () => {
  it('counts the open findings and takes you to the tab', async () => {
    const onOpen = vi.fn();
    render(
      <AnomalyStrip
        data={response({
          sales_day_outlier: detector('sales_day_outlier', [item(), item({ fingerprint: 'b' })]),
        })}
        loading={false}
        onOpen={onOpen}
      />,
    );
    expect(screen.getByText('2 anomali data belum ditinjau')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Lihat' }));
    expect(onOpen).toHaveBeenCalled();
  });

  it('says all clear only when every detector actually ran', () => {
    const { unmount } = render(<AnomalyStrip data={response()} loading={false} onOpen={vi.fn()} />);
    expect(screen.getByText('Tidak ada anomali data yang perlu ditinjau')).toBeInTheDocument();
    unmount();
    render(
      <AnomalyStrip
        data={response({ gl_sanity: detector('gl_sanity', [], { failed: true }) })}
        loading={false}
        onOpen={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('anomaly-strip')).not.toBeInTheDocument();
  });

  it('renders nothing before the first response', () => {
    render(<AnomalyStrip data={null} loading onOpen={vi.fn()} />);
    expect(screen.queryByTestId('anomaly-strip')).not.toBeInTheDocument();
  });
});
