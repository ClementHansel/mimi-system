'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { formatMoney } from '@/lib/formatters';
import { toDateInput } from '@/lib/dates';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { Select } from '@/components/ui/Select';
import { DateRangePicker, type DateRangeValue } from '@/components/ui/DateRangePicker';
import { EmptyState } from '@/components/ui/EmptyState';
import { sumMoney } from './lib/money';
import type {
  FiscalPeriodRow, TrialBalanceReport, ProfitLossReport, BalanceSheetReport, StockValueRow,
} from './types';

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
    <div className={`flex items-center gap-1.5 rounded-md border p-2.5 text-sm font-medium ${balanced ? 'border-success-200 bg-success-50 text-success-700' : 'border-danger-200 bg-danger-50 text-danger-700'}`}>
      {balanced ? <CheckCircle2 className="size-4" /> : <AlertTriangle className="size-4" />}
      {balanced ? t('finance.reports.balanced') : t('finance.reports.unbalanced')}
    </div>
  );
}

function TrialBalanceTab() {
  const { t } = useI18n();
  const [periods, setPeriods] = useState<FiscalPeriodRow[]>([]);
  const [periodCode, setPeriodCode] = useState('');
  const [report, setReport] = useState<TrialBalanceReport | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get<FiscalPeriodRow[]>('/accounting/periods').then((rows) => {
      setPeriods(rows);
      setPeriodCode((prev) => prev || rows[rows.length - 1]?.period_code || '');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (!periodCode) return;
    setLoading(true);
    api.get<TrialBalanceReport>(`/accounting/trial-balance?periodCode=${encodeURIComponent(periodCode)}`)
      .then(setReport)
      .catch(() => setReport(null))
      .finally(() => setLoading(false));
  }, [periodCode]);

  return (
    <div className="flex flex-col gap-4">
      <Select label={t('finance.reports.period')} value={periodCode} onValueChange={setPeriodCode}
        options={periods.map((p) => ({ value: p.period_code, label: p.period_code }))} wrapperClassName="w-48" />

      {loading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
      {!loading && report && (
        <>
          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-border bg-surface-sunken">
                  <th className="px-3 py-2 text-left font-medium text-text-secondary">{t('finance.reports.columnAccount')}</th>
                  <th className="px-3 py-2 text-left font-medium text-text-secondary">{t('finance.coa.columnType')}</th>
                  <th className="px-3 py-2 text-right font-medium text-text-secondary">{t('finance.journal.lineDebit')}</th>
                  <th className="px-3 py-2 text-right font-medium text-text-secondary">{t('finance.journal.lineCredit')}</th>
                </tr>
              </thead>
              <tbody>
                {report.rows.map((r) => (
                  <tr key={r.accountCode} className="border-b border-border last:border-0">
                    <td className="px-3 py-2">{r.accountCode} — {r.accountName}</td>
                    <td className="px-3 py-2 text-text-muted">{t(`finance.accountType.${r.type}`)}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.debit, { cents: 'always' })}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.credit, { cents: 'always' })}</td>
                  </tr>
                ))}
                {report.rows.length === 0 && (
                  <tr><td colSpan={4}><EmptyState title={t('finance.reports.empty')} size="sm" /></td></tr>
                )}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-border font-semibold">
                  <td className="px-3 py-2" colSpan={2}>{t('finance.journal.totals')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(report.totalDebit, { cents: 'always' })}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(report.totalCredit, { cents: 'always' })}</td>
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

  useEffect(() => {
    if (!range.from || !range.to) return;
    setLoading(true);
    api.get<ProfitLossReport>(`/accounting/profit-loss?from=${range.from}&to=${range.to}`)
      .then(setReport).catch(() => setReport(null)).finally(() => setLoading(false));
  }, [range.from, range.to]);

  return (
    <div className="flex flex-col gap-4">
      <DateRangePicker label={t('finance.reports.range')} value={range} onChange={setRange} />
      {loading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
      {!loading && report && (
        <div className="grid grid-cols-2 gap-4">
          <section className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold text-text-primary">{t('finance.reports.revenue')}</h3>
            {report.revenue.map((l) => (
              <div key={l.accountCode} className="flex justify-between text-sm"><span>{l.name}</span><span className="tabular-nums">{formatMoney(l.amount, { cents: 'always' })}</span></div>
            ))}
            <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold"><span>{t('finance.reports.totalRevenue')}</span><span className="tabular-nums">{formatMoney(report.totalRevenue, { cents: 'always' })}</span></div>
          </section>
          <section className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
            <h3 className="text-sm font-semibold text-text-primary">{t('finance.reports.expenses')}</h3>
            {report.expenses.map((l) => (
              <div key={l.accountCode} className="flex justify-between text-sm"><span>{l.name}</span><span className="tabular-nums">{formatMoney(l.amount, { cents: 'always' })}</span></div>
            ))}
            <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold"><span>{t('finance.reports.totalExpense')}</span><span className="tabular-nums">{formatMoney(report.totalExpense, { cents: 'always' })}</span></div>
          </section>
          <div className="col-span-2 flex items-center justify-between rounded-md border border-border bg-surface-sunken p-3 text-base font-semibold">
            <span>{t('finance.reports.netProfit')}</span>
            <span className="tabular-nums">{formatMoney(report.netProfit, { cents: 'always' })}</span>
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

  useEffect(() => {
    if (!asOf) return;
    setLoading(true);
    api.get<BalanceSheetReport>(`/accounting/balance-sheet?asOf=${asOf}`)
      .then(setReport).catch(() => setReport(null)).finally(() => setLoading(false));
  }, [asOf]);

  function section(title: string, lines: { accountCode: string; name: string; amount: string }[]) {
    const total = sumMoney(lines.map((l) => l.amount));
    return (
      <section className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
        <h3 className="text-sm font-semibold text-text-primary">{title}</h3>
        {lines.map((l) => (
          <div key={l.accountCode} className="flex justify-between text-sm"><span>{l.name}</span><span className="tabular-nums">{formatMoney(l.amount, { cents: 'always' })}</span></div>
        ))}
        <div className="flex justify-between border-t border-border pt-1.5 text-sm font-semibold"><span>{t('finance.reports.subtotal')}</span><span className="tabular-nums">{formatMoney(total, { cents: 'always' })}</span></div>
      </section>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <label className="flex w-56 flex-col gap-1.5">
        <span className="text-sm font-medium text-text-primary">{t('finance.reports.asOf')}</span>
        <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} className="rounded-md border border-border-strong bg-surface-raised px-3 py-2 text-sm text-text-primary focus-visible:border-brand-500" />
      </label>
      {loading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}
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

  useEffect(() => {
    setLoading(true);
    api.get<StockValueRow[]>('/accounting/stock-value').then(setRows).catch(() => setRows([])).finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;
  if (!rows || rows.length === 0) return <EmptyState title={t('finance.reports.empty')} size="sm" />;

  const grandTotal = sumMoney(rows.map((r) => r.value));

  return (
    <div className="flex flex-col gap-4">
      {rows.map((r) => (
        <section key={r.locationId} className="flex flex-col gap-1.5 rounded-lg border border-border p-3">
          <div className="flex justify-between text-sm font-semibold text-text-primary">
            <span>{r.locationName}</span>
            <span className="tabular-nums">{formatMoney(r.value, { cents: 'always' })}</span>
          </div>
          {r.byCategory.map((c) => (
            <div key={c.categoryName} className="flex justify-between pl-3 text-sm text-text-secondary">
              <span>{c.categoryName}</span><span className="tabular-nums">{formatMoney(c.value, { cents: 'always' })}</span>
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
      <TabsContent value="trialBalance"><TrialBalanceTab /></TabsContent>
      <TabsContent value="profitLoss"><ProfitLossTab /></TabsContent>
      <TabsContent value="balanceSheet"><BalanceSheetTab /></TabsContent>
      <TabsContent value="stockValue"><StockValueTab /></TabsContent>
    </Tabs>
  );
}
