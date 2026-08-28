'use client';

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { toast } from '@/components/ui/Toast';
import {
  Button,
  Card,
  CardContent,
  DataTable,
  Modal,
  Input,
  Select,
  StatusBadge,
  Badge,
  Textarea,
  PermissionGate,
} from '@/components/ui';
import { usePermissions } from '@/lib/permissions';
import { useSessionStore } from '@/stores/session-store';
import { fmtDateTime } from '@/lib/dates';
import { ExportButton } from '@/components/common/ExportButton';
import { correctAttendance, listAttendance } from './lib/hr-api';
import { ATTENDANCE_EXPORT_COLUMNS } from './lib/io-columns';
import type { AttendanceRow } from './lib/types';
import type { Paginated } from '@/lib/shared-types';

/**
 * F08 `hr` — attendance review (`hr.attendance.read`/`.correct`, FR-HR-03).
 * `timeSuspect` rows (W3-09's device-clock-untrustworthy tag) are surfaced
 * with a dedicated toggle and a warning badge rather than buried in the
 * general list — HR has to actually work these, per the ticket brief.
 */
export function AttendancePanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const user = useSessionStore((s) => s.user);
  const locations = user?.locations ?? [];
  const [locationId, setLocationId] = useState('');
  const [date, setDate] = useState('');
  const [suspectOnly, setSuspectOnly] = useState(false);
  const [data, setData] = useState<Paginated<AttendanceRow>>({
    rows: [],
    total: 0,
    page: 1,
    pageSize: 50,
  });
  const [loading, setLoading] = useState(true);
  const [correcting, setCorrecting] = useState<AttendanceRow | null>(null);

  function reload() {
    setLoading(true);
    listAttendance({
      locationId: locationId || undefined,
      date: date || undefined,
      page: data.page,
    })
      .then(setData)
      .finally(() => setLoading(false));
  }

  useEffect(reload, [locationId, date, data.page]);

  const visibleRows = suspectOnly ? data.rows.filter((r) => r.timeSuspect) : data.rows;
  const suspectCount = data.rows.filter((r) => r.timeSuspect).length;

  /**
   * Every page for the current location/date filters — this screen is
   * server-paginated (50/page), so `rows` alone is one page. Walks with an
   * explicit page cursor (same pattern as
   * `SupplierPriceHistoryPanel.fetchAllHistory`), stops on a short page or
   * once it has `total`, and hard-stops at 200 pages so a server that
   * ignores `page` cannot spin here forever. NOT wired for import — see
   * `io-columns.ts`'s header: a bulk write here would skip the
   * geofence/selfie anti-fraud check (D-11/FR-HR-03) that every check-in
   * goes through.
   */
  async function fetchAllAttendance(): Promise<AttendanceRow[]> {
    const all: AttendanceRow[] = [];
    const size = 200;
    for (let p = 1; p <= 200; p += 1) {
      const res = await listAttendance({
        locationId: locationId || undefined,
        date: date || undefined,
        page: p,
      });
      all.push(...res.rows);
      if (res.rows.length < size || all.length >= res.total) break;
    }
    return all;
  }

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3">
          <Select
            label={t('hr.attendance.location')}
            value={locationId}
            onValueChange={setLocationId}
            options={[
              { value: '', label: t('hr.attendance.allLocations') },
              ...locations.map((l) => ({ value: l.id, label: l.name })),
            ]}
            wrapperClassName="w-56"
          />
          <Input
            type="date"
            label={t('hr.attendance.date')}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            wrapperClassName="w-40"
          />
          <Button
            variant={suspectOnly ? 'primary' : 'outline'}
            leftIcon={<AlertTriangle className="size-4" />}
            onClick={() => setSuspectOnly((v) => !v)}
          >
            {t('hr.attendance.suspectFilter')}
            {suspectCount > 0 && (
              <Badge variant="warning" size="sm" className="ml-1">
                {suspectCount}
              </Badge>
            )}
          </Button>
          <ExportButton
            rows={visibleRows}
            columns={ATTENDANCE_EXPORT_COLUMNS}
            filenameBase="absensi"
            fetchAll={fetchAllAttendance}
          />
        </CardContent>
      </Card>

      <DataTable
        columns={[
          { key: 'employeeName', header: t('hr.attendance.columnEmployee') },
          { key: 'date', header: t('hr.attendance.columnDate') },
          {
            key: 'checkInAt',
            header: t('hr.attendance.columnCheckIn'),
            render: (r) => (r.checkInAt ? fmtDateTime(r.checkInAt) : '—'),
          },
          {
            key: 'checkOutAt',
            header: t('hr.attendance.columnCheckOut'),
            render: (r) => (r.checkOutAt ? fmtDateTime(r.checkOutAt) : '—'),
          },
          { key: 'lateMinutes', header: t('hr.attendance.columnLate'), align: 'right' },
          { key: 'overtimeMinutes', header: t('hr.attendance.columnOvertime'), align: 'right' },
          {
            key: 'geofenceOk',
            header: t('hr.attendance.columnGeofence'),
            render: (r) =>
              r.geofenceOk ? (
                <Badge variant="success" size="sm">
                  {t('hr.attendance.geofenceOk')}
                </Badge>
              ) : (
                <Badge variant="danger" size="sm">
                  {t('hr.attendance.geofenceOut')}
                </Badge>
              ),
          },
          {
            key: 'status',
            header: t('hr.attendance.columnStatus'),
            render: (r) => (
              <div className="flex items-center gap-1.5">
                <StatusBadge domain="attendance" status={r.status} size="sm" />
                {r.timeSuspect && (
                  <Badge variant="warning" size="sm" title={t('hr.attendance.timeSuspectHint')}>
                    <AlertTriangle className="size-3" aria-hidden />
                    {t('hr.attendance.timeSuspect')}
                  </Badge>
                )}
              </div>
            ),
          },
        ]}
        data={{ ...data, rows: visibleRows, total: suspectOnly ? visibleRows.length : data.total }}
        keyField={(r) => r.id}
        loading={loading}
        onPageChange={(page) => setData((d) => ({ ...d, page }))}
        onRowClick={can('hr.attendance.correct') ? (row) => setCorrecting(row) : undefined}
        emptyDescription={suspectOnly ? t('hr.attendance.noSuspectRows') : undefined}
      />

      {correcting && (
        <PermissionGate permission="hr.attendance.correct">
          <CorrectionModal
            row={correcting}
            onClose={() => setCorrecting(null)}
            onSaved={() => {
              setCorrecting(null);
              reload();
            }}
          />
        </PermissionGate>
      )}
    </div>
  );
}

function CorrectionModal({
  row,
  onClose,
  onSaved,
}: {
  row: AttendanceRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState(row.status);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason.trim()) return;
    setBusy(true);
    try {
      await correctAttendance(row.id, { status, correctionReason: reason });
      toast({ title: t('hr.attendance.correctSuccess'), variant: 'success' });
      onSaved();
    } catch {
      toast({ title: t('auth.genericError'), variant: 'danger' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('hr.attendance.correctTitle', { name: row.employeeName })}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={busy} disabled={!reason.trim()}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {row.timeSuspect && (
          <div className="rounded-md border border-warning-600/30 bg-warning-50 p-3 text-sm text-warning-700">
            <AlertTriangle className="mb-1 size-4" aria-hidden />{' '}
            {t('hr.attendance.timeSuspectHint')}
          </div>
        )}
        <Select
          label={t('hr.attendance.columnStatus')}
          value={status}
          onValueChange={setStatus}
          options={['present', 'late', 'absent', 'sick', 'permission', 'leave'].map((s) => ({
            value: s,
            label: t(`status.attendance.${s}`),
          }))}
        />
        <Textarea
          label={t('hr.attendance.correctionReason')}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          required
        />
      </div>
    </Modal>
  );
}
