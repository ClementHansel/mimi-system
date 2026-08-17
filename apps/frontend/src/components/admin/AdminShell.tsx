'use client';

import { useMemo } from 'react';
import { Users, Boxes, ScrollText, Settings as SettingsIcon } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { UsersPanel } from './UsersPanel';
import { MasterDataPanel } from './MasterDataPanel';
import { AuditPanel } from './AuditPanel';
import { SettingsPanel } from './SettingsPanel';

/**
 * F10 admin (CONTRACTS §8.3: Owner/Manager, laptop; §4.2-4.4/§4.20/audit
 * §4.0). One page, four permission-gated tabs — this is a back-office
 * surface where an Owner/Manager flips between Users/Master Data/Audit/
 * Settings constantly, so tabs beat four separate route loads.
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
      { value: 'users', labelKey: 'admin.tabs.users', icon: Users, visible: can('user.read'), content: <UsersPanel /> },
      {
        value: 'masterData', labelKey: 'admin.tabs.masterData', icon: Boxes,
        visible: can(['item.manage', 'product.manage', 'location.manage', 'item.read']), content: <MasterDataPanel />,
      },
      { value: 'audit', labelKey: 'admin.tabs.audit', icon: ScrollText, visible: can('audit.read'), content: <AuditPanel /> },
      { value: 'settings', labelKey: 'admin.tabs.settings', icon: SettingsIcon, visible: can('settings.read'), content: <SettingsPanel /> },
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
