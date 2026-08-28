'use client';

import { useEffect, useMemo, useState } from 'react';
import { Plus, Save } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { useSessionStore } from '@/stores/session-store';
import {
  Button,
  Modal,
  DataTable,
  StatusBadge,
  Select,
  Input,
  MoneyInput,
  Textarea,
  PhotoCapture,
  toast,
  PermissionGate,
  Card,
  CardContent,
} from '@/components/ui';
import type { DataTableColumn } from '@/components/ui';
import { fmtDate } from '@/lib/dates';
import { formatMoney } from '@/lib/formatters';
import { MasterDataIo } from '@/components/admin/MasterDataIo';
import { usePermissions } from '@/lib/permissions';
import {
  getAssets,
  createAsset,
  updateAsset,
  getSchedules,
  createSchedule,
  getAssetHistory,
  createJob,
  listLocationCodesByName,
  listEmployeeNumbersByName,
} from './lib/assets-api';
import { uploadAttachment } from './lib/attachments';
import { assetIoColumns } from './lib/io-columns';
import type { Asset, Schedule, ServiceHistoryRow } from './lib/types';
import type { Money } from '@/lib/shared-types';

const CATEGORIES = [
  'machine',
  'vehicle',
  'equipment',
  'electronics',
  'furniture',
  'other',
] as const;
const CONDITIONS = ['good', 'fair', 'poor'] as const;
const STATUSES = ['active', 'in_maintenance', 'retired', 'lost'] as const;

/**
 * Tab 1 — the asset register (FR-PMS-01): filterable list, create, and a
 * detail view that also surfaces this asset's schedules and service
 * history so a manager doesn't need to hop between tabs to see the whole
 * picture for one forklift/vehicle/laptop.
 */
export function AssetRegisterPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const locations = useSessionStore((s) => s.user?.locations ?? []);
  const [rows, setRows] = useState<Asset[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [locationId, setLocationId] = useState('');
  const [category, setCategory] = useState('');
  const [status, setStatus] = useState('');

  const [createOpen, setCreateOpen] = useState(false);
  const [detailAsset, setDetailAsset] = useState<Asset | null>(null);

  const [locationCodeByName, setLocationCodeByName] = useState<Map<string, string>>(new Map());
  const [employeeNumberByName, setEmployeeNumberByName] = useState<Map<string, string>>(new Map());
  const [exportRows, setExportRows] = useState<Asset[]>([]);

  function reload() {
    setLoading(true);
    getAssets({
      locationId: locationId || undefined,
      category: category || undefined,
      status: status || undefined,
      q: q || undefined,
    })
      .then((r) => setRows(r.rows))
      .catch(() => toast({ title: t('table.error'), variant: 'danger' }))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [locationId, category, status]);

  useEffect(() => {
    listLocationCodesByName().then(setLocationCodeByName);
    listEmployeeNumbersByName().then(setEmployeeNumberByName);
  }, []);

  /**
   * Every asset for import/export, independent of the on-screen filters —
   * bulk-editing master data means the whole register, not today's search.
   * `getAssets` caps a page at 100 (the number the on-screen table already
   * reads as "everything", since it has no pagination controls) — walked
   * here the same way `EmployeesPanel.loadExportSnapshot` walks past its own
   * page cap, bounded so a server that ignores `page` cannot spin forever.
   */
  async function loadExportSnapshot() {
    const all: Asset[] = [];
    for (let page = 1; page <= 40; page += 1) {
      const res = await getAssets({ page });
      all.push(...res.rows);
      if (res.rows.length === 0 || all.length >= res.total) break;
    }
    setExportRows(all);
  }
  useEffect(() => {
    loadExportSnapshot();
  }, []);

  function refreshAfterWrite() {
    reload();
    loadExportSnapshot();
  }

  const locationOptions = useMemo(
    () => locations.map((l) => ({ value: l.id, label: l.name })),
    [locations],
  );

  const columns: DataTableColumn<Asset>[] = [
    { key: 'assetNumber', header: t('assets.register.columnNumber') },
    { key: 'name', header: t('assets.register.columnName') },
    {
      key: 'category',
      header: t('assets.register.columnCategory'),
      render: (r) => t(`assets.category.${r.category}`),
    },
    { key: 'locationName', header: t('common.location') },
    {
      key: 'condition',
      header: t('assets.register.columnCondition'),
      render: (r) => t(`assets.condition.${r.condition}`),
    },
    {
      key: 'status',
      header: t('common.status'),
      render: (r) => <StatusBadge domain="asset" status={r.status} />,
    },
    {
      key: 'assignedToName',
      header: t('assets.register.columnAssignedTo'),
      render: (r) => r.assignedToName ?? '—',
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <Input
          label={t('common.filter')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && reload()}
          placeholder={t('assets.register.searchPlaceholder')}
          wrapperClassName="w-56"
        />
        <Select
          label={t('common.location')}
          value={locationId}
          onValueChange={setLocationId}
          options={locationOptions}
          placeholder={t('common.all')}
          wrapperClassName="w-44"
        />
        <Select
          label={t('assets.register.columnCategory')}
          value={category}
          onValueChange={setCategory}
          options={CATEGORIES.map((c) => ({ value: c, label: t(`assets.category.${c}`) }))}
          placeholder={t('common.all')}
          wrapperClassName="w-40"
        />
        <Select
          label={t('common.status')}
          value={status}
          onValueChange={setStatus}
          options={STATUSES.map((s) => ({ value: s, label: t(`status.asset.${s}`) }))}
          placeholder={t('common.all')}
          wrapperClassName="w-44"
        />
        <Button variant="outline" onClick={reload}>
          {t('common.filter')}
        </Button>
        <div className="flex-1" />
        {/* `rows` is the full-register snapshot (see `loadExportSnapshot`
            above), not the current filters — this is master data, and bulk
            edit means the whole register, not today's search. */}
        <MasterDataIo
          entity="assets"
          titleKey="assets.tabs.register"
          rows={exportRows}
          columns={assetIoColumns(locationCodeByName, employeeNumberByName)}
          filenameBase="aset"
          onImported={refreshAfterWrite}
          canImport={can('asset.manage')}
        />
        <PermissionGate permission="asset.manage">
          <Button leftIcon={<Plus className="size-4" />} onClick={() => setCreateOpen(true)}>
            {t('assets.register.createButton')}
          </Button>
        </PermissionGate>
      </div>

      <DataTable
        columns={columns}
        data={{ rows, total: rows.length, page: 1, pageSize: Math.max(rows.length, 1) }}
        keyField={(r) => r.id}
        loading={loading}
        onRowClick={setDetailAsset}
      />

      {createOpen && (
        <CreateAssetModal
          locationOptions={locationOptions}
          onClose={() => setCreateOpen(false)}
          onCreated={() => {
            setCreateOpen(false);
            refreshAfterWrite();
          }}
        />
      )}
      {detailAsset && (
        <AssetDetailModal
          asset={detailAsset}
          onClose={() => setDetailAsset(null)}
          onChanged={refreshAfterWrite}
        />
      )}
    </div>
  );
}

function CreateAssetModal({
  locationOptions,
  onClose,
  onCreated,
}: {
  locationOptions: { value: string; label: string }[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('equipment');
  const [locationId, setLocationId] = useState('');
  const [serialNumber, setSerialNumber] = useState('');
  const [brand, setBrand] = useState('');
  const [model, setModel] = useState('');
  const [purchasePrice, setPurchasePrice] = useState<Money | null>(null);
  const [photo, setPhoto] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const canSubmit = name.trim() !== '' && locationId !== '';

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      let photoAttachmentId: string | undefined;
      if (photo)
        photoAttachmentId = await uploadAttachment({
          file: photo,
          fileName: photo.name,
          mimeType: photo.type || 'image/jpeg',
          kind: 'asset_photo',
        });
      await createAsset({
        name: name.trim(),
        category,
        locationId,
        serialNumber: serialNumber || undefined,
        brand: brand || undefined,
        model: model || undefined,
        purchasePrice: purchasePrice ?? undefined,
        photoAttachmentId,
      });
      toast({ title: t('assets.register.createSuccess'), variant: 'success' });
      onCreated();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('assets.register.createTitle')} size="lg">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t('assets.register.columnName')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          label={t('assets.register.columnCategory')}
          value={category}
          onValueChange={setCategory}
          options={CATEGORIES.map((c) => ({ value: c, label: t(`assets.category.${c}`) }))}
        />
        <Select
          label={t('common.location')}
          value={locationId}
          onValueChange={setLocationId}
          options={locationOptions}
          placeholder={t('common.selectPlaceholder')}
          required
        />
        <Input
          label={t('assets.register.serialNumber')}
          value={serialNumber}
          onChange={(e) => setSerialNumber(e.target.value)}
        />
        <Input
          label={t('assets.register.brand')}
          value={brand}
          onChange={(e) => setBrand(e.target.value)}
        />
        <Input
          label={t('assets.register.model')}
          value={model}
          onChange={(e) => setModel(e.target.value)}
        />
        <MoneyInput
          label={t('assets.register.purchasePrice')}
          value={purchasePrice}
          onChange={setPurchasePrice}
        />
        <PhotoCapture
          label={t('assets.register.photoLabel')}
          value={photo ? URL.createObjectURL(photo) : null}
          onCapture={setPhoto}
          onRemove={() => setPhoto(null)}
        />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button loading={saving} disabled={!canSubmit} onClick={submit}>
          {t('common.save')}
        </Button>
      </div>
    </Modal>
  );
}

function AssetDetailModal({
  asset,
  onClose,
  onChanged,
}: {
  asset: Asset;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useI18n();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [history, setHistory] = useState<ServiceHistoryRow[]>([]);
  const [condition, setCondition] = useState(asset.condition);
  const [status, setStatus] = useState(asset.status);
  const [savingStatus, setSavingStatus] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [jobOpen, setJobOpen] = useState(false);

  useEffect(() => {
    getSchedules(asset.id)
      .then(setSchedules)
      .catch(() => setSchedules([]));
    getAssetHistory(asset.id)
      .then((r) => setHistory(r.rows))
      .catch(() => setHistory([]));
  }, [asset.id]);

  async function saveConditionStatus() {
    setSavingStatus(true);
    try {
      await updateAsset(asset.id, { condition, status });
      toast({ title: t('assets.register.updateSuccess'), variant: 'success' });
      onChanged();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSavingStatus(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={`${asset.assetNumber} — ${asset.name}`} size="xl">
      <div className="flex flex-col gap-5">
        <PermissionGate permission="asset.manage">
          <Card>
            <CardContent className="flex flex-wrap items-end gap-3">
              <Select
                label={t('assets.register.columnCondition')}
                value={condition}
                onValueChange={(v) => setCondition(v as Asset['condition'])}
                options={CONDITIONS.map((c) => ({ value: c, label: t(`assets.condition.${c}`) }))}
                wrapperClassName="w-40"
              />
              <Select
                label={t('common.status')}
                value={status}
                onValueChange={(v) => setStatus(v as Asset['status'])}
                options={STATUSES.map((s) => ({ value: s, label: t(`status.asset.${s}`) }))}
                wrapperClassName="w-44"
              />
              <Button
                leftIcon={<Save className="size-4" />}
                loading={savingStatus}
                onClick={saveConditionStatus}
              >
                {t('common.save')}
              </Button>
            </CardContent>
          </Card>
        </PermissionGate>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-text-primary">
              {t('assets.schedules.title')}
            </h3>
            <PermissionGate permission="asset.schedule.manage">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Plus className="size-4" />}
                onClick={() => setScheduleOpen(true)}
              >
                {t('assets.schedules.addButton')}
              </Button>
            </PermissionGate>
          </div>
          {schedules.length === 0 ? (
            <p className="text-sm text-text-muted">{t('assets.schedules.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {schedules.map((s) => (
                <li
                  key={s.id}
                  className="flex items-center justify-between rounded-md border border-border px-3 py-2"
                >
                  <span>{s.name}</span>
                  <span className="text-text-muted">
                    {t('assets.schedules.nextDue')}: {fmtDate(s.nextDueAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="font-display text-base font-semibold text-text-primary">
              {t('assets.jobs.newCorrective')}
            </h3>
            <PermissionGate permission="asset.job.execute">
              <Button
                size="sm"
                variant="outline"
                leftIcon={<Plus className="size-4" />}
                onClick={() => setJobOpen(true)}
              >
                {t('assets.jobs.newCorrective')}
              </Button>
            </PermissionGate>
          </div>
        </div>

        <div>
          <h3 className="mb-2 font-display text-base font-semibold text-text-primary">
            {t('assets.history.title')}
          </h3>
          {history.length === 0 ? (
            <p className="text-sm text-text-muted">{t('assets.history.empty')}</p>
          ) : (
            <ul className="flex flex-col gap-1.5 text-sm">
              {history.map((h, i) => (
                <li
                  key={i}
                  className="flex flex-col gap-0.5 rounded-md border border-border px-3 py-2"
                >
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-text-primary">{fmtDate(h.serviceDate)}</span>
                    <span className="tabular-nums text-text-muted">{formatMoney(h.cost)}</span>
                  </div>
                  <span className="text-text-secondary">{h.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {scheduleOpen && (
        <CreateScheduleModal
          assetId={asset.id}
          onClose={() => setScheduleOpen(false)}
          onCreated={() => {
            setScheduleOpen(false);
            getSchedules(asset.id).then(setSchedules);
          }}
        />
      )}
      {jobOpen && (
        <CreateJobModal
          assetId={asset.id}
          onClose={() => setJobOpen(false)}
          onCreated={() => {
            setJobOpen(false);
            onChanged();
          }}
        />
      )}
    </Modal>
  );
}

function CreateScheduleModal({
  assetId,
  onClose,
  onCreated,
}: {
  assetId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState('');
  const [intervalType, setIntervalType] = useState<'days' | 'months'>('months');
  const [intervalValue, setIntervalValue] = useState('1');
  const [nextDueAt, setNextDueAt] = useState('');
  const [reminderDaysBefore, setReminderDaysBefore] = useState('7');
  const [saving, setSaving] = useState(false);
  const canSubmit = name.trim() !== '' && nextDueAt !== '' && Number(intervalValue) > 0;

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await createSchedule(assetId, {
        name: name.trim(),
        intervalType,
        intervalValue: Number(intervalValue),
        nextDueAt,
        reminderDaysBefore: Number(reminderDaysBefore) || undefined,
      });
      toast({ title: t('assets.schedules.createSuccess'), variant: 'success' });
      onCreated();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('assets.schedules.addButton')} size="md">
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          wrapperClassName="sm:col-span-2"
          label={t('assets.schedules.name')}
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <Select
          label={t('assets.schedules.intervalType')}
          value={intervalType}
          onValueChange={(v) => setIntervalType(v as 'days' | 'months')}
          options={[
            { value: 'days', label: t('assets.schedules.days') },
            { value: 'months', label: t('assets.schedules.months') },
          ]}
        />
        <Input
          label={t('assets.schedules.intervalValue')}
          type="number"
          min={1}
          value={intervalValue}
          onChange={(e) => setIntervalValue(e.target.value)}
        />
        <Input
          label={t('assets.schedules.nextDueAt')}
          type="date"
          value={nextDueAt}
          onChange={(e) => setNextDueAt(e.target.value)}
          required
        />
        <Input
          label={t('assets.schedules.reminderDaysBefore')}
          type="number"
          min={0}
          value={reminderDaysBefore}
          onChange={(e) => setReminderDaysBefore(e.target.value)}
        />
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button loading={saving} disabled={!canSubmit} onClick={submit}>
          {t('common.save')}
        </Button>
      </div>
    </Modal>
  );
}

function CreateJobModal({
  assetId,
  onClose,
  onCreated,
}: {
  assetId: string;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useI18n();
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const canSubmit = description.trim() !== '';

  async function submit() {
    if (!canSubmit) return;
    setSaving(true);
    try {
      await createJob(assetId, description.trim());
      toast({ title: t('assets.jobs.createSuccess'), variant: 'success' });
      onCreated();
    } catch {
      toast({ title: t('table.error'), variant: 'danger' });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open onClose={onClose} title={t('assets.jobs.newCorrective')} size="sm">
      <div className="flex flex-col gap-4">
        <Textarea
          label={t('assets.jobs.descriptionLabel')}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <Button loading={saving} disabled={!canSubmit} onClick={submit}>
          {t('common.submit')}
        </Button>
      </div>
    </Modal>
  );
}
