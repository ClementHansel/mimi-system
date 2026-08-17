'use client';

import { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { ApiError } from '@/lib/api';
import { SuratJalanStatus, type SuratJalan } from '@/lib/shared-types';
import { Button, DataTable, Input, Select, StatusBadge, PermissionGate, type DataTableColumn } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { listSuratJalan } from './lib/delivery-api';
import { routeCompletion } from './lib/drop-progress';
import { TruckTypeBadge } from './TruckTypeLegend';
import { CreateSuratJalanModal } from './CreateSuratJalanModal';
import { SuratJalanDetailDrawer } from './SuratJalanDetailDrawer';

function errMsg(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * F-DELIVERY — the dispatcher's Surat Jalan list. Filterable by status and
 * planned date (CONTRACTS §4.10's `GET /delivery/surat-jalan?status=&date=`
 * — neither filter is wired up in `components/warehouse/SuratJalanPanel.tsx`
 * today even though the endpoint already supports both). No indefinite
 * spinner and a real error/empty state come from `DataTable` itself (its
 * `loading` prop renders a bounded skeleton, `error` renders the failure
 * message, and zero rows render `emptyDescription` — never a bare spinner).
 */
export function DeliverySuratJalanList() {
  const { t } = useI18n();
  const [status, setStatus] = useState('');
  const [date, setDate] = useState('');
  const [rows, setRows] = useState<SuratJalan[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  function reload() {
    setLoading(true);
    setError(undefined);
    listSuratJalan({ status: status || undefined, date: date || undefined })
      .then((res) => setRows(res.rows))
      .catch((err: unknown) => setError(errMsg(err, t('table.error'))))
      .finally(() => setLoading(false));
  }

  useEffect(reload, [status, date]);

  const hasFilters = status !== '' || date !== '';

  const columns: DataTableColumn<SuratJalan>[] = [
    { key: 'sjNumber', header: t('delivery.columnNumber') },
    { key: 'truckType', header: t('delivery.columnTruckType'), render: (r) => <TruckTypeBadge shipmentType={r.shipmentType} size="sm" /> },
    { key: 'destinations', header: t('delivery.columnDestinations'), render: (r) => r.drops.map((d) => d.locationName).join(', ') || '—' },
    { key: 'driver', header: t('delivery.columnDriver'), render: (r) => r.driver.name },
    { key: 'vehicle', header: t('delivery.columnVehicle'), render: (r) => r.vehicle.plateNumber },
    { key: 'plannedDate', header: t('delivery.columnPlannedDate'), render: (r) => fmtDate(r.plannedDate) },
    {
      key: 'progress',
      header: t('delivery.columnProgress'),
      align: 'right',
      render: (r) => {
        const { done, total } = routeCompletion(r.drops);
        return t('delivery.detail.dropOf', { done, total });
      },
    },
    { key: 'status', header: t('delivery.columnStatus'), render: (r) => <StatusBadge domain="suratJalan" status={r.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <Select
            label={t('delivery.columnStatus')}
            value={status}
            onValueChange={setStatus}
            placeholder={t('delivery.filterStatusAll')}
            options={Object.values(SuratJalanStatus).map((v) => ({ value: v, label: t(`status.suratJalan.${v}`) }))}
            wrapperClassName="w-48"
          />
          <Input type="date" label={t('delivery.filterDate')} value={date} onChange={(e) => setDate(e.target.value)} wrapperClassName="w-44" />
          {hasFilters && (
            <Button variant="ghost" size="sm" leftIcon={<X className="size-3.5" />} onClick={() => { setStatus(''); setDate(''); }}>
              {t('delivery.clearFilters')}
            </Button>
          )}
        </div>
        <PermissionGate permission="delivery.sj.create">
          <Button leftIcon={<Plus className="size-4" />} size="touch" onClick={() => setCreateOpen(true)}>
            {t('delivery.new')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        error={error}
        emptyDescription={t('delivery.empty')}
        onRowClick={(r) => setSelectedId(r.id)}
      />

      {createOpen && (
        <CreateSuratJalanModal
          onClose={() => setCreateOpen(false)}
          onCreated={() => { setCreateOpen(false); reload(); }}
        />
      )}

      {selectedId && (
        <SuratJalanDetailDrawer id={selectedId} onClose={() => setSelectedId(null)} onChanged={reload} />
      )}
    </div>
  );
}
