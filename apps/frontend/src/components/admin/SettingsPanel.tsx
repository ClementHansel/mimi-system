'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n';
import { api } from '@/lib/api';
import { usePermissions } from '@/lib/permissions';
import { fmtDateTime } from '@/lib/dates';
import { DataTable, type DataTableColumn } from '@/components/ui/DataTable';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { PermissionGate } from '@/components/ui/PermissionGate';
import { ExportButton } from '@/components/common/ExportButton';
import { PayrollStatutoryCard } from './PayrollStatutoryCard';
import { SettingDetailModal } from './SettingDetailModal';
import {
  SETTING_SECTIONS,
  sectionFor,
  specFor,
  type SettingSection,
} from './lib/settings-registry';
import { formatSettingValue } from './lib/settings-format';
import { settingIoColumns } from './lib/io-columns';
import type { Setting } from './types';
import { errMsg } from '@/lib/api-error';

/**
 * F10 admin — Settings (CONTRACTS §4.20 M20), redesigned on the owner's
 * 2026-08-21 verdict: "this is confusing for normal user".
 *
 * What it used to be: one flat table of 22 rows showing the RAW KEY
 * (`approval.threshold.opname`), the developer's English description ("Stock
 * opname manager escalation threshold (§5.4)"), who changed it and when — and
 * no value. The single question anyone opens this screen with ("what IS the
 * void limit right now?") could not be answered without clicking into a JSON
 * textarea.
 *
 * What it is now: grouped by the part of the business it governs, each row
 * naming the setting in Indonesian and SHOWING ITS VALUE formatted for its type
 * (Rp 200.000, 200 m, 5 menit, Ya/Tidak). The detail modal explains what
 * changing it does and edits it through typed fields —
 * `settings-registry.ts` holds that mapping.
 *
 * `payroll.statutory` and `approval.mode` stay read-only here and point at
 * their own screens: the server rejects a raw PUT on the first
 * (`ERR_USE_WIZARD`) and the second has guard rails around switching an
 * approval chain off that a raw edit would bypass.
 */
export function SettingsPanel() {
  const { t } = useI18n();
  const { can } = usePermissions();
  const [settings, setSettings] = useState<Setting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Setting | null>(null);
  const [q, setQ] = useState('');

  function reload() {
    setLoading(true);
    setError(null);
    api
      .get<Setting[]>('/settings')
      .then(setSettings)
      // A failed load used to leave an empty table that looked like "no
      // settings exist" — indistinguishable from a 403.
      .catch((err: unknown) => setError(errMsg(err, t('table.error'))))
      .finally(() => setLoading(false));
  }
  useEffect(reload, [t]);

  const columns: DataTableColumn<Setting>[] = [
    {
      key: 'key',
      header: t('admin.settings.columnSetting'),
      render: (r) => {
        const spec = specFor(r.key);
        return (
          <div className="flex flex-col">
            <span className="text-text-primary">{spec ? t(spec.labelKey) : r.key}</span>
            {/* The raw key stays visible but subordinate: support needs it,
                the owner does not read it first. */}
            <span className="font-mono text-xs text-text-muted">{r.key}</span>
          </div>
        );
      },
    },
    {
      key: 'value',
      header: t('admin.settings.columnValue'),
      // THE column the old table did not have.
      render: (r) => (
        <span className="font-medium tabular-nums text-text-primary">
          {formatSettingValue(r.key, r.value, t)}
        </span>
      ),
    },
    {
      key: 'updatedBy',
      header: t('admin.settings.columnUpdatedBy'),
      render: (r) => (
        <span className="text-text-secondary">
          {r.updatedBy ? `${r.updatedBy} · ${fmtDateTime(r.updatedAt)}` : '—'}
        </span>
      ),
    },
  ];

  const query = q.trim().toLowerCase();
  const visible = settings.filter((setting) => {
    if (!query) return true;
    const spec = specFor(setting.key);
    const label = spec ? t(spec.labelKey).toLowerCase() : '';
    // Searchable by BOTH the human name and the raw key — an owner types
    // "geofence", a developer pastes `hr.geofence_radius_m`.
    return setting.key.toLowerCase().includes(query) || label.includes(query);
  });

  const bySection = new Map<SettingSection, Setting[]>();
  for (const setting of visible) {
    const section = sectionFor(setting.key);
    const list = bySection.get(section) ?? [];
    list.push(setting);
    bySection.set(section, list);
  }

  return (
    <Tabs defaultValue="general">
      <TabsList>
        <TabsTrigger value="general">{t('admin.settings.tabGeneral')}</TabsTrigger>
        <TabsTrigger value="payroll">{t('admin.settings.tabPayroll')}</TabsTrigger>
      </TabsList>

      <TabsContent value="general">
        <div className="flex flex-col gap-4">
          <p className="text-sm text-text-secondary">{t('admin.settings.description')}</p>

          {/*
            RISK-P5/S1 — the LAN branch-node switch is NOT here, and this card
            exists so nobody concludes it is missing.

            It is per-OUTLET, not global: each outlet independently either runs
            a branch node on its LAN or syncs straight to the cloud (the
            default). A global toggle on this page would be the wrong shape for
            that, and turning one off is also not a plain switch — D-26 requires
            the node's relay queue to be drained first, so the control lives
            next to the node's live status where that queue is visible.

            Owner-only, matching the server (`OutletNodeSettingController
            .setEnabled` checks the role on top of the `node.manage`
            permission), so the pointer is gated the same way rather than
            leading a manager to a control they cannot use.
          */}
          {can('node.manage') && (
            <Card>
              <CardHeader>
                <CardTitle>{t('admin.settings.lanNode.title')}</CardTitle>
                <p className="text-sm text-text-muted">{t('admin.settings.lanNode.hint')}</p>
              </CardHeader>
              <CardContent>
                <Link
                  href="/topology"
                  className="text-sm font-medium text-brand-600 underline underline-offset-2"
                >
                  {t('admin.settings.lanNode.link')}
                </Link>
              </CardContent>
            </Card>
          )}

          <div className="flex flex-wrap items-end justify-between gap-2">
            <Input
              placeholder={t('admin.settings.searchPlaceholder')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              wrapperClassName="w-72"
            />
            {/* Export only, deliberately — `settings` is not a bulk-importer
                entity at all (not in `ImportEntityName`), and could not
                sensibly be one: it is a fixed, heterogeneous key/value table
                (money, booleans, structured objects), not a list of records
                a natural-key upsert makes sense of — and two keys
                (`payroll.statutory`, `approval.mode`) reject a raw PUT
                outright in favor of their own guarded screens. */}
            <ExportButton rows={visible} columns={settingIoColumns(t)} filenameBase="pengaturan" />
          </div>

          {error && <p className="text-sm text-danger-600">{error}</p>}

          {loading && <p className="text-sm text-text-muted">{t('common.loading')}</p>}

          {!loading &&
            !error &&
            SETTING_SECTIONS.map((section) => {
              const rows = bySection.get(section) ?? [];
              // Empty sections are dropped rather than rendered as headings
              // with nothing under them — including when a search narrows to
              // one area.
              if (rows.length === 0) return null;
              return (
                <Card key={section}>
                  <CardHeader>
                    <CardTitle>{t(`admin.settings.section.${section}`)}</CardTitle>
                    <p className="text-sm text-text-muted">
                      {t(`admin.settings.sectionHint.${section}`)}
                    </p>
                  </CardHeader>
                  <CardContent className="p-0">
                    <DataTable
                      columns={columns}
                      data={{ rows, total: rows.length, page: 1, pageSize: rows.length || 1 }}
                      keyField={(r) => r.key}
                      onRowClick={can('settings.read') ? (r) => setEditing(r) : undefined}
                    />
                  </CardContent>
                </Card>
              );
            })}

          {!loading && !error && visible.length === 0 && (
            <p className="text-sm text-text-muted">{t('admin.settings.searchEmpty')}</p>
          )}
        </div>
      </TabsContent>

      <TabsContent value="payroll">
        <PermissionGate permission="payroll.statutory.read" showMessage>
          <PayrollStatutoryCard />
        </PermissionGate>
      </TabsContent>

      {editing && (
        <SettingDetailModal
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
