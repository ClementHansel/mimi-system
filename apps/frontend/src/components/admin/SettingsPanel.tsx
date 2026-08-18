'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { api, ApiError } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtDateTime } from '@/lib/dates';
import { toast } from '@/components/ui/Toast';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Textarea } from '@/components/ui/Textarea';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { PayrollStatutoryCard } from './PayrollStatutoryCard';
import type { Setting } from './types';

/**
 * F10 admin — Settings (CONTRACTS §4.20 M20). General namespaced settings
 * (company profile, approval thresholds, HR/sync parameters, …) plus the
 * payroll-statutory card. `payroll.statutory` itself never appears editable
 * in the general table below — the server rejects a raw PUT on that key with
 * `ERR_USE_WIZARD`, so the only path to it is `PayrollStatutoryCard`'s
 * enable/disable actions.
 */
export function SettingsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Setting | null>(null);

  function reload() {
    setLoading(true);
    api
      .get<Setting[]>('/settings')
      .then(setSettings)
      .finally(() => setLoading(false));
  }
  useEffect(reload, []);

  const columns: DataTableColumn<Setting>[] = [
    { key: 'key', header: t('admin.settings.columnKey') },
    { key: 'description', header: t('admin.settings.columnDescription') },
    {
      key: 'updatedBy',
      header: t('admin.settings.columnUpdatedBy'),
      render: (r) => r.updatedBy ?? '—',
    },
    {
      key: 'updatedAt',
      header: t('admin.settings.columnUpdatedAt'),
      render: (r) => fmtDateTime(r.updatedAt),
    },
  ];

  return (
    <Tabs defaultValue="general">
      <TabsList>
        <TabsTrigger value="general">{t('admin.settings.tabGeneral')}</TabsTrigger>
        <TabsTrigger value="payroll">{t('admin.settings.tabPayroll')}</TabsTrigger>
      </TabsList>
      <TabsContent value="general">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-secondary">{t('admin.settings.description')}</p>
          <DataTable
            columns={columns}
            data={{
              rows: settings.filter((s) => !s.key.startsWith('payroll.statutory')),
              total: settings.length,
              page: 1,
              pageSize: settings.length || 1,
            }}
            keyField={(r) => r.key}
            loading={loading}
            onRowClick={can('settings.manage') ? (r) => setEditing(r) : undefined}
          />
        </div>
      </TabsContent>
      <TabsContent value="payroll">
        <PermissionGate permission="payroll.statutory.read" showMessage>
          <PayrollStatutoryCard />
        </PermissionGate>
      </TabsContent>
      {editing && (
        <SettingEditModal
          setting={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </Tabs>
  );
}

function SettingEditModal({
  setting,
  onClose,
  onSaved,
}: {
  setting: Setting;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [raw, setRaw] = useState(JSON.stringify(setting.value, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function submit() {
    setError(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      setError(t('admin.settings.invalidJson'));
      return;
    }
    setSubmitting(true);
    try {
      await api.put(`/settings/${setting.key}`, { value: parsed });
      toast({ title: t('admin.settings.updateSuccess'), variant: 'success' });
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : t('auth.genericError'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={`${t('admin.settings.editTitle')} — ${setting.key}`}
      size="lg"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} loading={submitting}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-2">
        {error && <p className="text-sm text-danger-600">{error}</p>}
        <Textarea
          value={raw}
          onChange={(e) => setRaw(e.target.value)}
          hint={t('admin.settings.rawJsonHint')}
          rows={10}
          className="font-mono text-xs"
        />
      </div>
    </Modal>
  );
}
