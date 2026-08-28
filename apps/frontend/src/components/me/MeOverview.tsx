'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CalendarPlus,
  FileSignature,
  FileText,
  HandCoins,
  QrCode,
  UserCircle,
  type LucideIcon,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import { Card, CardContent, CardHeader, CardTitle, EmptyState } from '@/components/ui';
import { formatMoney, formatNumber } from '@/lib/formatters';
import { fmtDate } from '@/lib/dates';
import type { AttendanceRow, Leave, Payslip } from '@/components/hr/lib/types';
import { getMyAttendance, getMyLeaves, getMyLoans, getMySlips, type MyLoan } from './lib/me-api';

/**
 * `/me` — the employee interface's landing screen (owner, 2026-08-27: "page
 * akun saya should show personal analytics").
 *
 * The six own-data surfaces this page used to hold as tabs (Absen, Slip Gaji,
 * Cuti, Data Pribadi, Pinjaman, Kontrak) are now routes of their own in the
 * sidebar/hamburger, which frees `/me` to answer the question the tabs never
 * did: how is MY month going. Four numbers a person actually checks —
 * attendance, lateness, leave left, take-home pay — plus the outstanding
 * kasbon, over data they already have permission to read.
 *
 * Every read is self-scoped (`/hr/attendance/me`, `/hr/leaves/me`,
 * `/payroll/my-slips`, `/payroll/loans/me`, CONTRACTS §4.14/§4.15). They are
 * loaded with `allSettled` and each tile degrades on its own: an owner with
 * no employee record still gets a working page instead of one failed request
 * blanking the screen.
 */

const PRESENT_STATUSES = new Set(['present', 'late']);

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

type Translate = (key: string, params?: Record<string, string>) => string;

/** Minutes → "7j 30m" / "45m", the unit a shift is actually discussed in. */
function fmtMinutes(total: number, t: Translate): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return t('me.overview.minutes', { m: String(m) });
  return t('me.overview.hoursMinutes', { h: String(h), m: String(m) });
}

const TONE_CLASS: Record<'neutral' | 'good' | 'warn', string> = {
  neutral: 'text-text-primary',
  good: 'text-success-700',
  warn: 'text-warning-700',
};

function StatTile({
  label,
  value,
  hint,
  tone = 'neutral',
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'neutral' | 'good' | 'warn';
}) {
  return (
    <Card className="p-3">
      <p className="text-xs font-medium uppercase tracking-wide text-text-muted">{label}</p>
      <p className={`font-display text-2xl font-semibold ${TONE_CLASS[tone]}`}>{value}</p>
      {hint && <p className="text-xs text-text-muted">{hint}</p>}
    </Card>
  );
}

const SHORTCUTS: { href: string; labelKey: string; icon: LucideIcon }[] = [
  { href: '/me/absen', labelKey: 'me.tabs.absen', icon: QrCode },
  { href: '/me/slip', labelKey: 'me.tabs.slip', icon: FileText },
  { href: '/me/cuti', labelKey: 'me.tabs.cuti', icon: CalendarPlus },
  { href: '/me/profil', labelKey: 'me.tabs.profile', icon: UserCircle },
  { href: '/me/pinjaman', labelKey: 'me.tabs.pinjaman', icon: HandCoins },
  { href: '/me/kontrak', labelKey: 'me.tabs.kontrak', icon: FileSignature },
];

const DAY_CELL_CLASS: Record<string, string> = {
  present: 'bg-success-100 text-success-800',
  late: 'bg-warning-100 text-warning-800',
  absent: 'bg-danger-100 text-danger-800',
};

export function MeOverview() {
  const { t } = useI18n();
  const user = useSessionStore((s) => s.user);

  // Frozen at mount: a component that re-derives `new Date()` on every render
  // would change the effect's dependencies and refetch forever.
  const [now] = useState(() => new Date());
  const month = monthKey(now);
  const year = String(now.getFullYear());

  const [attendance, setAttendance] = useState<AttendanceRow[] | null>(null);
  const [leaves, setLeaves] = useState<{ leaves: Leave[]; annualLeft: number } | null>(null);
  const [slips, setSlips] = useState<Payslip[] | null>(null);
  const [loans, setLoans] = useState<MyLoan[] | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    // `allSettled`, not `all`: an endpoint a given account has no record for
    // must not take the other three tiles down with it.
    void Promise.allSettled([
      getMyAttendance(month),
      getMyLeaves(year),
      getMySlips(year),
      getMyLoans(),
    ]).then(([att, lv, sl, ln]) => {
      if (cancelled) return;
      if (att.status === 'fulfilled') setAttendance(att.value);
      if (lv.status === 'fulfilled') {
        const quota = lv.value.quota.annual;
        setLeaves({
          leaves: lv.value.leaves,
          annualLeft: Math.max(0, quota.total - quota.used),
        });
      }
      if (sl.status === 'fulfilled') setSlips(sl.value);
      if (ln.status === 'fulfilled') setLoans(ln.value.rows);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [month, year]);

  const stats = useMemo(() => {
    const rows = attendance ?? [];
    const present = rows.filter((r) => PRESENT_STATUSES.has(r.status)).length;
    const late = rows.filter((r) => r.status === 'late');
    const absent = rows.filter((r) => r.status === 'absent').length;
    const lateMinutes = late.reduce((sum, r) => sum + (r.lateMinutes || 0), 0);
    const overtimeMinutes = rows.reduce((sum, r) => sum + (r.overtimeMinutes || 0), 0);
    // The rate's denominator is ROSTERED days, not days elapsed — counting a
    // day off as a missed day would show a perfect month as a failing one.
    const scheduled = rows.filter((r) => r.status !== 'holiday' && r.status !== 'off').length;
    return {
      present,
      lateCount: late.length,
      lateMinutes,
      absent,
      overtimeMinutes,
      rate: scheduled > 0 ? (present / scheduled) * 100 : null,
    };
  }, [attendance]);

  // `/payroll/my-slips` returns the year ascending; the last one is the most
  // recent period that has actually been paid.
  const latestSlip = slips && slips.length > 0 ? slips[slips.length - 1] : null;
  const outstanding = (loans ?? [])
    .filter((l) => l.status === 'active' || l.status === 'approved')
    .reduce((sum, l) => sum + Number(l.outstanding || 0), 0);
  const pendingLeaves = (leaves?.leaves ?? []).filter((l) => l.status === 'pending').length;

  const hasAnything = !!attendance || !!leaves || !!slips || !!loans;

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-3">
      {/* AppShell renders OfflineBanner once, above every non-chromeless
          route's <main> — no page-level copy here. */}
      <div>
        <h1 className="font-display text-xl font-semibold text-text-primary">{t('nav.me')}</h1>
        {user && (
          <p className="text-sm text-text-muted">
            {t('me.overview.greeting', { name: user.name, role: t(`role.${user.roleKey}`) })}
          </p>
        )}
      </div>

      {/* The six own-data surfaces also live in the sidebar; on a phone that
          sidebar is behind a hamburger, so the overview keeps them one tap
          away rather than making a check of your payslip start with a menu. */}
      <nav className="grid grid-cols-3 gap-2" aria-label={t('nav.section.personal')}>
        {SHORTCUTS.map(({ href, labelKey, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface-raised p-3 text-center text-xs font-medium text-text-secondary transition-colors hover:border-brand-200 hover:bg-brand-50 hover:text-brand-700"
          >
            <Icon className="size-5" aria-hidden />
            {t(labelKey)}
          </Link>
        ))}
      </nav>

      {loading && <EmptyState title={t('table.loading')} size="lg" />}

      {!loading && !hasAnything && <EmptyState title={t('me.overview.unavailable')} size="lg" />}

      {!loading && hasAnything && (
        <>
          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-text-secondary">
              {t('me.overview.thisMonth', { month: fmtDate(`${month}-01`) })}
            </h2>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <StatTile
                label={t('status.attendance.present')}
                value={attendance ? t('me.overview.days', { n: String(stats.present) }) : '—'}
                hint={
                  stats.rate === null
                    ? undefined
                    : t('me.overview.attendanceRate', { rate: formatNumber(stats.rate, 0) })
                }
                tone={stats.rate !== null && stats.rate >= 95 ? 'good' : 'neutral'}
              />
              <StatTile
                label={t('status.attendance.late')}
                value={attendance ? t('me.overview.times', { n: String(stats.lateCount) }) : '—'}
                hint={stats.lateMinutes > 0 ? fmtMinutes(stats.lateMinutes, t) : undefined}
                tone={stats.lateCount > 0 ? 'warn' : 'good'}
              />
              <StatTile
                label={t('me.overview.overtime')}
                value={attendance ? fmtMinutes(stats.overtimeMinutes, t) : '—'}
                hint={
                  stats.absent > 0
                    ? t('me.overview.absentDays', { n: String(stats.absent) })
                    : undefined
                }
                tone={stats.absent > 0 ? 'warn' : 'neutral'}
              />
              <StatTile
                label={t('me.overview.leaveLeft')}
                value={leaves ? t('me.overview.days', { n: String(leaves.annualLeft) }) : '—'}
                hint={
                  pendingLeaves > 0
                    ? t('me.overview.leavePending', { n: String(pendingLeaves) })
                    : undefined
                }
              />
            </div>
          </section>

          <Card>
            <CardHeader>
              <CardTitle>{t('me.overview.attendanceStrip')}</CardTitle>
            </CardHeader>
            <CardContent>
              {attendance && attendance.length > 0 ? (
                <ul className="flex flex-wrap gap-1.5">
                  {attendance.map((row) => (
                    <li
                      key={row.id}
                      title={`${fmtDate(row.date)} — ${t(`status.attendance.${row.status}`)}`}
                      className={`flex size-8 items-center justify-center rounded-md text-xs font-medium ${
                        DAY_CELL_CLASS[row.status] ?? 'bg-surface-sunken text-text-muted'
                      }`}
                    >
                      {Number(row.date.slice(8, 10))}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-text-muted">{t('me.overview.noAttendance')}</p>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-3 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle>{t('me.tabs.slip')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                {latestSlip ? (
                  <>
                    <p className="font-display text-2xl font-semibold text-text-primary">
                      {formatMoney(latestSlip.net)}
                    </p>
                    <p className="text-sm text-text-muted">
                      {t('me.overview.lastPeriod', { period: latestSlip.periodCode })}
                    </p>
                    <Link href="/me/slip" className="text-sm font-medium text-brand-700">
                      {t('me.overview.openSlips')}
                    </Link>
                  </>
                ) : (
                  <p className="text-sm text-text-muted">{t('me.slip.empty')}</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t('me.tabs.pinjaman')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-1">
                <p className="font-display text-2xl font-semibold text-text-primary">
                  {loans ? formatMoney(outstanding.toFixed(2)) : '—'}
                </p>
                <p className="text-sm text-text-muted">{t('me.overview.outstanding')}</p>
                <Link href="/me/pinjaman" className="text-sm font-medium text-brand-700">
                  {t('me.overview.openLoans')}
                </Link>
              </CardContent>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
