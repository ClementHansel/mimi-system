'use client';

import { useEffect, useState } from 'react';
import { Lock, Unlock } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtDate, fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Textarea } from '@/components/ui/Textarea';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { ExportButton } from '@/components/common/ExportButton';
import { fiscalPeriodIoColumns } from './lib/io-columns';
import type { FiscalPeriod } from './types';
import { errMsg } from '@/lib/api-error';

export function FiscalPeriodsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [periods, setPeriods] = useState<FiscalPeriod[]>([]);
  const [loading, setLoading] = useState(true);
  const [action, setAction] = useState<{
    kind: 'close' | 'reopen';
    period: FiscalPeriod;
  } | null>(null);

  function reload() {
    setLoading(true);
    api
      .get<FiscalPeriod[]>('/accounting/periods')
      .then(setPeriods)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  if (loading) return <p className="text-sm text-text-muted">{t('common.loading')}</p>;
  if (periods.length === 0) return <EmptyState title={t('finance.periods.empty')} size="sm" />;

  return (
    <div className="flex flex-col gap-3">
      {/* Export only, deliberately — no `MasterDataIo` here. Opening/closing/
          reopening a period is a guarded state transition
          (`POST /accounting/periods/:id/close|reopen`) that walks every
          journal entry in range; a CSV importer would let a spreadsheet row
          silently reopen a locked period, which is exactly what CONTRACTS
          §4.17's period lock exists to prevent. */}
      <div className="flex justify-end">
        <ExportButton
          rows={periods}
          columns={fiscalPeriodIoColumns(t)}
          filenameBase="periode-fiskal"
        />
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-border bg-surface-sunken">
              <th className="px-3 py-2.5 text-left font-medium text-text-secondary">
                {t('finance.periods.columnCode')}
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-text-secondary">
                {t('finance.periods.columnRange')}
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-text-secondary">
                {t('finance.periods.columnStatus')}
              </th>
              <th className="px-3 py-2.5 text-left font-medium text-text-secondary">
                {t('finance.periods.columnClosedAt')}
              </th>
              <th className="px-3 py-2.5 text-right font-medium text-text-secondary">
                {t('common.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2.5 font-medium text-text-primary">{p.periodCode}</td>
                <td className="px-3 py-2.5 text-text-secondary">
                  {fmtDate(p.startDate)} – {fmtDate(p.endDate)}
                </td>
                <td className="px-3 py-2.5">
                  <StatusBadge domain="fiscalPeriod" status={p.status} />
                </td>
                <td className="px-3 py-2.5 text-text-secondary">
                  {p.closedAt ? fmtDateTime(p.closedAt) : '—'}
                </td>
                <td className="px-3 py-2.5 text-right">
                  {can('accounting.period.close') && p.status === 'open' && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Lock className="size-3.5" />}
                      onClick={() => setAction({ kind: 'close', period: p })}
                    >
                      {t('finance.periods.closeButton')}
                    </Button>
                  )}
                  {can('accounting.period.close') && p.status === 'closed' && (
                    <Button
                      size="sm"
                      variant="outline"
                      leftIcon={<Unlock className="size-3.5" />}
                      onClick={() => setAction({ kind: 'reopen', period: p })}
                    >
                      {t('finance.periods.reopenButton')}
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {action && (
        <PeriodActionModal
          kind={action.kind}
          period={action.period}
          onClose={() => setAction(null)}
          onDone={() => {
            setAction(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function PeriodActionModal({
  kind,
  period,
  onClose,
  onDone,
}: {
  kind: 'close' | 'reopen';
  period: FiscalPeriod;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (kind === 'close')
        await api.post(`/accounting/periods/${period.id}/close`, { note: text || undefined });
      else await api.post(`/accounting/periods/${period.id}/reopen`, { reason: text });
      toast({
        title: t(
          kind === 'close' ? 'finance.periods.closeSuccess' : 'finance.periods.reopenSuccess',
        ),
        variant: 'success',
      });
      onDone();
    } catch (err) {
      setError(errMsg(err, t('errors.generic')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t(kind === 'close' ? 'finance.periods.closeTitle' : 'finance.periods.reopenTitle', {
        period: period.periodCode,
      })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            variant={kind === 'reopen' ? 'danger' : 'primary'}
            onClick={submit}
            loading={busy}
            disabled={kind === 'reopen' && !text}
          >
            {t(kind === 'close' ? 'finance.periods.closeButton' : 'finance.periods.reopenButton')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <Textarea
          label={t(kind === 'close' ? 'finance.periods.closeNote' : 'finance.periods.reopenReason')}
          value={text}
          onChange={(e) => setText(e.target.value)}
          required={kind === 'reopen'}
        />
      </div>
    </Modal>
  );
}
