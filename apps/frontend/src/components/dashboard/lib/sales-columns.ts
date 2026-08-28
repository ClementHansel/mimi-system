/**
 * CSV/PDF export columns for `SalesReportPanel` (CONTRACTS §4.19). The group
 * column's header depends on `groupBy` — day/outlet/product/method/channel —
 * mirroring the on-screen `DataTable` column so the export matches exactly
 * what's rendered, not a fixed "Group" header that would mean something
 * different depending on the active filter.
 *
 * Money stays a VERBATIM decimal string (CONTRACTS §0) — never run through
 * `formatMoney` — same convention as `components/finance/lib/io-columns.ts`,
 * so a spreadsheet can total the column without stripping "Rp" and thousands
 * dots first.
 */
import type { CsvColumn } from '@/lib/export/csv';
import type { SalesGroupBy, SalesReportRow } from './report-types';

type T = (key: string, params?: Record<string, string | number>) => string;

const GROUP_COLUMN_I18N_KEY: Record<SalesGroupBy, string> = {
  day: 'dashboard.sales.columnDay',
  outlet: 'dashboard.sales.columnOutlet',
  product: 'dashboard.sales.columnProduct',
  method: 'dashboard.sales.columnMethod',
  channel: 'dashboard.sales.columnChannel',
};

/** The i18n key for the group column's header under the given `groupBy`. */
export function salesGroupColumnI18nKey(groupBy: SalesGroupBy): string {
  return GROUP_COLUMN_I18N_KEY[groupBy];
}

/**
 * The i18n key for a `groupBy` value's own dropdown label ("Per Tanggal"),
 * as distinct from the COLUMN header it produces ("Tanggal") above. Both are
 * exhaustive `Record`s keyed on `SalesGroupBy`, so adding a sixth grouping
 * fails to compile here rather than silently falling through to whichever
 * branch a ternary chain happened to end on.
 */
const GROUP_BY_LABEL_I18N_KEY: Record<SalesGroupBy, string> = {
  day: 'dashboard.sales.groupByDay',
  outlet: 'dashboard.sales.groupByOutlet',
  product: 'dashboard.sales.groupByProduct',
  method: 'dashboard.sales.groupByMethod',
  channel: 'dashboard.sales.groupByChannel',
};

export function salesGroupByLabelI18nKey(groupBy: SalesGroupBy): string {
  return GROUP_BY_LABEL_I18N_KEY[groupBy];
}

export function salesExportColumns(t: T, groupBy: SalesGroupBy): CsvColumn<SalesReportRow>[] {
  return [
    { key: 'groupLabel', header: t(salesGroupColumnI18nKey(groupBy)) },
    { key: 'txCount', header: t('dashboard.sales.columnTxCount') },
    { key: 'gross', header: t('dashboard.sales.columnGross') },
    { key: 'discount', header: t('dashboard.sales.columnDiscount') },
    { key: 'platformFees', header: t('dashboard.sales.columnPlatformFees') },
    { key: 'net', header: t('dashboard.sales.columnNet') },
  ];
}
