/**
 * Marketing report tab helpers — channel-label mapping, sorted/percentaged
 * export rows, and the CSV/PDF column sets for its three tables (channel,
 * products, online-order reconciliation). Same convention as
 * `components/finance/lib/io-columns.ts`: the on-screen `DataTable` and the
 * `ExportButton` read the SAME derived rows, so the file never disagrees with
 * the screen.
 *
 * No new endpoint, no marketing subsystem: every row here is `SalesReportRow`
 * (`groupBy=channel` / `groupBy=product`) or `OnlineOrderReportRow`, both
 * already defined in `./report-types.ts` (CONTRACTS §4.19).
 */
import type { CsvColumn } from '@/lib/export/csv';
import { fmtDate } from '@/lib/dates';
import { formatPercent } from '@/lib/formatters';
import { compareMoney, moneySharePct } from '@/lib/money';
import type { Money } from '@/lib/shared-types';
import type { OnlineOrderReportRow, SalesReportRow } from './report-types';

type T = (key: string, params?: Record<string, string | number>) => string;

/** `groupKey` -> i18n key, for the three channels the POS actually tags. */
const CHANNEL_LABEL_KEYS: Record<string, string> = {
  walk_in: 'dashboard.marketing.channelWalkIn',
  gofood: 'dashboard.marketing.channelGofood',
  shopeefood: 'dashboard.marketing.channelShopeefood',
};

/**
 * Maps a channel row to its display label. Falls back to the raw
 * `groupLabel` the backend sent for any `groupKey` not in the map above —
 * a channel this screen doesn't know about yet must still render, not crash
 * or blank the row.
 */
export function channelLabel(t: T, row: Pick<SalesReportRow, 'groupKey' | 'groupLabel'>): string {
  const key = CHANNEL_LABEL_KEYS[row.groupKey];
  return key ? t(key) : row.groupLabel;
}

/** `moneySharePct` rendered as the house em-dash when the basis is zero, never "0,0%". */
export function pctOrDash(t: T, value: number | null): string {
  return value === null ? t('dashboard.marketing.noBasis') : formatPercent(value);
}

/** A channel row plus its display label and the two percentages the table/export both need. */
export interface ChannelExportRow extends SalesReportRow {
  channelLabelText: string;
  discountPct: number | null;
  sharePct: number | null;
}

/** Adds label + discount-% + gross-contribution-% to every channel row, against the period's total gross. */
export function buildChannelExportRows(
  t: T,
  rows: SalesReportRow[],
  totalGross: Money,
): ChannelExportRow[] {
  return rows.map((r) => ({
    ...r,
    channelLabelText: channelLabel(t, r),
    discountPct: moneySharePct(r.discount, r.gross),
    sharePct: moneySharePct(r.gross, totalGross),
  }));
}

export function channelIoColumns(t: T): CsvColumn<ChannelExportRow>[] {
  return [
    { key: 'channelLabelText', header: t('dashboard.marketing.columnChannel') },
    { key: 'txCount', header: t('dashboard.sales.columnTxCount') },
    { key: 'gross', header: t('dashboard.sales.columnGross') },
    { key: 'discount', header: t('dashboard.sales.columnDiscount') },
    {
      key: 'discountPct',
      header: t('dashboard.marketing.columnDiscountPct'),
      format: (r) => pctOrDash(t, r.discountPct),
    },
    { key: 'platformFees', header: t('dashboard.sales.columnPlatformFees') },
    { key: 'net', header: t('dashboard.sales.columnNet') },
    {
      key: 'sharePct',
      header: t('dashboard.marketing.columnShare'),
      format: (r) => pctOrDash(t, r.sharePct),
    },
  ];
}

/** A product row plus its discount-%, already sorted gross-descending. */
export interface ProductExportRow extends SalesReportRow {
  discountPct: number | null;
}

/** Sorts by gross descending (BigInt cents, never a float compare) and attaches discount-%. */
export function buildProductExportRows(rows: SalesReportRow[]): ProductExportRow[] {
  return [...rows]
    .sort((a, b) => compareMoney(b.gross, a.gross))
    .map((r) => ({ ...r, discountPct: moneySharePct(r.discount, r.gross) }));
}

export function productIoColumns(t: T): CsvColumn<ProductExportRow>[] {
  return [
    { key: 'groupLabel', header: t('dashboard.sales.columnProduct') },
    { key: 'txCount', header: t('dashboard.sales.columnTxCount') },
    { key: 'gross', header: t('dashboard.sales.columnGross') },
    { key: 'discount', header: t('dashboard.sales.columnDiscount') },
    {
      key: 'discountPct',
      header: t('dashboard.marketing.columnDiscountPct'),
      format: (r) => pctOrDash(t, r.discountPct),
    },
  ];
}

export function reconIoColumns(t: T): CsvColumn<OnlineOrderReportRow>[] {
  return [
    { key: 'orderRef', header: t('dashboard.marketing.columnOrderRef') },
    {
      key: 'orderDate',
      header: t('dashboard.marketing.columnOrderDate'),
      format: (r) => fmtDate(r.orderDate),
    },
    { key: 'locationName', header: t('dashboard.outlets.columnName') },
    { key: 'platform', header: t('dashboard.marketing.columnPlatform') },
    { key: 'grossAmount', header: t('dashboard.sales.columnGross') },
    { key: 'discountAmount', header: t('dashboard.sales.columnDiscount') },
    { key: 'platformFee', header: t('dashboard.sales.columnPlatformFees') },
    { key: 'otherFee', header: t('dashboard.marketing.columnOtherFee') },
    { key: 'netReceived', header: t('dashboard.sales.columnNet') },
    { key: 'status', header: t('dashboard.marketing.columnStatus') },
    { key: 'settlementStatus', header: t('dashboard.marketing.columnSettlement') },
  ];
}
