'use client';

import { useMemo } from 'react';
import { Wallet, BookText, ListTree, FileBarChart, CalendarClock, ShieldAlert } from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { usePermissions } from '@/lib/permissions';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/Tabs';
import { EmptyState } from '@/components/ui/EmptyState';
import { PaymentsPanel } from './PaymentsPanel';
import { JournalPanel } from './JournalPanel';
import { ChartOfAccountsPanel } from './ChartOfAccountsPanel';
import { ReportsPanel } from './ReportsPanel';
import { FiscalPeriodsPanel } from './FiscalPeriodsPanel';
import { ExceptionsPanel } from './ExceptionsPanel';

/**
 * F07 finance (CONTRACTS §4.17: D-04 GL, FR-ACCT-01..04, §5.8, D-17). One
 * page, six permission-gated tabs — mirrors `AdminShell`'s pattern (F10):
 * Finance/Owner flip between the payment queue, journal, chart of accounts,
 * reports and periods constantly, so tabs beat six separate route loads.
 * Each tab is independently gated by ANY-of its relevant read permission;
 * this is nav-level visibility only, the server's `PermissionsGuard` + RLS
 * is the real boundary underneath every call each panel makes.
 */
export function FinanceShell() {
  const { t } = useI18n();
  const { can } = usePermissions();

  const tabs = useMemo(
    () => [
      {
        value: 'payments',
        labelKey: 'finance.tabs.payments',
        icon: Wallet,
        visible: can('payment.read'),
        content: <PaymentsPanel />,
      },
      {
        value: 'journal',
        labelKey: 'finance.tabs.journal',
        icon: BookText,
        visible: can('accounting.journal.read'),
        content: <JournalPanel />,
      },
      {
        value: 'coa',
        labelKey: 'finance.tabs.coa',
        icon: ListTree,
        visible: can('accounting.coa.read'),
        content: <ChartOfAccountsPanel />,
      },
      {
        value: 'reports',
        labelKey: 'finance.tabs.reports',
        icon: FileBarChart,
        visible: can('accounting.report.read'),
        content: <ReportsPanel />,
      },
      {
        value: 'periods',
        labelKey: 'finance.tabs.periods',
        icon: CalendarClock,
        visible: can('accounting.coa.read'),
        content: <FiscalPeriodsPanel />,
      },
      {
        value: 'exceptions',
        labelKey: 'finance.tabs.exceptions',
        icon: ShieldAlert,
        visible: can('sync.exception.review'),
        content: <ExceptionsPanel />,
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
