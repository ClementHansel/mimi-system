'use client';

import { useCallback, useEffect, useState } from 'react';
import { CalendarX2, AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Checkbox,
  DataTable,
  Input,
  Modal,
  Select,
  Textarea,
} from '@/components/ui';
import { usePermissions } from '@/lib/permissions';
import { useSessionStore } from '@/stores/session-store';
import { fmtDate, toDateInput } from '@/lib/dates';
import { listNoShows, markAbsent } from './lib/hr-api';
import type { NoShowRow } from './lib/types';
import type { Paginated } from '@/lib/shared-types';
import { errMsg } from '@/lib/api-error';

/**
 * ROSTERED DAYS NOBODY EVER RECORDED — and the only way to record them.
 *
 * MA-200, reported as "hasil dari proses payroll tidak menampilkan angka untuk
 * potongan gaji di SDM > Payroll". The payroll run counts absence as
 * `attendance.status = 'absent'`, and nothing in the entire product ever wrote
 * that status: an `attendance` row is created by a CHECK-IN and nothing else,
 * and the correction endpoint updates a row BY ID. An employee who was
 * rostered and did not turn up left no row, so there was nothing to correct
 * and nowhere to say so — `deduction_absence` (POUT-03) was unreachable for
 * everybody, and the payroll result showed Rp0 with no way to tell that from a
 * broken screen.
 *
 * Deliberately a WORKLIST, not an automatic deduction. A rostered day with no
 * attendance row means "no evidence either way", and on this deployment the
 * usual cause is an offline outbox that has not drained rather than anyone
 * staying home — deriving the deduction from missing data would turn a sync
 * failure into lost wages. Measured before it was rejected: on the seeded
 * database that rule converts 7,701 rostered working days holding 126
 * attendance records into a month's absence deduction for most of the roster.
 *
 * So a day only becomes a deduction when a person marks it, with a reason, and
 * the server keeps that reason against their name (FR-AUDIT-02). The bulk
 * action exists because 283 days cannot be worked one dialog at a time, and it
 * is the one place on this screen that spends someone's pay — hence the count
 * in the confirmation, and a reason that is mandatory rather than optional.
 */
const DEFAULT_WINDOW_DAYS = 30;

function isoDaysAgo(days: number): string {
  return toDateInput(new Date(Date.now() - days * 24 * 60 * 60_000));
}

function keyOf(row: NoShowRow): string {
  return `${row.employeeId}|${row.date}`;
}

const EMPTY_PAGE: Paginated<NoShowRow> = { rows: [], total: 0, page: 1, pageSize: 25 };

export function NoShowWorklist() {
  const { t } = useI18n();
  const { can } = usePermissions();
  // `(s) => s.user?.locations ?? []` would be a NEW array on every call once
  // `user` is null, and zustand compares with `Object.is` — that selector
  // re-renders forever. Select the user, fall back outside: the same shape
  // `AttendancePanel` next door already uses.
  const user = useSessionStore((s) => s.user);
  const locations = user?.locations ?? [];

  // Ends YESTERDAY, because a shift still in progress is not a missed one —
  // the server refuses `>= CURRENT_DATE` anyway, so offering today would only
  // ever return nothing.
  const [from, setFrom] = useState(() => isoDaysAgo(DEFAULT_WINDOW_DAYS));
  const [to, setTo] = useState(() => isoDaysAgo(1));
  const [locationId, setLocationId] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<Paginated<NoShowRow>>(EMPTY_PAGE);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    setLoadError(undefined);
    listNoShows({ from, to, locationId: locationId || undefined, page, pageSize: 25 })
      .then(setData)
      .catch((err) => {
        setData(EMPTY_PAGE);
        setLoadError(errMsg(err, t('errors.generic')));
      })
      .finally(() => setLoading(false));
  }, [from, to, locationId, page, t]);

  useEffect(reload, [reload]);

  // A selection that outlived the rows it referred to would let a filter
  // change mark days the user can no longer see.
  useEffect(() => setSelected(new Set()), [from, to, locationId, page]);

  const pageKeys = data.rows.map(keyOf);
  const allOnPageSelected = pageKeys.length > 0 && pageKeys.every((k) => selected.has(k));
  const chosen = data.rows.filter((r) => selected.has(keyOf(r)));

  function toggle(row: NoShowRow) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(row);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  /**
   * Select-all covers THIS PAGE only, and says so. A control that silently
   * selected all `total` rows — including ones never rendered — would let one
   * click deduct a day's pay from people the user never looked at.
   */
  function toggleAllOnPage() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) pageKeys.forEach((k) => next.delete(k));
      else pageKeys.forEach((k) => next.add(k));
      return next;
    });
  }

  async function submit() {
    if (!reason.trim() || chosen.length === 0) return;
    setSubmitting(true);
    // Sequential and per-day: each is its own `attendance` row and its own
    // server-side guard (already recorded, on approved leave, not rostered), so
    // one refusal must not abandon the rest — and the user is told exactly how
    // many landed rather than "something went wrong".
    let saved = 0;
    const failures: string[] = [];
    for (const row of chosen) {
      try {
        await markAbsent({
          employeeId: row.employeeId,
          date: row.date,
          correctionReason: reason.trim(),
        });
        saved += 1;
      } catch (err) {
        failures.push(`${row.employeeName} ${fmtDate(row.date)}: ${errMsg(err, '')}`);
      }
    }
    setSubmitting(false);
    setConfirmOpen(false);
    setReason('');
    setSelected(new Set());
    if (saved > 0) {
      toast({ title: t('hr.attendance.noShow.markSuccess', { n: saved }), variant: 'success' });
    }
    if (failures.length > 0) {
      toast({
        title: t('hr.attendance.noShow.markPartial', { n: failures.length }),
        description: failures.slice(0, 3).join(' · '),
        variant: 'danger',
      });
    }
    reload();
  }

  const canMark = can('hr.attendance.correct');

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarX2 className="size-5 text-brand-600" aria-hidden />
          {t('hr.attendance.noShow.title')}
        </CardTitle>
        <CardDescription>{t('hr.attendance.noShow.description')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end gap-3">
          <Input
            type="date"
            label={t('hr.attendance.noShow.fromLabel')}
            value={from}
            onChange={(e) => {
              setFrom(e.target.value);
              setPage(1);
            }}
            wrapperClassName="w-40"
          />
          <Input
            type="date"
            label={t('hr.attendance.noShow.toLabel')}
            value={to}
            onChange={(e) => {
              setTo(e.target.value);
              setPage(1);
            }}
            hint={t('hr.attendance.noShow.toHint')}
            wrapperClassName="w-40"
          />
          <Select
            label={t('hr.attendance.location')}
            value={locationId}
            onValueChange={(v) => {
              setLocationId(v);
              setPage(1);
            }}
            options={[
              { value: '', label: t('hr.attendance.allLocations') },
              ...locations.map((l) => ({ value: l.id, label: l.name })),
            ]}
            wrapperClassName="w-56"
          />
        </div>

        {!loading && !loadError && (
          <p className="flex items-center gap-1.5 text-sm text-text-secondary">
            {data.total > 0 ? (
              <>
                <AlertTriangle className="size-4 flex-none text-warning-600" aria-hidden />
                {t('hr.attendance.noShow.count', { n: data.total })}
              </>
            ) : (
              t('hr.attendance.noShow.none')
            )}
          </p>
        )}

        {canMark && data.rows.length > 0 && (
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface-sunken px-3 py-2">
            {/* MA-193 asked for a Check All wherever a form carries many
                checkboxes. This is that control, scoped to the page it can
                actually show. */}
            <Checkbox
              label={t('hr.attendance.noShow.selectAllOnPage', { n: data.rows.length })}
              checked={allOnPageSelected}
              onCheckedChange={toggleAllOnPage}
            />
            <span className="text-sm text-text-muted">
              {t('hr.attendance.noShow.selectedCount', { n: chosen.length })}
            </span>
            <Button
              size="sm"
              variant="danger"
              disabled={chosen.length === 0}
              onClick={() => setConfirmOpen(true)}
            >
              {t('hr.attendance.noShow.markButton')}
            </Button>
          </div>
        )}

        <DataTable
          columns={[
            ...(canMark
              ? [
                  {
                    key: 'select',
                    header: '',
                    width: '3rem',
                    render: (r: NoShowRow) => (
                      <Checkbox
                        checked={selected.has(keyOf(r))}
                        onCheckedChange={() => toggle(r)}
                        aria-label={t('hr.attendance.noShow.selectRow', {
                          name: r.employeeName,
                          date: fmtDate(r.date),
                        })}
                      />
                    ),
                  },
                ]
              : []),
            {
              key: 'date',
              header: t('hr.attendance.date'),
              render: (r: NoShowRow) => fmtDate(r.date),
            },
            { key: 'employeeName', header: t('hr.employees.columnName') },
            { key: 'employeeNumber', header: t('hr.employees.columnNumber') },
            { key: 'locationName', header: t('hr.employees.columnLocation') },
            { key: 'shiftName', header: t('hr.attendance.noShow.columnShift') },
          ]}
          data={data}
          keyField={(r) => keyOf(r)}
          loading={loading}
          error={loadError}
          emptyTitle={t('hr.attendance.noShow.none')}
          onPageChange={setPage}
        />
      </CardContent>

      {confirmOpen && (
        <Modal
          open
          onClose={() => setConfirmOpen(false)}
          title={t('hr.attendance.noShow.confirmTitle', { n: chosen.length })}
          footer={
            <>
              <Button variant="outline" onClick={() => setConfirmOpen(false)}>
                {t('common.cancel')}
              </Button>
              <Button
                variant="danger"
                onClick={submit}
                loading={submitting}
                disabled={!reason.trim()}
              >
                {t('hr.attendance.noShow.markButton')}
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {/* Named plainly, because this is the consequence: an `absent` day
                becomes a deduction on the next payroll run. */}
            <p className="rounded-md border border-warning-600/30 bg-warning-50 p-3 text-sm text-warning-700">
              {t('hr.attendance.noShow.confirmWarning', { n: chosen.length })}
            </p>
            <ul className="max-h-40 overflow-y-auto text-sm text-text-secondary">
              {chosen.slice(0, 12).map((r) => (
                <li key={keyOf(r)}>
                  {fmtDate(r.date)} — {r.employeeName} ({r.locationName})
                </li>
              ))}
              {chosen.length > 12 && (
                <li className="text-text-muted">
                  {t('hr.attendance.noShow.andMore', { n: chosen.length - 12 })}
                </li>
              )}
            </ul>
            <Textarea
              label={t('hr.attendance.noShow.reasonLabel')}
              placeholder={t('hr.attendance.noShow.reasonPlaceholder')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              hint={t('hr.attendance.noShow.reasonHint')}
              required
            />
          </div>
        </Modal>
      )}
    </Card>
  );
}
