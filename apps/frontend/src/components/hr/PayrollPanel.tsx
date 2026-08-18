'use client';

import { useEffect, useState } from 'react';
import { Play, Send } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardContent,
  Input,
  StatusBadge,
  ApprovalTimeline,
  PermissionGate,
  EmptyState,
} from '@/components/ui';
import { usePermissions } from '@/lib/permissions';
import { formatMoney } from '@/lib/formatters';
import {
  approvePayrollRun,
  calculatePayrollRun,
  createPayrollPeriod,
  getPayrollRun,
  listPayrollPeriods,
  rejectPayrollRun,
  sendPayrollSlips,
  submitPayrollRun,
} from './lib/hr-api';
import type { PayrollPeriod, PayrollRunDetail } from './lib/types';

/**
 * F08 `hr` — payroll runs (§4.15, PIN/POUT-*): calculate → review lines →
 * submit → approve (Finance → Owner, §5.7) → mark paid → send slips.
 * Statutory rate configuration lives in `StatutoryRatesPanel`; this panel
 * only reads `run.statutoryMode` to know whether a run computed statutory
 * lines, never edits the rate tables itself.
 */
export function PayrollPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [periods, setPeriods] = useState<PayrollPeriod[]>([]);
  const [periodCode, setPeriodCode] = useState('');
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [run, setRun] = useState<PayrollRunDetail | null>(null);
  const [runLoading, setRunLoading] = useState(false);
  const [busy, setBusy] = useState(false);

  function reloadPeriods() {
    setLoading(true);
    listPayrollPeriods()
      .then((res) => setPeriods(res.rows))
      .finally(() => setLoading(false));
  }
  useEffect(reloadPeriods, []);

  useEffect(() => {
    if (!selectedRunId) {
      setRun(null);
      return;
    }
    setRunLoading(true);
    getPayrollRun(selectedRunId)
      .then(setRun)
      .finally(() => setRunLoading(false));
  }, [selectedRunId]);

  async function startPeriod() {
    if (!periodCode) return;
    setCreating(true);
    try {
      const period = await createPayrollPeriod(periodCode);
      const calculated = await calculatePayrollRun(period.id);
      toast({ title: t('hr.payroll.calculateSuccess'), variant: 'success' });
      setPeriodCode('');
      reloadPeriods();
      setSelectedRunId(calculated.id);
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setCreating(false);
    }
  }

  async function calculateForPeriod(period: PayrollPeriod) {
    setBusy(true);
    try {
      const calculated = await calculatePayrollRun(period.id);
      toast({ title: t('hr.payroll.calculateSuccess'), variant: 'success' });
      reloadPeriods();
      setSelectedRunId(calculated.id);
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  async function act(action: () => Promise<unknown>, successKey: string) {
    if (!run) return;
    setBusy(true);
    try {
      await action();
      toast({ title: t(successKey), variant: 'success' });
      const refreshed = await getPayrollRun(run.id);
      setRun(refreshed);
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <PermissionGate permission="payroll.run.calculate">
        <Card>
          <CardContent className="flex flex-wrap items-end gap-3">
            <Input
              label={t('hr.payroll.newPeriod')}
              placeholder="YYYY-MM"
              value={periodCode}
              onChange={(e) => setPeriodCode(e.target.value)}
              wrapperClassName="w-40"
            />
            <Button
              leftIcon={<Play className="size-4" />}
              onClick={startPeriod}
              loading={creating}
              disabled={!periodCode}
            >
              {t('hr.payroll.calculateButton')}
            </Button>
          </CardContent>
        </Card>
      </PermissionGate>

      {loading ? (
        <div className="h-24 animate-pulse rounded-md bg-surface-sunken" />
      ) : periods.length === 0 ? (
        <EmptyState title={t('hr.payroll.noPeriods')} size="sm" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                <th className="px-3 py-2">{t('hr.payroll.columnPeriod')}</th>
                <th className="px-3 py-2">{t('hr.payroll.columnRuns')}</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.id} className="border-b border-border last:border-0 align-top">
                  <td className="px-3 py-2.5 font-medium text-text-primary">{p.periodCode}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-2">
                      {p.runs.map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setSelectedRunId(r.id)}
                          className="rounded-md border border-border-strong px-2 py-1 hover:bg-surface-sunken"
                        >
                          <span className="mr-1.5">{r.runNumber}</span>
                          <StatusBadge domain="payrollRun" status={r.status} size="sm" />
                        </button>
                      ))}
                      {p.runs.length === 0 && can('payroll.run.calculate') && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => calculateForPeriod(p)}
                          loading={busy}
                        >
                          {t('hr.payroll.calculateButton')}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedRunId && (
        <Card>
          <CardHeader>
            <CardTitle>{t('hr.payroll.runDetailTitle')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {runLoading || !run ? (
              <div className="h-40 animate-pulse rounded-md bg-surface-sunken" />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-medium text-text-primary">{run.runNumber}</span>
                  <StatusBadge domain="payrollRun" status={run.status} />
                  {run.statutoryMode && (
                    <span className="text-xs text-text-muted">
                      {t('hr.payroll.statutoryModeOn')}
                    </span>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                  <Stat label={t('hr.payroll.employeeCount')} value={String(run.employeeCount)} />
                  <Stat label={t('hr.payroll.totalGross')} value={formatMoney(run.totalGross)} />
                  <Stat
                    label={t('hr.payroll.totalDeductions')}
                    value={formatMoney(run.totalDeductions)}
                  />
                  <Stat label={t('hr.payroll.totalNet')} value={formatMoney(run.totalNet)} />
                </div>

                <div className="overflow-x-auto rounded-lg border border-border">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                        <th className="px-3 py-2">{t('hr.payroll.columnEmployee')}</th>
                        <th className="px-3 py-2 text-right">{t('hr.payroll.columnGross')}</th>
                        <th className="px-3 py-2 text-right">{t('hr.payroll.columnDeductions')}</th>
                        <th className="px-3 py-2 text-right">{t('hr.payroll.columnNet')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {run.employees.map((p) => (
                        <tr key={p.employee.id} className="border-b border-border last:border-0">
                          <td className="px-3 py-2.5 font-medium text-text-primary">
                            {p.employee.name}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatMoney(p.gross)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatMoney(p.deductions)}
                          </td>
                          <td className="px-3 py-2.5 text-right tabular-nums">
                            {formatMoney(p.net)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {run.approval && (
                  <div>
                    <h4 className="mb-2 text-sm font-medium text-text-primary">
                      {t('hr.payroll.approvalTitle')}
                    </h4>
                    <ApprovalTimeline steps={run.approval.steps} />
                  </div>
                )}

                <div className="flex flex-wrap gap-2">
                  <PermissionGate permission="payroll.run.calculate">
                    {run.status === 'calculated' && (
                      <Button
                        variant="outline"
                        onClick={() =>
                          act(() => submitPayrollRun(run.id), 'hr.payroll.submitSuccess')
                        }
                        loading={busy}
                      >
                        {t('hr.payroll.submitButton')}
                      </Button>
                    )}
                  </PermissionGate>
                  <PermissionGate permission="payroll.run.approve">
                    {run.status === 'pending_approval' && (
                      <>
                        <Button
                          onClick={() =>
                            act(() => approvePayrollRun(run.id), 'hr.payroll.approveSuccess')
                          }
                          loading={busy}
                        >
                          {t('common.approve')}
                        </Button>
                        <Button
                          variant="outline"
                          onClick={() =>
                            act(
                              () => rejectPayrollRun(run.id, t('hr.payroll.defaultRejectReason')),
                              'hr.payroll.rejectSuccess',
                            )
                          }
                          loading={busy}
                        >
                          {t('common.reject')}
                        </Button>
                      </>
                    )}
                  </PermissionGate>
                  <PermissionGate permission="payroll.slip.send">
                    {run.status === 'approved' && (
                      <Button
                        leftIcon={<Send className="size-4" />}
                        onClick={() =>
                          act(
                            () => sendPayrollSlips(run.id, ['email', 'whatsapp']),
                            'hr.payroll.sendSlipsSuccess',
                          )
                        }
                        loading={busy}
                      >
                        {t('hr.payroll.sendSlipsButton')}
                      </Button>
                    )}
                  </PermissionGate>
                  <PermissionGate permission="payroll.run.pay">
                    {run.status === 'approved' && (
                      <p className="self-center text-sm text-text-muted">
                        {t('hr.payroll.markPaidHint')}
                      </p>
                    )}
                  </PermissionGate>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface-sunken p-3">
      <p className="text-xs text-text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-text-primary">{value}</p>
    </div>
  );
}

// mark-paid (`POST /payroll/runs/:id/mark-paid`) is intentionally not wired
// to a bare button here — CONTRACTS §4.15 requires a `paymentVerificationId`
// (created by the approve step's journal posting), which is finance's
// payment-verification queue (F09, out of this ticket's scope) to select
// from; this panel surfaces the hint above instead of inventing an ID picker
// for a screen it doesn't own.
