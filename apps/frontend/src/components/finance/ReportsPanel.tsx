'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle, CalendarX, FileWarning, FileSearch } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/formatters';
import { toDateInput } from '@/lib/dates';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { Select } from '@/components/ui/Select';
import { DateRangePicker, type DateRangeValue } from '@/components/ui/DateRangePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { ExportButton } from '@/components/common/ExportButton';
import { sumMoney } from './lib/money';
import {
  trialBalanceIoColumns,
  profitLossIoColumns,
  profitLossExportRows,
  balanceSheetIoColumns,
  balanceSheetExportRows,
  stockValueIoColumns,
  stockValueExportRows,
} from './lib/io-columns';
import type {
  FiscalPeriod,
  TrialBalanceReport,
  ProfitLossReport,
  BalanceSheetReport,
  StockValueRow,
} from './types';
import { errMsg } from '@/lib/api-error';

/**
 * F07 finance — reports (CONTRACTS §4.17: trial balance, P&L, balance sheet,
 * stock value). Every reconciling total (`balanced` from the backend, or a
 * client-computed sum) is rendered with an explicit check/warning badge, not
 * just a number — "displays a plausible but wrong total" is the one failure
 * mode this ticket calls out as worse than not rendering at all.
 */
function BalanceIndicator({ balanced }: { balanced: boolean }) {
  const { t } = useI18n();
  return (
    <div
      className={`flex items-center gap-1.5 rounded-md border p-2.5 text-sm font-medium ${balanced ? 'border-success-200 bg-success-50 text-success-700' : 'border-danger-200 bg-danger-50 text-danger-700'}`}
    >
      {balanced ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
      {balanced ? t('finance.reports.balanced') : t('finance.reports.unbalanced')}
    </div>
  );
}

/**
 * Why every tab below tracks an `error` and renders it.
 *
 * These panels used to `.catch(() => setReport(null))` and then render
 * `{!loading && report && …}` — so a 403, a 500, or an empty fiscal-period
 * list all produced the SAME thing: a date picker above a blank page. The
 * owner read that (correctly) as "this seems not developed". A report that
 * cannot be produced has to say so, and say which reason: no period exists
 * yet, none is selected, the request failed, or the ledger genuinely has
 * nothing in range.
 */
function ReportError({ message }: { message: string }) {
  const { t } = useI18n();
  return (
    <EmptyState
      icon={FileWarning}
      title={t('finance.reports.loadError')}
      description={`${message} — ${t('finance.reports.loadErrorHint')}`}
      size="sm"
    />
  );
}

function TrialBalanceTab() {
  const { t } = useI18n();
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [periodCode, setPeriodCode] = useState('');
  const [report, setReport] = useState<TrialBalanceReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Distinguishes "no periods exist" from "periods not fetched yet" — the
  // difference between an actionable message and a misleading one.
  const [periodsLoaded, setPeriodsLoaded] = useState(false);

  useEffect(() => {
    api
      .get<FiscalPeriod[]>('/accounting/periods')
      .then((rows) => {
        setPeriods(rows);
        setPeriodCode((prev) => prev || rows[rows.length - 1]?.periodCode || '');
      })
      .catch((err: unknown) => setError(errMsg(err, t('finance.reports.loadError'))))
      .finally(() => setPeriodsLoaded(true));
  }, [t]);

  useEffect(() => {
    if (!periodCode) return;
    setLoading(true);
    setError(null);
    api
      .get<TrialBalanceReport>(
        `/accounting/trial-balance?periodCode=${encodeURIComponent(periodCode)}`,
      )
      .then(setReport)
      .catch((err: unknown) => {
        setReport(null);
        setError(errMsg(err, t('finance.reports.loadError')));
      })
      .finally(() => setLoading(false));
  }, [periodCode, t]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <Select
          label={t('finance.reports.period')}
          value={periodCode}
          onValueChange={setPeriodCode}
          placeholder={t('finance.reports.selectPeriod')}
          options={periods.map((p) => ({ value: p.periodCode, label: p.periodCode }))}
          // Wide enough for the PLACEHOLDER, not just for a "2026-08" period
          // code. At `w-48` the prompt was clipped mid-word ("Pilih periode
          // untuk me…"), which reads as a broken control rather than an
          // instruction — and this is the one control on the screen that has to
          // be understood before anything else renders.
          wrapperClassName="w-full sm:w-72"
          disabled={periods.length === 0}
        />
        {report && (
          <ExportButton
            rows={report.rows}
            columns={trialBalanceIoColumns(t)}
            filenameBase={`trial-balance-${periodCode}`}
            pdfTitle={`Neraca Saldo — ${periodCode}`}
          />
        )}
      </div>

      {loading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
      {!loading && error && <ReportError message={error} />}
      {!loading && !error && periodsLoaded && periods.length === 0 && (
        <EmptyState
          icon={CalendarX}
          title={t('finance.reports.noPeriods')}
          description={t('finance.reports.noPeriodsHint')}
          size="sm"
        />
      )}
      {!loading && !error && periods.length > 0 && !periodCode && (
        <EmptyState icon={FileSearch} title={t('finance.reports.selectPeriod')} size="sm" />
      )}
      {!loading && report && (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken">
                  <th className="px-3 py-2 text-left font-medium text-text-secondary">
                    {t('finance.reports.columnAccount')}
                  </th>
                  <th className="px-3 py-2 text-left font-medium text-text-secondary">
                    {t('finance.coa.columnType')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-text-secondary">
                    {t('finance.journal.lineDebit')}
                  </th>
                  <th className="px-3 py-2 text-right font-medium text-text-secondary">
                    {t('finance.journal.lineCredit')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.accountCode} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">
                      {r.accountCode} — {r.accountName}
                    </td>
                    <td className="px-3 py-2 text-text-muted">
                      {t(`finance.accountType.${r.type}`)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(r.debit, { cents: 'always' })}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatMoney(r.credit, { cents: 'always' })}
                    </td>
                  </tr>
                ))}
                {report.rows.length === 0 && (
                  <tr>
                    <td colSpan={4}>
                      <EmptyState title={t('finance.reports.empty')} size="sm" />
                    </td>
                  </tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-3 py-2" colSpan={2}>
                    {t('finance.journal.totals')}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(report.totalDebit, { cents: 'always' })}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatMoney(report.totalCredit, { cents: 'always' })}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
          <BalanceIndicator balanced={report.balanced} />
        </>
      )}
    </div>
  );
}

function ProfitLossTab() {
  const { t } = useI18n();
  const today = toDateInput(new Date());
  const [range, setRange] = useState<DateRangeValue>({ from: today, to: today });
  const [report, setReport] = useState<ProfitLossReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!range.from || !range.to) return;
    setLoading(true);
    setError(null);
    api
      .get<ProfitLossReport>(`/accounting/profit-loss?from=${range.from}&to=${range.to}`)
      .then(setReport)
      .catch((err: unknown) => {
        setReport(null);
        setError(errMsg(err, t('finance.reports.loadError')));
      })
      .finally(() => setLoading(false));
  }, [range.from, range.to, t]);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <DateRangePicker label={t('finance.reports.range')} value={range} onChange={setRange} />
        {report && (
          <ExportButton
            rows={profitLossExportRows(report)}
            columns={profitLossIoColumns(t)}
            filenameBase={`laba-rugi-${range.from}-${range.to}`}
            pdfTitle={`${t('finance.reports.tabs.profitLoss')} — ${range.from} – ${range.to}`}
          />
        )}
      </div>
      {loading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
      {!loading && error && <ReportError message={error} />}
      {!loading && !error && !report && (
        <EmptyState
          icon={FileSearch}
          title={t('finance.reports.empty')}
          description={t('finance.reports.emptyHint')}
          size="sm"
        />
      )}
      {!loading && report && (
        <div className="grid grid-cols-2 gap-4">
          <section className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('finance.reports.revenue')}
            </h3>
            {report.revenue.map((l) => (
              <div key={l.accountCode} className="flex justify-between text-sm">
                <span>{l.name}</span>
                <span className="tabular-nums">{formatMoney(l.amount, { cents: 'always' })}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold">
              <span>{t('finance.reports.totalRevenue')}</span>
              <span className="tabular-nums">
                {formatMoney(report.totalRevenue, { cents: 'always' })}
              </span>
            </div>
          </section>
          <section className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold text-text-primary">
              {t('finance.reports.expenses')}
            </h3>
            {report.expenses.map((l) => (
              <div key={l.accountCode} className="flex justify-between text-sm">
                <span>{l.name}</span>
                <span className="tabular-nums">{formatMoney(l.amount, { cents: 'always' })}</span>
              </div>
            ))}
            <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold">
              <span>{t('finance.reports.totalExpense')}</span>
              <span className="tabular-nums">
                {formatMoney(report.totalExpense, { cents: 'always' })}
              </span>
            </div>
          </section>
          <div className="col-span-2 flex items-center justify-between rounded-md border border-border bg-surface-sunken p-3 text-base font-semibold">
            <span>{t('finance.reports.netProfit')}</span>
            <span className="tabular-nums">
              {formatMoney(report.netProfit, { cents: 'always' })}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function BalanceSheetTab() {
  const { t } = useI18n();
  const [asOf, setAsOf] = useState(toDateInput(new Date()));
  const [report, setReport] = useState<BalanceSheetReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!asOf) return;
    setLoading(true);
    setError(null);
    api
      .get<BalanceSheetReport>(`/accounting/balance-sheet?asOf=${asOf}`)
      .then(setReport)
      .catch((err: unknown) => {
        setReport(null);
        setError(errMsg(err, t('finance.reports.loadError')));
      })
      .finally(() => setLoading(false));
  }, [asOf, t]);

  function section(title: string, lines: { accountCode: string; name: string; amount: string }[]) {
    const total = sumMoney(lines.map((l) => l.amount));
    return (
      <section className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {lines.map((l) => (
          <div key={l.accountCode} className="flex justify-between text-sm">
            <span>{l.name}</span>
            <span className="tabular-nums">{formatMoney(l.amount, { cents: 'always' })}</span>
          </div>
        ))}
        <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold">
          <span>{t('finance.reports.subtotal')}</span>
          <span className="tabular-nums">{formatMoney(total, { cents: 'always' })}</span>
        </div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <label className="flex w-56 flex-col gap-1.5">
          <span className="text-sm font-medium text-text-primary">{t('finance.reports.asOf')}</span>
          <input
            type="date"
            value={asOf}
            onChange={(e) => setAsOf(e.target.value)}
            className="rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary focus-visible:border-brand-500"
          />
        </label>
        {report && (
          <ExportButton
            rows={balanceSheetExportRows(report)}
            columns={balanceSheetIoColumns(t)}
            filenameBase={`neraca-${asOf}`}
            pdfTitle={`${t('finance.reports.tabs.balanceSheet')} — ${asOf}`}
          />
        )}
      </div>
      {loading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
      {!loading && error && <ReportError message={error} />}
      {!loading && !error && !report && (
        <EmptyState
          icon={FileSearch}
          title={t('finance.reports.empty')}
          description={t('finance.reports.emptyHint')}
          size="sm"
        />
      )}
      {!loading && report && (
        <>
          <div className="grid grid-cols-3 gap-4">
            {section(t('finance.reports.assets'), report.assets)}
            {section(t('finance.reports.liabilities'), report.liabilities)}
            {section(t('finance.reports.equity'), report.equity)}
          </div>
          <BalanceIndicator balanced={report.balanced} />
        </>
      )}
    </div>
  );
}

function StockValueTab() {
  const { t } = useI18n();
  const [rows, setRows] = useState<StockValueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api
      .get<StockValueRow[]>('/accounting/stock-value')
      .then(setRows)
      .catch((err: unknown) => {
        // NOT `setRows([])`: an empty warehouse and a failed request are
        // different facts and must not look alike.
        setRows(null);
        setError(errMsg(err, t('finance.reports.loadError')));
      })
      .finally(() => setLoading(false));
  }, [t]);

  if (loading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;
  if (error) return <ReportError message={error} />;
  if (!rows || rows.length === 0)
    return (
      <EmptyState
        icon={FileSearch}
        title={t('finance.reports.empty')}
        description={t('finance.reports.emptyHint')}
        size="sm"
      />
    );

  const grandTotal = sumMoney(rows.map((r) => r.value));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <ExportButton
          rows={stockValueExportRows(rows)}
          columns={stockValueIoColumns()}
          filenameBase="nilai-stok"
          pdfTitle={t('finance.reports.tabs.stockValue')}
        />
      </div>
      {rows.map((r) => (
        <section
          key={r.locationId}
          className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
        >
          <div className="flex justify-between text-sm font-semibold text-text-primary">
            <span>{r.locationName}</span>
            <span className="tabular-nums">{formatMoney(r.value, { cents: 'always' })}</span>
          </div>
          {r.byCategory.map((c) => (
            <div
              key={c.categoryName}
              className="flex justify-between pl-3 text-sm text-text-secondary"
            >
              <span>{c.categoryName}</span>
              <span className="tabular-nums">{formatMoney(c.value, { cents: 'always' })}</span>
            </div>
          ))}
        </section>
      ))}
      <div className="flex items-center justify-between rounded-md border border-border bg-surface-sunken p-3 text-base font-semibold">
        <span>{t('finance.reports.grandTotal')}</span>
        <span className="tabular-nums">{formatMoney(grandTotal, { cents: 'always' })}</span>
      </div>
    </div>
  );
}

export function ReportsPanel() {
  const { t } = useI18n();
  return (
    <Tabs defaultValue="trialBalance">
      <TabsList>
        <TabsTrigger value="trialBalance">{t('finance.reports.tabs.trialBalance')}</TabsTrigger>
        <TabsTrigger value="profitLoss">{t('finance.reports.tabs.profitLoss')}</TabsTrigger>
        <TabsTrigger value="balanceSheet">{t('finance.reports.tabs.balanceSheet')}</TabsTrigger>
        <TabsTrigger value="stockValue">{t('finance.reports.tabs.stockValue')}</TabsTrigger>
      </TabsList>
      <TabsContent value="trialBalance">
        <TrialBalanceTab />
      </TabsContent>
      <TabsContent value="profitLoss">
        <ProfitLossTab />
      </TabsContent>
      <TabsContent value="balanceSheet">
        <BalanceSheetTab />
      </TabsContent>
      <TabsContent value="stockValue">
        <StockValueTab />
      </TabsContent>
    </Tabs>
  );
}
