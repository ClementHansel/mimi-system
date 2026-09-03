'use client';

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { formatMoney, formatNumber, formatPercent } from '@/lib/formatters';
import { fmtDate } from '@/lib/dates';
import { sumMoney, moneySharePct } from '@/lib/money';
import { usePermissions } from '@/lib/permissions';
import { Select } from '@/components/ui/Select';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { ExportButton } from '@/components/common/ExportButton';
import { reportApi } from './lib/report-api';
import {
  buildChannelExportRows,
  buildProductExportRows,
  channelIoColumns,
  productIoColumns,
  reconIoColumns,
  type ChannelExportRow,
  type ProductExportRow,
} from './lib/marketing-columns';
import type { ISODate } from '@/lib/shared-types';
import type { LocationOption, OnlineOrderReportRow, SalesReportRow } from './lib/report-types';
import { errMsg } from '@/lib/api-error';

export interface MarketingReportPanelProps {
  from: ISODate;
  to: ISODate;
  /** Outlet-scoped mode (Supervisor): pin to one location, render NO outlet dropdown. */
  lockedLocationId?: string;
  lockedLocationName?: string;
}

/**
 * Marketing tab — a READ-ONLY report assembled entirely from the existing
 * `/api/reports/sales` (`groupBy=channel`/`product`) and
 * `/api/reports/online-orders` endpoints (CONTRACTS §4.19). There is no
 * marketing subsystem (no promo/voucher/campaign/customer tables) and this
 * component must never imply one exists — "spend" here means discount given
 * away and platform commission paid, read off sales that already happened.
 *
 * The shell owns date-range state (same as `TrendPanel`/`TopProductsPanel`):
 * this component renders no `DateRangePicker`.
 */
export function MarketingReportPanel({
  from,
  to,
  lockedLocationId,
  lockedLocationName,
}: MarketingReportPanelProps) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const canExport = can('report.export');

  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState('');

  // Locked (outlet-scoped) mode always sends the pinned id and never shows
  // the dropdown; company mode sends whatever is selected, or nothing
  // ("Semua Outlet" == the caller's own scope, per `report-api.ts`'s header).
  // `|| undefined` rather than passing '' through: omitting the param is what
  // the backend reads as "my full entitled scope". A blank string happens to be
  // dropped by `reportApi`'s query-string builder today, but relying on that
  // makes correctness here depend on a detail of another file — and the Sales
  // tab next door already states the intent explicitly.
  const effectiveLocationId = lockedLocationId ?? (selectedLocationId || undefined);
  const locationIdParam = effectiveLocationId || undefined;

  useEffect(() => {
    if (lockedLocationId) return;
    let cancelled = false;
    reportApi
      .listLocations()
      .then((res) => {
        if (!cancelled) setLocations(res);
      })
      .catch(() => {
        // The outlet filter degrading to "just the blank option" is not
        // worth its own error state — the report itself still loads below.
      });
    return () => {
      cancelled = true;
    };
  }, [lockedLocationId]);

  const [channelRows, setChannelRows] = useState<SalesReportRow[]>([]);
  const [channelLoading, setChannelLoading] = useState(true);
  const [channelError, setChannelError] = useState<string | undefined>();

  const [productRows, setProductRows] = useState<SalesReportRow[]>([]);
  const [productLoading, setProductLoading] = useState(true);
  const [productError, setProductError] = useState<string | undefined>();

  const [reconRows, setReconRows] = useState<OnlineOrderReportRow[]>([]);
  const [reconLoading, setReconLoading] = useState(true);
  const [reconError, setReconError] = useState<string | undefined>();

  useEffect(() => {
    let cancelled = false;
    setChannelLoading(true);
    setChannelError(undefined);
    setProductLoading(true);
    setProductError(undefined);
    setReconLoading(true);
    setReconError(undefined);

    // Fired concurrently — one section failing must not blank the other two,
    // so each leg catches its own error instead of letting a single reject
    // short-circuit the rest.
    const channelPromise = reportApi
      .getSales('channel', from, to, locationIdParam)
      .then((res) => {
        if (!cancelled) setChannelRows(res.rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setChannelRows([]);
          setChannelError(errMsg(err, t('table.error')));
        }
      })
      .finally(() => {
        if (!cancelled) setChannelLoading(false);
      });

    const productPromise = reportApi
      .getSales('product', from, to, locationIdParam)
      .then((res) => {
        if (!cancelled) setProductRows(res.rows);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setProductRows([]);
          setProductError(errMsg(err, t('table.error')));
        }
      })
      .finally(() => {
        if (!cancelled) setProductLoading(false);
      });

    const reconPromise = reportApi
      .getOnlineOrders(from, to, locationIdParam)
      .then((res) => {
        if (!cancelled) setReconRows(res);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setReconRows([]);
          setReconError(errMsg(err, t('table.error')));
        }
      })
      .finally(() => {
        if (!cancelled) setReconLoading(false);
      });

    void Promise.all([channelPromise, productPromise, reconPromise]);

    return () => {
      cancelled = true;
    };
  }, [from, to, locationIdParam, t]);

  const totalGross = useMemo(() => sumMoney(channelRows.map((r) => r.gross)), [channelRows]);
  const totalDiscount = useMemo(() => sumMoney(channelRows.map((r) => r.discount)), [channelRows]);
  const totalFees = useMemo(() => sumMoney(channelRows.map((r) => r.platformFees)), [channelRows]);
  const totalNet = useMemo(() => sumMoney(channelRows.map((r) => r.net)), [channelRows]);
  const discountPct = moneySharePct(totalDiscount, totalGross);
  const feesPct = moneySharePct(totalFees, totalGross);

  const channelExportRows = useMemo(
    () => buildChannelExportRows(t, channelRows, totalGross),
    [t, channelRows, totalGross],
  );
  const productExportRows = useMemo(() => buildProductExportRows(productRows), [productRows]);

  const selectedLocation = locations.find((l) => l.id === selectedLocationId);
  const scopeLabel =
    lockedLocationName ??
    (selectedLocation ? `${selectedLocation.code} — ${selectedLocation.name}` : undefined) ??
    t('dashboard.sales.allOutlets');

  const channelColumns: DataTableColumn<ChannelExportRow>[] = [
    { key: 'channelLabelText', header: t('dashboard.marketing.columnChannel') },
    {
      key: 'txCount',
      header: t('dashboard.sales.columnTxCount'),
      align: 'right',
      render: (r) => formatNumber(r.txCount),
    },
    {
      key: 'gross',
      header: t('dashboard.sales.columnGross'),
      align: 'right',
      render: (r) => formatMoney(r.gross),
    },
    {
      key: 'discount',
      header: t('dashboard.sales.columnDiscount'),
      align: 'right',
      render: (r) => formatMoney(r.discount),
    },
    {
      key: 'discountPct',
      header: t('dashboard.marketing.columnDiscountPct'),
      align: 'right',
      render: (r) =>
        r.discountPct === null ? t('dashboard.marketing.noBasis') : formatPercent(r.discountPct),
    },
    {
      key: 'platformFees',
      header: t('dashboard.sales.columnPlatformFees'),
      align: 'right',
      render: (r) => formatMoney(r.platformFees),
    },
    {
      key: 'net',
      header: t('dashboard.sales.columnNet'),
      align: 'right',
      render: (r) => formatMoney(r.net),
    },
    {
      key: 'sharePct',
      header: t('dashboard.marketing.columnShare'),
      align: 'right',
      render: (r) =>
        r.sharePct === null ? t('dashboard.marketing.noBasis') : formatPercent(r.sharePct),
    },
  ];

  const productColumns: DataTableColumn<ProductExportRow>[] = [
    { key: 'groupLabel', header: t('dashboard.sales.columnProduct') },
    {
      key: 'txCount',
      header: t('dashboard.sales.columnTxCount'),
      align: 'right',
      render: (r) => formatNumber(r.txCount),
    },
    {
      key: 'gross',
      header: t('dashboard.sales.columnGross'),
      align: 'right',
      render: (r) => formatMoney(r.gross),
    },
    {
      key: 'discount',
      header: t('dashboard.sales.columnDiscount'),
      align: 'right',
      render: (r) => formatMoney(r.discount),
    },
    {
      key: 'discountPct',
      header: t('dashboard.marketing.columnDiscountPct'),
      align: 'right',
      render: (r) =>
        r.discountPct === null ? t('dashboard.marketing.noBasis') : formatPercent(r.discountPct),
    },
  ];

  const reconColumns: DataTableColumn<OnlineOrderReportRow>[] = [
    { key: 'orderRef', header: t('dashboard.marketing.columnOrderRef') },
    {
      key: 'orderDate',
      header: t('dashboard.marketing.columnOrderDate'),
      render: (r) => fmtDate(r.orderDate),
    },
    { key: 'locationName', header: t('dashboard.outlets.columnName') },
    { key: 'platform', header: t('dashboard.marketing.columnPlatform') },
    {
      key: 'grossAmount',
      header: t('dashboard.sales.columnGross'),
      align: 'right',
      render: (r) => formatMoney(r.grossAmount),
    },
    {
      key: 'discountAmount',
      header: t('dashboard.sales.columnDiscount'),
      align: 'right',
      render: (r) => formatMoney(r.discountAmount),
    },
    {
      key: 'platformFee',
      header: t('dashboard.sales.columnPlatformFees'),
      align: 'right',
      render: (r) => formatMoney(r.platformFee),
    },
    {
      key: 'otherFee',
      header: t('dashboard.marketing.columnOtherFee'),
      align: 'right',
      render: (r) => formatMoney(r.otherFee),
    },
    {
      key: 'netReceived',
      header: t('dashboard.sales.columnNet'),
      align: 'right',
      render: (r) => formatMoney(r.netReceived),
    },
    { key: 'status', header: t('dashboard.marketing.columnStatus') },
    { key: 'settlementStatus', header: t('dashboard.marketing.columnSettlement') },
  ];

  // A failed request and an empty dataset must never look alike (house rule,
  // `ReportsPanel`): the message is appended with `loadErrorHint` before it
  // reaches `DataTable`'s error row, rather than the bare `ApiError` message.
  const channelErrorText = channelError
    ? `${channelError} — ${t('dashboard.marketing.loadErrorHint')}`
    : undefined;
  const productErrorText = productError
    ? `${productError} — ${t('dashboard.marketing.loadErrorHint')}`
    : undefined;
  const reconErrorText = reconError
    ? `${reconError} — ${t('dashboard.marketing.loadErrorHint')}`
    : undefined;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-text-primary">
          {t('dashboard.marketing.title')}
        </h2>
        <p className="text-sm text-text-secondary">{t('dashboard.marketing.description')}</p>
      </div>

      {!lockedLocationId && (
        <Select
          label={t('dashboard.sales.outlet')}
          value={selectedLocationId}
          onValueChange={setSelectedLocationId}
          // Explicit blank first option, not a `placeholder`: "Semua Outlet" is
          // a real, selectable choice a reader comes BACK to, not a prompt for
          // an unmade one. Same shape as the Sales tab and `InventoryPanel`, so
          // the two adjacent report tabs don't offer the same filter two ways.
          options={[
            { value: '', label: t('dashboard.sales.allOutlets') },
            ...locations.map((l) => ({ value: l.id, label: `${l.code} — ${l.name}` })),
          ]}
          wrapperClassName="w-full sm:w-72"
        />
      )}

      {/* Spend summary strip */}
      <section className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h3 className="text-sm font-semibold text-text-primary">
          {t('dashboard.marketing.spendTitle')}
        </h3>
        {channelLoading ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-16 animate-pulse rounded-lg bg-surface-sunken" />
            ))}
          </div>
        ) : channelErrorText ? (
          <p className="text-sm text-danger-600">{channelErrorText}</p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <Stat label={t('dashboard.marketing.statGross')} value={formatMoney(totalGross)} />
              <Stat
                label={t('dashboard.marketing.statDiscount')}
                value={formatMoney(totalDiscount)}
              />
              <Stat
                label={t('dashboard.marketing.statDiscountPct')}
                value={
                  discountPct === null
                    ? t('dashboard.marketing.noBasis')
                    : formatPercent(discountPct)
                }
              />
              <Stat
                label={t('dashboard.marketing.statPlatformFees')}
                value={formatMoney(totalFees)}
              />
              <Stat
                label={t('dashboard.marketing.statFeesPct')}
                value={feesPct === null ? t('dashboard.marketing.noBasis') : formatPercent(feesPct)}
              />
              <Stat label={t('dashboard.marketing.statNet')} value={formatMoney(totalNet)} />
            </div>
            {(discountPct === null || feesPct === null) && (
              <p className="text-xs text-text-muted">{t('dashboard.marketing.noBasisHint')}</p>
            )}
          </>
        )}
      </section>

      {/* Kinerja per Kanal */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {t('dashboard.marketing.channelTitle')}
            </h3>
            <p className="text-xs text-text-muted">{t('dashboard.marketing.channelDescription')}</p>
          </div>
          {canExport && (
            <ExportButton
              rows={channelExportRows}
              columns={channelIoColumns(t)}
              filenameBase={`marketing-channel-${from}-${to}`}
              pdfTitle={t('dashboard.marketing.exportChannelTitle', {
                scope: scopeLabel,
                from,
                to,
              })}
            />
          )}
        </div>
        <DataTable
          columns={channelColumns}
          data={{
            rows: channelExportRows,
            total: channelExportRows.length,
            page: 1,
            pageSize: Math.max(channelExportRows.length, 1),
          }}
          keyField={(r) => r.groupKey}
          loading={channelLoading}
          error={channelErrorText}
          emptyTitle={t('dashboard.marketing.channelEmpty')}
        />
      </section>

      {/* Produk Terlaris & Diskonnya */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {t('dashboard.marketing.productsTitle')}
            </h3>
            <p className="text-xs text-text-muted">
              {t('dashboard.marketing.productsDescription')}
            </p>
          </div>
          {canExport && (
            <ExportButton
              rows={productExportRows}
              columns={productIoColumns(t)}
              filenameBase={`marketing-produk-${from}-${to}`}
              pdfTitle={t('dashboard.marketing.exportProductsTitle', {
                scope: scopeLabel,
                from,
                to,
              })}
            />
          )}
        </div>
        <DataTable
          columns={productColumns}
          data={{
            rows: productExportRows,
            total: productExportRows.length,
            page: 1,
            pageSize: Math.max(productExportRows.length, 1),
          }}
          keyField={(r) => r.groupKey}
          loading={productLoading}
          error={productErrorText}
          emptyTitle={t('dashboard.marketing.productsEmpty')}
        />
      </section>

      {/* Rekonsiliasi Pesanan Online */}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h3 className="text-sm font-semibold text-text-primary">
              {t('dashboard.marketing.reconTitle')}
            </h3>
            <p className="text-xs text-text-muted">{t('dashboard.marketing.reconDescription')}</p>
          </div>
          {canExport && (
            <ExportButton
              rows={reconRows}
              columns={reconIoColumns(t)}
              filenameBase={`marketing-online-${from}-${to}`}
              pdfTitle={t('dashboard.marketing.exportReconTitle', { scope: scopeLabel, from, to })}
            />
          )}
        </div>
        <DataTable
          columns={reconColumns}
          data={{
            rows: reconRows,
            total: reconRows.length,
            page: 1,
            pageSize: Math.max(reconRows.length, 1),
          }}
          keyField={(r) => r.orderId}
          loading={reconLoading}
          error={reconErrorText}
          emptyTitle={t('dashboard.marketing.reconEmpty')}
          emptyDescription={
            !reconLoading && !reconErrorText ? t('dashboard.marketing.reconEmptyHint') : undefined
          }
        />
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface-raised p-3">
      <span className="text-xs text-text-secondary">{label}</span>
      <span className="font-display text-base font-semibold text-text-primary">{value}</span>
    </div>
  );
}
