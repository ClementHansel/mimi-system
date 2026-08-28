'use client';

import { useMemo } from 'react';
import { Users, Boxes, ScrollText, Settings as SettingsIcon, FileText, Palette } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { UsersPanel } from './UsersPanel';
import { MasterDataPanel } from './MasterDataPanel';
import { AuditPanel } from './AuditPanel';
import { SettingsPanel } from './SettingsPanel';
import { DocumentsPanel } from './DocumentsPanel';
import { BrandPanel } from './BrandPanel';

/**
 * F10 admin (CONTRACTS §8.3: Owner/Manager, laptop; §4.2-4.4/§4.20/audit
 * §4.0). One page, six permission-gated tabs — this is a back-office
 * surface where an Owner/Manager flips between Users/Master Data/Audit/
 * Settings constantly, so tabs beat six separate route loads.
 *
 * F-DOC (2026-08-27) added the last two. DOKUMEN is the four document
 * designers and BRAND is the logo/favicon/palette they all draw from, and both
 * belong here rather than as routes of their own for the same reason as the
 * other four: they are owner-only back-office configuration that is edited in
 * one sitting — an owner picks the brand colour and then immediately looks at
 * what it did to the invoice.
 *
 * They are gated on their WRITE keys (`doc_template.manage`, `settings.manage`),
 * not their read keys, and that is a deliberate departure from the Settings tab
 * next door, which is gated on `settings.read`. Settings has something to show a
 * reader — the current values. A designer canvas and a colour picker have
 * nothing to show somebody who cannot save: `doc_template.read` is UNIVERSAL
 * (every till fetches the receipt layout to print it — see `rbac.ts`), so
 * gating Dokumen on the read key would have put a full editor in front of every
 * cashier in the company.
 *
 * Each tab is independently gated (ANY relevant permission for that tab)
 * rather than the whole page behind one key, because the 9-role matrix
 * doesn't grant all four to the same roles uniformly (e.g. `hr_admin` holds
 * `user.read` and `settings.read` but not `audit.read` or item/location
 * management) — this is nav-level visibility only, the server enforces the
 * real boundary underneath each API call regardless of what's shown here.
 */
export function AdminShell() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const tabs = useMemo(
    () => [
      {
        value: 'users',
        labelKey: 'admin.tabs.users',
        icon: Users,
        visible: can('user.read'),
        content: <UsersPanel />,
      },
      {
        value: 'masterData',
        labelKey: 'admin.tabs.masterData',
        icon: Boxes,
        visible: can(['item.manage', 'product.manage', 'location.manage', 'item.read']),
        content: <MasterDataPanel />,
      },
      {
        value: 'audit',
        labelKey: 'admin.tabs.audit',
        icon: ScrollText,
        visible: can('audit.read'),
        content: <AuditPanel />,
      },
      {
        value: 'settings',
        labelKey: 'admin.tabs.settings',
        icon: SettingsIcon,
        visible: can('settings.read'),
        content: <SettingsPanel />,
      },
      {
        value: 'documents',
        labelKey: 'admin.tabs.documents',
        icon: FileText,
        visible: can('doc_template.manage'),
        content: <DocumentsPanel />,
      },
      {
        value: 'brand',
        labelKey: 'admin.tabs.brand',
        icon: Palette,
        visible: can('settings.manage'),
        content: <BrandPanel />,
      },
    ],
    [can],
  );

  const visibleTabs = tabs.filter((tab) => tab.visible);

  if (visibleTabs.length === 0) {
    return <EmptyState size="lg" title={t('permissionGate.noAccess')} />;
  }

  return (
    <Tabs defaultValue={visibleTabs[0]?.value}>
      <TabsList>
        {visibleTabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            <span className="inline-flex items-center gap-1.5">
              <tab.icon className="size-4" aria-hidden />
              {t(tab.labelKey)}
            </span>
          </TabsTrigger>
        ))}
      </TabsList>
      {visibleTabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
