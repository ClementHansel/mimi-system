'use client';

import { useEffect, useState } from 'react';
import { Plus, Trash2, Truck, Pencil, Ban } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import {
  Button, Modal, DataTable, StatusBadge, TempInput, Input, Select, Textarea, toast, PermissionGate,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { formatQty, formatTemp } from '@/lib/formatters';
import { fmtDate } from '@/lib/dates';
import {
  listSuratJalan, getSuratJalan, createSuratJalan, patchSuratJalan, readySuratJalan, loadSuratJalan, dispatchSuratJalan,
  cancelSuratJalan, listWarehouseQueue, getDrivers, getVehicles,
} from './lib/warehouse-api';
import { SjCreateForm, type CreateSjPayload } from './SjCreateForm';
import type { SuratJalan, Replenishment, Driver, Vehicle } from './lib/types';
import type { Temp } from '@/lib/shared-types';

const EDITABLE_STATUSES = new Set(['draft', 'ready']);
const CANCELLABLE_STATUSES = new Set(['draft', 'ready', 'loading']);

/**
 * The Surat Jalan builder — the core warehouse screen. Picks approved
 * replenishment requests (`SjCreateForm` owns the FR-LOG-02 frozen/dry split
 * gate), assigns driver + vehicle, then walks the SJ through
 * ready → load (seal numbers + load temp for frozen, D-14) → dispatch.
 *
 * `Edit`/`Batalkan` cover the real-world gap of a mis-built SJ before
 * dispatch (wrong driver/vehicle/date, or the whole shipment needs
 * scrapping) — draft/ready SJs can be patched, and draft/ready/loading SJs
 * can be cancelled with a mandatory reason (CONTRACTS §4.10).
 */
export function SuratJalanPanel() {
  const { t } = useI18n();
  const [rows, setRows] = useState<SuratJalan[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [approvedRequests, setApprovedRequests] = useState<Replenishment[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [creating, setCreating] = useState(false);

  const [detail, setDetail] = useState<SuratJalan | null>(null);
  const [loadOpen, setLoadOpen] = useState(false);
  const [seals, setSeals] = useState<string[]>(['']);
  const [loadTemp, setLoadTemp] = useState<Temp | null>(null);
  const [acting, setActing] = useState(false);

  const [editOpen, setEditOpen] = useState(false);
  const [editDriverId, setEditDriverId] = useState('');
  const [editVehicleId, setEditVehicleId] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editNotes, setEditNotes] = useState('');

  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');

  function reload() {
    setLoading(true);
    listSuratJalan()
      .then((res) => setRows(res.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }

  useEffect(reload, []);

  useEffect(() => {
    if (!createOpen) return;
    listWarehouseQueue('approved').then((res) => setApprovedRequests(res.rows));
    getDrivers().then(setDrivers);
    getVehicles().then(setVehicles);
  }, [createOpen]);

  async function openDetail(row: SuratJalan) {
    const full = await getSuratJalan(row.id);
    setDetail(full);
    if (drivers.length === 0) getDrivers().then(setDrivers);
    if (vehicles.length === 0) getVehicles().then(setVehicles);
  }

  function openEdit() {
    if (!detail) return;
    setEditDriverId(detail.driver.id);
    setEditVehicleId(detail.vehicle.id);
    setEditDate(detail.plannedDate);
    setEditNotes('');
    setEditOpen(true);
  }

  async function submitEdit() {
    if (!detail) return;
    setActing(true);
    try {
      const updated = await patchSuratJalan(detail.id, {
        driverId: editDriverId || undefined,
        vehicleId: editVehicleId || undefined,
        plannedDate: editDate || undefined,
        notes: editNotes || undefined,
      });
      setDetail(updated);
      setEditOpen(false);
      reload();
      toast({ title: t('warehouse.sj.updated'), variant: 'success' });
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setActing(false);
    }
  }

  function openCancel() {
    setCancelReason('');
    setCancelOpen(true);
  }

  async function submitCancel() {
    if (!detail || cancelReason.trim() === '') return;
    setActing(true);
    try {
      const updated = await cancelSuratJalan(detail.id, { reason: cancelReason.trim() });
      setDetail(updated);
      setCancelOpen(false);
      reload();
      toast({ title: t('warehouse.sj.cancelled'), variant: 'success' });
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setActing(false);
    }
  }

  async function handleCreate(payload: CreateSjPayload) {
    setCreating(true);
    try {
      await createSuratJalan({
        shipmentType: payload.shipmentType,
        driverId: payload.driverId,
        vehicleId: payload.vehicleId,
        plannedDate: payload.plannedDate,
        notes: payload.notes,
        drops: payload.drops.map((d) => ({
          locationId: d.locationId,
          replenishmentRequestId: d.replenishmentRequestId,
          lines: d.lines.map((l) => ({ itemId: l.itemId, qty: l.qty, unitId: l.unitId })),
        })),
      });
      toast({ title: t('warehouse.sj.created'), variant: 'success' });
      setCreateOpen(false);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setCreating(false);
    }
  }

  async function handleReady() {
    if (!detail) return;
    setActing(true);
    try {
      const updated = await readySuratJalan(detail.id);
      setDetail(updated);
      reload();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setActing(false);
    }
  }

  function openLoad() {
    setSeals(['']);
    setLoadTemp(null);
    setLoadOpen(true);
  }

  async function submitLoad() {
    if (!detail) return;
    const sealNumbers = seals.map((s) => s.trim()).filter(Boolean);
    if (sealNumbers.length === 0) {
      toast({ title: t('warehouse.sj.sealRequired'), variant: 'warning' });
      return;
    }
    if (detail.shipmentType === 'frozen' && !loadTemp) {
      toast({ title: t('warehouse.sj.tempRequired'), variant: 'warning' });
      return;
    }
    setActing(true);
    try {
      const updated = await loadSuratJalan(detail.id, { seals: sealNumbers.map((sealNumber) => ({ sealNumber })), tempC: loadTemp ?? undefined });
      setDetail(updated);
      setLoadOpen(false);
      reload();
      toast({ title: t('warehouse.sj.loaded'), variant: 'success' });
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setActing(false);
    }
  }

  async function handleDispatch() {
    if (!detail) return;
    setActing(true);
    try {
      const updated = await dispatchSuratJalan(detail.id);
      setDetail(updated);
      reload();
      toast({ title: t('warehouse.sj.dispatched'), variant: 'success' });
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setActing(false);
    }
  }

  const columns: DataTableColumn<SuratJalan>[] = [
    { key: 'sjNumber', header: t('warehouse.sj.number') },
    { key: 'shipmentType', header: t('warehouse.sj.shipmentType'), render: (r) => t(`warehouse.sj.${r.shipmentType}`) },
    { key: 'driver', header: t('warehouse.sj.driver'), render: (r) => r.driver.name },
    { key: 'vehicle', header: t('warehouse.sj.vehicle'), render: (r) => r.vehicle.plateNumber },
    { key: 'plannedDate', header: t('warehouse.sj.plannedDate'), render: (r) => fmtDate(r.plannedDate) },
    { key: 'drops', header: t('warehouse.sj.dropsCount'), align: 'right', render: (r) => r.drops.length },
    { key: 'status', header: t('common.status'), render: (r) => <StatusBadge domain="suratJalan" status={r.status} /> },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end">
        <PermissionGate permission="delivery.sj.create">
          <Button leftIcon={<Plus className="size-4" />} size="touch" onClick={() => setCreateOpen(true)}>
            {t('warehouse.sj.new')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        onRowClick={openDetail}
        emptyDescription={t('warehouse.sj.empty')}
      />

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title={t('warehouse.sj.new')} size="xl">
        <SjCreateForm requests={approvedRequests} drivers={drivers} vehicles={vehicles} submitting={creating} onSubmit={handleCreate} />
      </Modal>

      <Modal open={!!detail} onClose={() => setDetail(null)} title={detail?.sjNumber ?? ''} size="xl">
        {detail && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <StatusBadge domain="suratJalan" status={detail.status} />
              <span className="text-sm text-text-muted">{t(`warehouse.sj.${detail.shipmentType}`)} — {detail.vehicle.plateNumber} — {detail.driver.name}</span>
            </div>

            {detail.drops.map((drop, idx) => (
              <div key={drop.id} className="rounded-lg border border-border p-3">
                <div className="mb-2 flex items-center justify-between">
                  <p className="font-medium text-text-primary">
                    {t('warehouse.sj.dropSeq', { seq: idx + 1 })} — {drop.locationName}
                  </p>
                  <StatusBadge domain="drop" status={drop.status} size="sm" />
                </div>
                <table className="w-full border-collapse text-sm">
                  <tbody>
                    {drop.lines.map((l) => (
                      <tr key={l.id} className="border-b border-border last:border-0">
                        <td className="py-1.5 text-text-primary">{l.itemName}</td>
                        <td className="py-1.5 text-right tabular-nums">{formatQty(l.qty, l.unitCode)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

            {detail.seals.length > 0 && (
              <div className="text-sm">
                <span className="font-medium text-text-primary">{t('warehouse.sj.seals')}: </span>
                {detail.seals.map((s) => s.sealNumber).join(', ')}
              </div>
            )}
            {detail.tempLogs.length > 0 && (
              <div className="text-sm">
                <span className="font-medium text-text-primary">{t('warehouse.sj.tempLogs')}: </span>
                {detail.tempLogs.map((log) => `${t(`warehouse.sj.stage.${log.stage}`)}: ${formatTemp(log.tempC)}`).join(' · ')}
              </div>
            )}

            <div className="flex flex-wrap justify-end gap-2">
              <PermissionGate permission="delivery.sj.create">
                {EDITABLE_STATUSES.has(detail.status) && (
                  <Button variant="outline" leftIcon={<Pencil className="size-4" />} onClick={openEdit}>{t('warehouse.sj.edit')}</Button>
                )}
              </PermissionGate>
              <PermissionGate permission="delivery.sj.cancel">
                {CANCELLABLE_STATUSES.has(detail.status) && (
                  <Button variant="danger" leftIcon={<Ban className="size-4" />} onClick={openCancel}>{t('warehouse.sj.cancel')}</Button>
                )}
              </PermissionGate>
              <PermissionGate permission="delivery.sj.create">
                {detail.status === 'draft' && (
                  <Button variant="outline" loading={acting} onClick={handleReady}>{t('warehouse.sj.markReady')}</Button>
                )}
              </PermissionGate>
              <PermissionGate permission="delivery.sj.dispatch">
                {detail.status === 'ready' && (
                  <Button leftIcon={<Truck className="size-4" />} onClick={openLoad}>{t('warehouse.sj.load')}</Button>
                )}
                {detail.status === 'loading' && (
                  <Button leftIcon={<Truck className="size-4" />} loading={acting} onClick={handleDispatch}>{t('warehouse.sj.dispatch')}</Button>
                )}
              </PermissionGate>
            </div>
          </div>
        )}
      </Modal>

      <Modal open={editOpen} onClose={() => setEditOpen(false)} title={t('warehouse.sj.edit')} size="md">
        <div className="flex flex-col gap-4">
          <Select
            label={t('warehouse.sj.driver')}
            value={editDriverId}
            onValueChange={setEditDriverId}
            options={drivers.map((d) => ({ value: d.id, label: d.name }))}
            placeholder={t('common.selectPlaceholder')}
            disabled={acting}
          />
          <Select
            label={t('warehouse.sj.vehicle')}
            value={editVehicleId}
            onValueChange={setEditVehicleId}
            options={vehicles.map((v) => ({ value: v.id, label: `${v.plateNumber}${v.hasFreezer ? ' ❄' : ''}` }))}
            placeholder={t('common.selectPlaceholder')}
            disabled={acting}
          />
          <Input type="date" label={t('warehouse.sj.plannedDate')} value={editDate} onChange={(e) => setEditDate(e.target.value)} disabled={acting} />
          <Textarea label={t('common.notes')} value={editNotes} onChange={(e) => setEditNotes(e.target.value)} disabled={acting} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setEditOpen(false)}>{t('common.cancel')}</Button>
          <Button loading={acting} onClick={submitEdit}>{t('common.save')}</Button>
        </div>
      </Modal>

      <Modal open={cancelOpen} onClose={() => setCancelOpen(false)} title={t('warehouse.sj.cancel')} size="md">
        <div className="flex flex-col gap-4">
          <Textarea
            label={t('warehouse.sj.cancelReason')}
            required
            value={cancelReason}
            onChange={(e) => setCancelReason(e.target.value)}
            error={cancelReason.trim() === '' ? t('validation.reasonRequired') : undefined}
            disabled={acting}
          />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setCancelOpen(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" loading={acting} disabled={cancelReason.trim() === ''} onClick={submitCancel}>{t('warehouse.sj.confirmCancel')}</Button>
        </div>
      </Modal>

      <Modal open={loadOpen} onClose={() => setLoadOpen(false)} title={t('warehouse.sj.load')} size="md">
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium text-text-primary">{t('warehouse.sj.seals')}</span>
            {seals.map((s, idx) => (
              <div key={idx} className="flex gap-2">
                <Input
                  value={s}
                  onChange={(e) => setSeals((prev) => prev.map((v, i) => (i === idx ? e.target.value : v)))}
                  placeholder={t('warehouse.sj.sealNumber')}
                  wrapperClassName="flex-1"
                />
                {seals.length > 1 && (
                  <Button type="button" variant="ghost" size="sm" onClick={() => setSeals((prev) => prev.filter((_, i) => i !== idx))}>
                    <Trash2 className="size-4" />
                  </Button>
                )}
              </div>
            ))}
            <Button type="button" variant="outline" size="sm" leftIcon={<Plus className="size-4" />} onClick={() => setSeals((prev) => [...prev, ''])}>
              {t('warehouse.sj.addSeal')}
            </Button>
          </div>
          {detail?.shipmentType === 'frozen' && (
            <TempInput label={t('warehouse.sj.loadTemp')} required value={loadTemp} onChange={setLoadTemp} />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setLoadOpen(false)}>{t('common.cancel')}</Button>
          <Button loading={acting} onClick={submitLoad}>{t('common.submit')}</Button>
        </div>
      </Modal>
    </div>
  );
}
