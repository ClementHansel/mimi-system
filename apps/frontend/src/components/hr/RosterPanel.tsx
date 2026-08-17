'use client';

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import { Button, Card, CardContent, Input, Select, PermissionGate } from '@/components/ui';
import { usePermissions } from '@/lib/permissions';
import { useSessionStore } from '@/stores/session-store';
import { toDateInput } from '@/lib/dates';
import { createShift, getRoster, listShifts, putRoster } from './lib/hr-api';
import type { RosterRow, WorkShift } from './lib/types';

function startOfWeek(d: Date): Date {
  const copy = new Date(d);
  const day = copy.getDay();
  const diff = (day + 6) % 7; // Monday-first
  copy.setDate(copy.getDate() - diff);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setDate(copy.getDate() + n);
  return copy;
}

const LIBUR = '__off__';

/** F08 `hr` — shift roster (`hr.shift.read`/`.manage`, FR-HR-02): bulk-assign work shifts per employee per day for one week at a time. */
export function RosterPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const user = useSessionStore((s) => s.user);
  const locations = user?.locations ?? [];
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);
  const from = toDateInput(weekStart);
  const to = toDateInput(days[6]);

  function reload() {
    if (!locationId) return;
    setLoading(true);
    Promise.all([listShifts(locationId), getRoster({ locationId, from, to })])
      .then(([shiftList, roster]) => {
        setShifts(shiftList);
        setRows(roster);
        const d: Record<string, string> = {};
        for (const row of roster) {
          for (const day of row.days) {
            d[`${row.employeeId}:${day.date}`] = day.workShiftId ?? LIBUR;
          }
        }
        setDraft(d);
      })
      .finally(() => setLoading(false));
  }

  useEffect(reload, [locationId, from, to]);

  const shiftOptions = [{ value: LIBUR, label: t('hr.roster.off') }, ...shifts.map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}-${s.endTime})` }))];

  async function save() {
    setSaving(true);
    try {
      const assignments = rows.flatMap((row) =>
        days.map((day) => {
          const date = toDateInput(day);
          const key = `${row.employeeId}:${date}`;
          const value = draft[key] ?? LIBUR;
          return { employeeId: row.employeeId, date, workShiftId: value === LIBUR ? null : value };
        }),
      );
      await putRoster({ locationId, assignments });
      toast({ title: t('hr.roster.saveSuccess'), variant: 'success' });
      reload();
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Select
            label={t('hr.roster.location')}
            value={locationId}
            onValueChange={setLocationId}
            options={locations.map((l) => ({ value: l.id, label: l.name }))}
            wrapperClassName="w-56"
          />
          <div className="flex items-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => addDays(w, -7))}>{'<'}</Button>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">{t('hr.roster.week')}</span>
              <span className="text-sm text-text-secondary">{from} – {to}</span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => addDays(w, 7))}>{'>'}</Button>
          </div>
          <PermissionGate permission="hr.shift.manage">
            <Button className="ml-auto" onClick={save} loading={saving} disabled={rows.length === 0}>
              {t('common.save')}
            </Button>
          </PermissionGate>
        </CardContent>
      </Card>

      {loading ? (
        <div className="h-64 animate-pulse rounded-md bg-surface-sunken" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                <th className="sticky left-0 bg-surface-sunken px-3 py-2">{t('hr.roster.employee')}</th>
                {days.map((d) => (
                  <th key={d.toISOString()} className="px-3 py-2 text-center">{toDateInput(d)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId} className="border-b border-border last:border-0">
                  <td className="sticky left-0 bg-surface-raised px-3 py-2 font-medium text-text-primary">{row.employeeName}</td>
                  {days.map((d) => {
                    const date = toDateInput(d);
                    const key = `${row.employeeId}:${date}`;
                    return (
                      <td key={key} className="px-2 py-1.5">
                        <Select
                          value={draft[key] ?? LIBUR}
                          onValueChange={(v) => setDraft((prev) => ({ ...prev, [key]: v }))}
                          options={shiftOptions}
                          size="sm"
                          wrapperClassName="w-32"
                          disabled={!can('hr.shift.manage')}
                        />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <PermissionGate permission="hr.shift.manage">
        <NewShiftForm locationId={locationId} onCreated={reload} />
      </PermissionGate>
    </div>
  );
}

function NewShiftForm({ locationId, onCreated }: { locationId: string; onCreated: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [startTime, setStartTime] = useState('');
  const [endTime, setEndTime] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!name || !startTime || !endTime) return;
    setBusy(true);
    try {
      await createShift({ locationId, name, startTime, endTime });
      setName('');
      setStartTime('');
      setEndTime('');
      onCreated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3">
        <Input label={t('hr.roster.shiftName')} value={name} onChange={(e) => setName(e.target.value)} wrapperClassName="w-40" />
        <Input type="time" label={t('hr.roster.shiftStart')} value={startTime} onChange={(e) => setStartTime(e.target.value)} wrapperClassName="w-32" />
        <Input type="time" label={t('hr.roster.shiftEnd')} value={endTime} onChange={(e) => setEndTime(e.target.value)} wrapperClassName="w-32" />
        <Button onClick={submit} loading={busy}>{t('hr.roster.addShift')}</Button>
      </CardContent>
    </Card>
  );
}
