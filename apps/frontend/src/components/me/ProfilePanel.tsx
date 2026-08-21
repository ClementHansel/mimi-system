'use client';

import { useEffect, useState } from 'react';
import { UserCircle, Building2, CalendarDays, Landmark } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { Card, CardContent } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { useSessionStore } from '@/stores/session-store';
import { getMyEmployee, type EmployeeDetail } from './lib/me-api';

/**
 * "Data Pribadi" — the employee's own record, in the `employee` interface
 * (owner, 2026-08-21: "their own personal data ... and everything about
 * themself").
 *
 * Read-only on purpose. A payroll/HR record is not a profile page: NIK, join
 * date, position and bank account all feed pay (join date drives tunjangan masa
 * kerja, position drives tunjangan jabatan, the bank account is where the money
 * lands), so a self-service edit would be an unaudited change to somebody's
 * wages. Getting a correction made goes through Admin SDM — which is what the
 * footer says, rather than leaving the user wondering why nothing is editable.
 *
 * MOBILE-FIRST like the rest of `/me`: stacked cards, no table, big enough to
 * read at arm's length in a car park at 6am (NFR-04).
 */
export function ProfilePanel() {
  const { t } = useI18n();
  const user = useSessionStore((s) => s.user);
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notAnEmployee, setNotAnEmployee] = useState(false);

  useEffect(() => {
    getMyEmployee()
      .then(setEmployee)
      .catch((err: unknown) => {
        // A login without an `employees` row is a real configuration (a shared
        // POS account, a service user), not a failure — so it gets its own
        // message instead of a generic error.
        if (err instanceof ApiError && err.statusCode === 404) setNotAnEmployee(true);
        else setError(err instanceof ApiError ? err.message : t('table.error'));
      })
      .finally(() => setLoading(false));
  }, [t]);

  if (loading) return <p className="p-2 text-sm text-text-muted">{t('common.loading')}</p>;

  if (notAnEmployee) {
    return (
      <EmptyState
        icon={UserCircle}
        title={t('me.profile.notEmployeeTitle')}
        description={t('me.profile.notEmployeeDescription')}
        size="sm"
      />
    );
  }

  if (error || !employee) {
    return <EmptyState title={error ?? t('table.error')} size="sm" />;
  }

  const current = employee.employments[0] ?? null;

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <div className="flex items-center gap-3">
            <span className="flex size-12 flex-none items-center justify-center rounded-full bg-brand-50 font-display text-lg font-bold text-brand-700">
              {employee.name.slice(0, 2).toUpperCase()}
            </span>
            <div className="min-w-0">
              <p className="truncate font-display text-lg font-semibold text-text-primary">
                {employee.name}
              </p>
              <p className="text-sm text-text-muted">
                {employee.position} · {employee.employeeNumber}
              </p>
            </div>
          </div>
          <StatusBadge
            domain="employment"
            status={employee.employmentStatus}
            size="sm"
            className="self-start"
          />
        </CardContent>
      </Card>

      <Field
        icon={Building2}
        label={t('me.profile.location')}
        value={employee.locationName}
        hint={user ? t(`role.${user.roleKey}`) : undefined}
      />
      <Field
        icon={CalendarDays}
        label={t('me.profile.joinDate')}
        value={fmtDate(employee.joinDate)}
      />
      <Field icon={UserCircle} label={t('me.profile.nik')} value={employee.nik ?? '—'} />
      <Field icon={UserCircle} label={t('me.profile.phone')} value={employee.phone ?? '—'} />
      <Field icon={UserCircle} label={t('me.profile.email')} value={employee.email ?? '—'} />

      {current?.baseSalary && (
        <Field
          icon={Landmark}
          label={t('me.profile.baseSalary')}
          value={formatMoney(current.baseSalary)}
          hint={t('me.profile.baseSalaryHint')}
        />
      )}

      {employee.employments.length > 0 && (
        <Card>
          <CardContent className="flex flex-col gap-2 p-4">
            <p className="text-sm font-semibold text-text-primary">
              {t('me.profile.employmentHistory')}
            </p>
            <ol className="flex flex-col gap-2">
              {employee.employments.map((e, i) => (
                <li key={`${e.startDate}-${i}`} className="border-l-2 border-border pl-3">
                  <p className="text-sm text-text-primary">{e.position}</p>
                  <p className="text-xs text-text-muted">
                    {e.locationName} · {fmtDate(e.startDate)} —{' '}
                    {e.endDate ? fmtDate(e.endDate) : t('me.profile.present')}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}

      <p className="px-1 text-xs text-text-muted">{t('me.profile.correctionHint')}</p>
    </div>
  );
}

function Field({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof UserCircle;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="flex items-start gap-3 p-4">
        <Icon className="size-5 flex-none text-text-muted" aria-hidden />
        <div className="min-w-0">
          <p className="text-xs text-text-muted">{label}</p>
          <p className="break-words text-sm font-medium text-text-primary">{value}</p>
          {hint && <p className="mt-0.5 text-xs text-text-muted">{hint}</p>}
        </div>
      </CardContent>
    </Card>
  );
}
