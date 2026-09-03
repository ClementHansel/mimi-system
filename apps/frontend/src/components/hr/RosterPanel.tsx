'use client';

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Badge,
  Button,
  Card,
  CardContent,
  EmptyState,
  Input,
  Modal,
  Select,
  PermissionGate,
} from '@/components/ui';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { useSessionStore } from '@/stores/session-store';
import { toDateInput } from '@/lib/dates';
import { ExportButton } from '@/components/common/ExportButton';
import {
  createShift,
  getRoster,
  listLocationCodesById,
  listShifts,
  putRoster,
  updateShift,
} from './lib/hr-api';
import { MasterDataIo } from '@/components/admin/MasterDataIo';
import { rosterExportColumns, workShiftIoColumns } from './lib/io-columns';
import type { RosterRow, WorkShift } from './lib/types';
import { errMsg } from '@/lib/api-error';

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

/**
 * One editable row of `ShiftTemplatesCard`. `breakMinutes` is a STRING here
 * and a number on the wire: an `<input type="number">` is empty-string while
 * someone is retyping it, and coercing that to `0` mid-keystroke silently
 * wipes a break the user only meant to edit.
 */
interface ShiftDraft {
  name: string;
  startTime: string;
  endTime: string;
  breakMinutes: string;
}

function toShiftDraft(s: WorkShift): ShiftDraft {
  return {
    name: s.name,
    startTime: s.startTime,
    endTime: s.endTime,
    breakMinutes: String(s.breakMinutes ?? 0),
  };
}

function isShiftDirty(s: WorkShift, d: ShiftDraft): boolean {
  const o = toShiftDraft(s);
  return (
    d.name !== o.name ||
    d.startTime !== o.startTime ||
    d.endTime !== o.endTime ||
    d.breakMinutes !== o.breakMinutes
  );
}

/**
 * Mirrors `ShiftsService.assertWindow` and the DTO's `@IsString` on `name`.
 * The server stays the authority — this only spares the user a round trip
 * that comes back as a generic toast with no field attached to it.
 */
function validateShiftDraft(d: ShiftDraft, t: (k: string) => string): string | null {
  if (!d.name.trim()) return t('hr.roster.shiftNameRequired');
  if (d.startTime === d.endTime) return t('hr.roster.shiftSameTime');
  return null;
}

/**
 * F08 `hr` — shift roster (`hr.shift.read`/`.manage`, FR-HR-02): bulk-assign
 * work shifts per employee per day for one week at a time.
 *
 * MOUNTED IN TWO PLACES (owner, 2026-08-27: "it should be in each outlet and
 * dashboard, so either can set schedule for their employees"):
 *
 *  - `/hr` → Jadwal Shift, for the office. The location is chosen here, so
 *    the panel renders its own picker.
 *  - `/outlet` → Jadwal, for the branch. The Outlet shell has ALREADY resolved
 *    which outlet the screen is acting on, so it passes `locationId` and the
 *    picker is suppressed — offering a second, contradictory location control
 *    on a screen whose header already names the outlet is how a supervisor
 *    ends up rostering the wrong branch.
 *
 * WHERE THE LOCATIONS COME FROM. `user.locations` is EMPTY for a central role
 * (owner/manager/finance/hr_admin) by design (D-05) — the same fact that had
 * every Outlet panel spinning forever until 2026-08-27. Here it meant the
 * office's own roster picker had nothing in it, so the people whose job this is
 * could not set a schedule at all. With no assignment the panel now asks the
 * server for the locations the caller may read (`/locations`, which is
 * `location.read`-filtered — the server stays the authority on scope).
 */
export function RosterPanel({ locationId: fixedLocationId }: { locationId?: string } = {}) {
  const { t } = useI18n();
  const { can } = usePermissions();
  const user = useSessionStore((s) => s.user);
  const assigned = user?.locations ?? [];
  // Only fetch when there is nothing to pick from AND nothing was handed in.
  const needsLocationFetch = !fixedLocationId && assigned.length === 0;
  const [fetchedLocations, setFetchedLocations] = useState<{ id: string; name: string }[] | null>(
    null,
  );
  const [pickedLocationId, setPickedLocationId] = useState(assigned[0]?.id ?? '');

  useEffect(() => {
    if (!needsLocationFetch) return;
    let cancelled = false;
    api
      .get<{ rows: { id: string; name: string }[] }>('/locations?active=true&pageSize=200')
      .then((res) => {
        if (cancelled) return;
        const rows = res.rows.map((l) => ({ id: l.id, name: l.name }));
        setFetchedLocations(rows);
        setPickedLocationId((current) => current || (rows[0]?.id ?? ''));
      })
      .catch(() => {
        if (!cancelled) setFetchedLocations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [needsLocationFetch]);

  const locations = assigned.length > 0 ? assigned : (fetchedLocations ?? []);
  const locationId = fixedLocationId ?? pickedLocationId;
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const [shifts, setShifts] = useState<WorkShift[]>([]);
  const [rows, setRows] = useState<RosterRow[]>([]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  /**
   * Location id -> `locations.code`, for the export's `location` column (the
   * importer resolves against the code). Fetched once, not per reload: the
   * location list does not change while a roster week is being edited, and this
   * only feeds an export column.
   */
  const [locationCodes, setLocationCodes] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    listLocationCodesById().then((m) => {
      if (!cancelled) setLocationCodes(m);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const days = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );
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

  /**
   * The dropdown for one day. Built from the ACTIVE templates plus any shift
   * a saved assignment already points at.
   *
   * That second half is not defensive padding. `listShifts` filters on
   * `is_active = true` while `getRoster` joins `shift_assignments` without
   * that filter, so the moment a template is deactivated (which the card
   * below can now do) every day already rostered onto it has a value that
   * matches no `<option>`. A native `<select>` renders that as BLANK — the
   * cell reads as if nobody is scheduled, on a screen whose whole job is
   * saying who is. The id is still in `draft`, so a save would round-trip it
   * correctly; it is only the display that lies, which is worse, not better.
   */
  const shiftOptions = useMemo(() => {
    const active = new Set(shifts.map((s) => s.id));
    const orphans = new Map<string, string>();
    for (const row of rows) {
      for (const day of row.days) {
        if (day.workShiftId && !active.has(day.workShiftId) && !orphans.has(day.workShiftId)) {
          orphans.set(day.workShiftId, day.shiftName ?? day.workShiftId);
        }
      }
    }
    return [
      { value: LIBUR, label: t('hr.roster.off') },
      ...shifts.map((s) => ({ value: s.id, label: `${s.name} (${s.startTime}-${s.endTime})` })),
      ...[...orphans].map(([id, name]) => ({
        value: id,
        label: `${name} (${t('hr.roster.inactiveShift')})`,
      })),
    ];
  }, [shifts, rows, t]);

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
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          {/* Suppressed when the shell already settled the location — see the
              component's doc comment. */}
          {!fixedLocationId && (
            <Select
              label={t('hr.roster.location')}
              value={locationId}
              onValueChange={setPickedLocationId}
              options={locations.map((l) => ({ value: l.id, label: l.name }))}
              wrapperClassName="w-56"
            />
          )}
          <div className="flex items-end gap-2">
            <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => addDays(w, -7))}>
              {'<'}
            </Button>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text-primary">{t('hr.roster.week')}</span>
              <span className="text-sm text-text-secondary">
                {from} – {to}
              </span>
            </div>
            <Button variant="outline" size="sm" onClick={() => setWeekStart((w) => addDays(w, 7))}>
              {'>'}
            </Button>
          </div>
          {/* Export what's on screen — one row per employee, one column per
              day of THIS week, matching the grid below exactly. No import:
              the roster's own save button (right beside this) is the only
              write path; `shift_assignments` isn't a bulk-importer entity. */}
          <ExportButton
            rows={rows}
            columns={rosterExportColumns(days)}
            filenameBase="jadwal-shift"
          />
          <PermissionGate permission="hr.shift.manage">
            <Button
              className="ml-auto"
              onClick={save}
              loading={saving}
              disabled={rows.length === 0}
            >
              {t('common.save')}
            </Button>
          </PermissionGate>
        </CardContent>
      </Card>

      {!locationId && !loading ? (
        <EmptyState title={t('hr.roster.noLocation')} size="lg" />
      ) : loading ? (
        <div className="h-64 animate-pulse rounded-md bg-surface-sunken" />
      ) : rows.length === 0 ? (
        <EmptyState title={t('hr.roster.noEmployees')} size="lg" />
      ) : (
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-border bg-surface-sunken text-left text-text-secondary">
                <th className="sticky left-0 bg-surface-sunken px-3 py-2">
                  {t('hr.roster.employee')}
                </th>
                {days.map((d) => (
                  <th key={d.toISOString()} className="px-3 py-2 text-center">
                    {toDateInput(d)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.employeeId} className="border-b border-border last:border-0">
                  <td className="sticky left-0 bg-surface-raised px-3 py-2 font-medium text-text-primary">
                    {row.employeeName}
                  </td>
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

      {locationId && shifts.length > 0 && (
        <ShiftTemplatesCard shifts={shifts} onChanged={reload} canManage={can('hr.shift.manage')} />
      )}

      {locationId && shifts.length > 0 && (
        // Shift TEMPLATES, not the roster grid above. Round-trips through the
        // bulk importer as of 2026-08-27, once `ShiftDto` started carrying
        // `locationId` — see `io-columns.ts`'s header for what was blocking it.
        //
        // Import is offered only once `locationCodes` has loaded: a shift whose
        // location id is missing from that map exports BLANK, and blank means
        // "every location" to the importer. Offering the button early would let
        // an incomplete map silently widen an outlet's shift company-wide.
        <div className="flex justify-end">
          <MasterDataIo
            entity="work_shifts"
            titleKey="hr.tabs.roster"
            rows={shifts}
            columns={workShiftIoColumns(locationCodes)}
            filenameBase="template-shift"
            onImported={reload}
            canImport={can('hr.shift.manage') && locationCodes.size > 0}
          />
        </div>
      )}

      {locationId && (
        <PermissionGate permission="hr.shift.manage">
          <NewShiftForm locationId={locationId} onCreated={reload} />
        </PermissionGate>
      )}
    </div>
  );
}

/**
 * The shift TEMPLATES for the picked location — the "presets" the roster
 * grid's dropdowns are built from — editable in place.
 *
 * ADDED 2026-08-30, and the gap it closes is a real one. `POST /hr/shifts`
 * had a form (`NewShiftForm`, below) and `PATCH /hr/shifts/:id` had none, so
 * "Malam ends at 23:30, it should be 23:00" was answerable only by exporting
 * the CSV beside this card, editing a cell and importing it back — a
 * round-trip whose natural key is (name, location), so a supervisor who
 * corrected the NAME in the same pass silently got a second template instead
 * of a renamed one. The endpoint was always there; only the buttons weren't.
 *
 * TWO THINGS THIS DELIBERATELY WILL NOT DO.
 *
 *  - It never sends `locationId`. `listShifts` returns this outlet's shifts
 *    AND the company-wide ones (`location_id IS NULL`), so both are on screen
 *    together; a scope change hiding inside a timing edit is how one outlet
 *    quietly annexes a template every other outlet is rostering against.
 *    Editing a company-wide row is still allowed — the owner has to be able
 *    to — but it is badged and it asks first, because the blast radius is
 *    every location, not the one named in the picker above.
 *  - It offers deactivate, not delete. `shift_assignments` keeps pointing at
 *    the row (and `getRoster` keeps reading it), so "delete" would be a lie
 *    about already-published schedules.
 */
function ShiftTemplatesCard({
  shifts,
  onChanged,
  canManage,
}: {
  shifts: WorkShift[];
  onChanged: () => void;
  canManage: boolean;
}) {
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, ShiftDraft>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  /** The row a confirmation is open for, and which of the two questions it is. */
  const [pending, setPending] = useState<{ shift: WorkShift; kind: 'global' | 'off' } | null>(null);

  // Re-seed from the server on every reload. Rebuilt from `shifts` rather
  // than merged into the previous state, so a template that vanished
  // (deactivated here or elsewhere) takes its stale draft with it instead of
  // resurrecting on the next render.
  useEffect(() => {
    setDrafts(Object.fromEntries(shifts.map((s) => [s.id, toShiftDraft(s)])));
  }, [shifts]);

  function patch(id: string, part: Partial<ShiftDraft>) {
    setDrafts((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], ...part } } : prev));
  }

  async function commit(shift: WorkShift) {
    const draft = drafts[shift.id];
    if (!draft) return;
    const error = validateShiftDraft(draft, t);
    if (error) {
      toast({ title: error, variant: 'danger' });
      return;
    }
    setBusyId(shift.id);
    try {
      const breakMinutes = Number(draft.breakMinutes);
      await updateShift(shift.id, {
        name: draft.name.trim(),
        startTime: draft.startTime,
        endTime: draft.endTime,
        breakMinutes: Number.isFinite(breakMinutes) && breakMinutes >= 0 ? breakMinutes : 0,
      });
      toast({ title: t('hr.roster.shiftUpdated'), variant: 'success' });
      onChanged();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    } finally {
      setBusyId(null);
    }
  }

  async function deactivate(shift: WorkShift) {
    setBusyId(shift.id);
    try {
      await updateShift(shift.id, { isActive: false });
      toast({ title: t('hr.roster.shiftDeactivated'), variant: 'success' });
      onChanged();
    } catch (err) {
      toast({ title: errMsg(err, t('errors.generic')), variant: 'danger' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-text-primary">
            {t('hr.roster.templatesTitle')}
          </h3>
          <p className="mt-1 text-xs text-text-secondary">{t('hr.roster.templatesHint')}</p>
        </div>

        <div className="flex flex-col divide-y divide-border">
          {shifts.map((shift) => {
            const draft = drafts[shift.id];
            if (!draft) return null;
            const dirty = isShiftDirty(shift, draft);
            return (
              <div key={shift.id} className="flex flex-wrap items-end gap-3 py-3 first:pt-0">
                <Input
                  label={t('hr.roster.shiftName')}
                  value={draft.name}
                  onChange={(e) => patch(shift.id, { name: e.target.value })}
                  size="sm"
                  disabled={!canManage}
                  wrapperClassName="w-40"
                />
                <Input
                  type="time"
                  label={t('hr.roster.shiftStart')}
                  value={draft.startTime}
                  onChange={(e) => patch(shift.id, { startTime: e.target.value })}
                  size="sm"
                  disabled={!canManage}
                  wrapperClassName="w-32"
                />
                <Input
                  type="time"
                  label={t('hr.roster.shiftEnd')}
                  value={draft.endTime}
                  onChange={(e) => patch(shift.id, { endTime: e.target.value })}
                  size="sm"
                  disabled={!canManage}
                  wrapperClassName="w-32"
                />
                <Input
                  type="number"
                  min={0}
                  label={t('hr.roster.shiftBreak')}
                  value={draft.breakMinutes}
                  onChange={(e) => patch(shift.id, { breakMinutes: e.target.value })}
                  size="sm"
                  disabled={!canManage}
                  wrapperClassName="w-28"
                />
                {shift.locationId === null && (
                  <Badge variant="info" size="sm" className="mb-1.5">
                    {t('hr.roster.globalShift')}
                  </Badge>
                )}
                {canManage && (
                  <div className="ml-auto flex items-end gap-2">
                    <Button
                      size="sm"
                      // A company-wide template asks first — see the doc comment.
                      onClick={() =>
                        shift.locationId === null
                          ? setPending({ shift, kind: 'global' })
                          : void commit(shift)
                      }
                      disabled={!dirty}
                      loading={busyId === shift.id}
                    >
                      {t('common.save')}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setPending({ shift, kind: 'off' })}
                      disabled={busyId === shift.id}
                    >
                      {t('common.deactivate')}
                    </Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </CardContent>

      <Modal
        open={pending !== null}
        onClose={() => setPending(null)}
        title={
          pending?.kind === 'off' ? t('hr.roster.deactivateTitle') : t('hr.roster.globalEditTitle')
        }
        size="sm"
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setPending(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={pending?.kind === 'off' ? 'danger' : 'primary'}
              onClick={() => {
                if (!pending) return;
                const { shift, kind } = pending;
                setPending(null);
                void (kind === 'off' ? deactivate(shift) : commit(shift));
              }}
            >
              {pending?.kind === 'off' ? t('common.deactivate') : t('common.save')}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-text-secondary">
          {pending?.kind === 'off' ? t('hr.roster.deactivateBody') : t('hr.roster.globalEditBody')}
        </p>
      </Modal>
    </Card>
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
        <Input
          label={t('hr.roster.shiftName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          wrapperClassName="w-40"
        />
        <Input
          type="time"
          label={t('hr.roster.shiftStart')}
          value={startTime}
          onChange={(e) => setStartTime(e.target.value)}
          wrapperClassName="w-32"
        />
        <Input
          type="time"
          label={t('hr.roster.shiftEnd')}
          value={endTime}
          onChange={(e) => setEndTime(e.target.value)}
          wrapperClassName="w-32"
        />
        <Button onClick={submit} loading={busy}>
          {t('hr.roster.addShift')}
        </Button>
      </CardContent>
    </Card>
  );
}
