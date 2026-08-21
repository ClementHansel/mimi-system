'use client';

import { useEffect, useState } from 'react';
import { HandCoins, Plus } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { formatMoney } from '@/lib/formatters';
import { toast } from '@/components/ui/Toast';
import { Button } from '@/components/ui/Button';
import { Card, CardContent } from '@/components/ui/Card';
import { Modal } from '@/components/ui/Modal';
import { MoneyInput } from '@/components/ui/MoneyInput';
import { Textarea } from '@/components/ui/Textarea';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { getMyLoans, requestMyLoan, type MyLoan } from './lib/me-api';
import type { Money } from '@/lib/shared-types';

/**
 * "Pinjaman" (kasbon) — the employee's own loans, and the form to ask for one
 * (owner, 2026-08-21: the `employee` interface covers "loan req").
 *
 * The request goes to `POST /payroll/loans/me`, which takes the borrower from
 * the session and submits the SAME Finance -> Manager approval chain the
 * office's own `POST /payroll/loans` uses. Nothing here shortcuts approval: a
 * request lands `pending` and the person who asked cannot advance it.
 *
 * `outstanding` is the number people actually come here for — "how much do I
 * still owe" — so it is the figure shown large on each card, with the principal
 * and the monthly deduction underneath as context.
 */
function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export function PinjamanPanel() {
  const { t } = useI18n();
  const [loans, setLoans] = useState<MyLoan[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notAnEmployee, setNotAnEmployee] = useState(false);
  const [requestOpen, setRequestOpen] = useState(false);

  function load() {
    setLoading(true);
    setError(null);
    getMyLoans()
      .then((r) => setLoans(r.rows))
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.statusCode === 404) setNotAnEmployee(true);
        else setError(errMsg(err, t('table.error')));
      })
      .finally(() => setLoading(false));
  }
  useEffect(load, [t]);

  if (loading) return <p className="p-2 text-sm text-text-muted">{t('common.loading')}</p>;

  if (notAnEmployee) {
    return (
      <EmptyState
        icon={HandCoins}
        title={t('me.profile.notEmployeeTitle')}
        description={t('me.profile.notEmployeeDescription')}
        size="sm"
      />
    );
  }

  // An `active` loan is money still owed; `pending` is a request in flight.
  // Both are worth a total, and they must not be added together — one is debt,
  // the other is a hope.
  const active = (loans ?? []).filter((l) => l.status === 'active');
  const totalOutstanding = active.reduce((sum, l) => sum + Number(l.outstanding), 0);

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-sm text-danger-600">{error}</p>}

      {active.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-0.5 p-4">
            <p className="text-xs text-text-muted">{t('me.pinjaman.totalOutstanding')}</p>
            <p className="font-display text-2xl font-bold tabular-nums text-text-primary">
              {formatMoney(String(totalOutstanding) as Money)}
            </p>
            <p className="text-xs text-text-muted">
              {t('me.pinjaman.activeCount', { count: active.length })}
            </p>
          </CardContent>
        </Card>
      )}

      <Button
        size="touch"
        leftIcon={<Plus className="size-4" />}
        onClick={() => setRequestOpen(true)}
        className="self-stretch"
      >
        {t('me.pinjaman.requestButton')}
      </Button>

      {(loans ?? []).length === 0 && !error && (
        <EmptyState
          icon={HandCoins}
          title={t('me.pinjaman.emptyTitle')}
          description={t('me.pinjaman.emptyDescription')}
          size="sm"
        />
      )}

      {(loans ?? []).map((loan) => (
        <Card key={loan.id}>
          <CardContent className="flex flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="font-mono text-xs text-text-muted">{loan.loanNumber}</p>
                <p className="font-display text-xl font-semibold tabular-nums text-text-primary">
                  {formatMoney(loan.outstanding)}
                </p>
                <p className="text-xs text-text-muted">{t('me.pinjaman.outstanding')}</p>
              </div>
              <StatusBadge domain="loan" status={loan.status} size="sm" />
            </div>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
              <dt className="text-text-muted">{t('me.pinjaman.principal')}</dt>
              <dd className="tabular-nums text-text-primary">{formatMoney(loan.principal)}</dd>
              <dt className="text-text-muted">{t('me.pinjaman.installment')}</dt>
              <dd className="tabular-nums text-text-primary">
                {formatMoney(loan.monthlyInstallment)}
              </dd>
            </dl>
          </CardContent>
        </Card>
      ))}

      {requestOpen && (
        <RequestLoanModal
          onClose={() => setRequestOpen(false)}
          onCreated={() => {
            setRequestOpen(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function RequestLoanModal({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const { t } = useI18n();
  const [principal, setPrincipal] = useState<Money | null>(null);
  const [installment, setInstallment] = useState<Money | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A reason is required, not polite: the approver is deciding on somebody's
  // household emergency and an unexplained figure is unapprovable.
  const canSubmit = !!principal && !!installment && reason.trim().length > 0 && !busy;

  async function submit() {
    if (!canSubmit) {
      setError(t('validation.required'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await requestMyLoan({
        principal: principal!,
        monthlyInstallment: installment!,
        reason: reason.trim(),
      });
      toast({ title: t('me.pinjaman.requestSuccess'), variant: 'success' });
      onCreated();
    } catch (err) {
      setError(errMsg(err, t('auth.genericError')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('me.pinjaman.requestTitle')}
      description={t('me.pinjaman.requestDescription')}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!canSubmit}>
            {t('common.submit')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <MoneyInput
          label={t('me.pinjaman.principal')}
          value={principal}
          onChange={setPrincipal}
          required
        />
        <MoneyInput
          label={t('me.pinjaman.installment')}
          value={installment}
          onChange={setInstallment}
          hint={t('me.pinjaman.installmentHint')}
          required
        />
        <Textarea
          label={t('me.pinjaman.reason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={t('me.pinjaman.reasonPlaceholder')}
          required
        />
      </div>
    </Modal>
  );
}
