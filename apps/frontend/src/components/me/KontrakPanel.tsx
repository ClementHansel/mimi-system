'use client';

import { useEffect, useState } from 'react';
import { FileSignature, AlertTriangle, Download } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { Card, CardContent } from '@/components/ui/Card';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { EmptyState } from '@/components/ui/EmptyState';
import { getMyContracts, type EmploymentContract } from './lib/me-api';
import { errMsg } from '@/lib/api-error';

/**
 * "Kontrak" — the employee's own employment contracts (owner, 2026-08-21: the
 * `employee` interface covers "contracts and everything about themself").
 *
 * What this screen is FOR, in order: which contract am I on, when does it end,
 * and can I read the signed copy. So the current contract is rendered first and
 * largest, with the expiry countdown promoted to a warning when it is close —
 * an Indonesian PKWT that lapses unnoticed changes the employee's legal
 * standing, and they are the party with the most at stake in noticing.
 *
 * `daysUntilExpiry` comes from the SERVER (computed in WITA), never from the
 * device: a phone with a wrong clock must not be able to show an expired
 * contract as fine.
 *
 * Read-only, with no request-a-change affordance: a contract is a signed
 * agreement between two parties, not a form field. Questions go to Admin SDM,
 * which the footer says.
 */
const EXPIRY_WARNING_DAYS = 60;

export function KontrakPanel() {
  const { t } = useI18n();
  const [contracts, setContracts] = useState<EmploymentContract[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notAnEmployee, setNotAnEmployee] = useState(false);

  useEffect(() => {
    getMyContracts()
      .then(setContracts)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.statusCode === 404) setNotAnEmployee(true);
        else setError(errMsg(err, t('table.error')));
      })
      .finally(() => setLoading(false));
  }, [t]);

  if (loading) return <p className="p-2 text-sm text-text-muted">{t('common.loading')}</p>;

  if (notAnEmployee) {
    return (
      <EmptyState
        icon={FileSignature}
        title={t('me.profile.notEmployeeTitle')}
        description={t('me.profile.notEmployeeDescription')}
        size="sm"
      />
    );
  }

  if (error) return <EmptyState title={error} size="sm" />;

  if (!contracts || contracts.length === 0) {
    return (
      <EmptyState
        icon={FileSignature}
        title={t('me.kontrak.emptyTitle')}
        description={t('me.kontrak.emptyDescription')}
        size="sm"
      />
    );
  }

  // `listOwn` returns newest-first, so the first ACTIVE row is the one they are
  // on. Everything else is history and is rendered smaller below it.
  const current = contracts.find((c) => c.status === 'active') ?? contracts[0]!;
  const history = contracts.filter((c) => c.id !== current.id);

  return (
    <div className="flex flex-col gap-3">
      <ContractCard contract={current} primary />

      {history.length > 0 && (
        <>
          <p className="px-1 pt-1 text-xs font-semibold uppercase tracking-wide text-text-muted">
            {t('me.kontrak.history')}
          </p>
          {history.map((c) => (
            <ContractCard key={c.id} contract={c} />
          ))}
        </>
      )}

      <p className="px-1 text-xs text-text-muted">{t('me.kontrak.questionsHint')}</p>
    </div>
  );
}

function ContractCard({
  contract,
  primary = false,
}: {
  contract: EmploymentContract;
  primary?: boolean;
}) {
  const { t } = useI18n();
  const expiringSoon =
    contract.status === 'active' &&
    contract.daysUntilExpiry !== null &&
    contract.daysUntilExpiry <= EXPIRY_WARNING_DAYS;

  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="font-mono text-xs text-text-muted">{contract.contractNumber}</p>
            <p
              className={
                primary
                  ? 'font-display text-lg font-semibold text-text-primary'
                  : 'text-sm font-medium text-text-primary'
              }
            >
              {t(`me.kontrak.type.${contract.contractType}`)}
            </p>
            <p className="text-xs text-text-muted">{contract.position}</p>
          </div>
          <StatusBadge domain="contract" status={contract.status} size="sm" />
        </div>

        <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs">
          <dt className="text-text-muted">{t('me.kontrak.period')}</dt>
          <dd className="text-text-primary">
            {fmtDate(contract.startDate)} —{' '}
            {contract.endDate ? fmtDate(contract.endDate) : t('me.kontrak.noEndDate')}
          </dd>
          {contract.locationName && (
            <>
              <dt className="text-text-muted">{t('me.kontrak.location')}</dt>
              <dd className="text-text-primary">{contract.locationName}</dd>
            </>
          )}
          {contract.baseSalary && (
            <>
              <dt className="text-text-muted">{t('me.kontrak.baseSalary')}</dt>
              <dd className="tabular-nums text-text-primary">{formatMoney(contract.baseSalary)}</dd>
            </>
          )}
          {contract.signedAt && (
            <>
              <dt className="text-text-muted">{t('me.kontrak.signedAt')}</dt>
              <dd className="text-text-primary">{fmtDate(contract.signedAt)}</dd>
            </>
          )}
          {contract.terminationReason && (
            <>
              <dt className="text-text-muted">{t('me.kontrak.terminationReason')}</dt>
              <dd className="text-text-primary">{contract.terminationReason}</dd>
            </>
          )}
        </dl>

        {expiringSoon && (
          // Promoted to a warning rather than left as a number in a table: the
          // employee is the party with the most at stake in noticing.
          <p className="flex items-start gap-1.5 rounded-md bg-warning-50 px-2.5 py-2 text-xs text-warning-700">
            <AlertTriangle className="mt-0.5 size-3.5 flex-none" aria-hidden />
            <span>
              {contract.daysUntilExpiry! >= 0
                ? t('me.kontrak.expiringIn', { days: contract.daysUntilExpiry! })
                : t('me.kontrak.expiredAgo', { days: Math.abs(contract.daysUntilExpiry!) })}
            </span>
          </p>
        )}

        {contract.documentAttachmentId && (
          <a
            href={`/api/attachments/${contract.documentAttachmentId}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-touch items-center gap-1.5 self-start text-sm font-medium text-brand-600 hover:underline"
          >
            <Download className="size-4" aria-hidden />
            {t('me.kontrak.viewDocument')}
          </a>
        )}
      </CardContent>
    </Card>
  );
}
