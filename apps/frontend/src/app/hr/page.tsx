'use client';

import {
  Users,
  CalendarClock,
  ClipboardCheck,
  FileClock,
  Wallet,
  Percent,
  FileSignature,
  Coins,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n';
import { Tabs, TabsList, TabsTrigger, TabsContent, PermissionGate } from '@/components/ui';
import { EmployeesPanel } from '@/components/hr/EmployeesPanel';
import { RosterPanel } from '@/components/hr/RosterPanel';
import { AttendancePanel } from '@/components/hr/AttendancePanel';
import { LeaveApprovalPanel } from '@/components/hr/LeaveApprovalPanel';
import { PayrollPanel } from '@/components/hr/PayrollPanel';
import { StatutoryRatesPanel } from '@/components/hr/StatutoryRatesPanel';
import { SalaryComponentsPanel } from '@/components/hr/SalaryComponentsPanel';
import { ContractsPanel } from '@/components/hr/ContractsPanel';

/**
 * F08 `hr` — the HR Admin / Supervisor back office (laptop, BUILD-PLAN
 * W4-10): employee records, shift roster, attendance review (with
 * `time_suspect` rows surfaced, not buried), leave approval, payroll runs,
 * and the BPJS/PPh21 rate editors. One tabbed shell over the six flows,
 * same structural model as F04 `outlet` (W4-07) — each tab is its own panel
 * gated by the CONTRACTS §3 permission it actually needs.
 */
export default function HrPage() {
  const { t } = useI18n();

  return (
    <div className="flex flex-col gap-4 p-4">
      {/* AppShell already owns the single OfflineBanner for this (non-chromeless) route. */}
      <h1 className="font-display text-2xl font-semibold text-text-primary">{t('nav.hr')}</h1>

      <Tabs defaultValue="employees">
        <TabsList className="flex-wrap">
          <TabsTrigger value="employees">
            <span className="inline-flex items-center gap-1.5">
              <Users className="size-4" aria-hidden />
              {t('hr.tabs.employees')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="roster">
            <span className="inline-flex items-center gap-1.5">
              <CalendarClock className="size-4" aria-hidden />
              {t('hr.tabs.roster')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="attendance">
            <span className="inline-flex items-center gap-1.5">
              <ClipboardCheck className="size-4" aria-hidden />
              {t('hr.tabs.attendance')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="leaves">
            <span className="inline-flex items-center gap-1.5">
              <FileClock className="size-4" aria-hidden />
              {t('hr.tabs.leaves')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="payroll">
            <span className="inline-flex items-center gap-1.5">
              <Wallet className="size-4" aria-hidden />
              {t('hr.tabs.payroll')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="statutory">
            <span className="inline-flex items-center gap-1.5">
              <Percent className="size-4" aria-hidden />
              {t('hr.tabs.statutory')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="components">
            <span className="inline-flex items-center gap-1.5">
              <Coins className="size-4" aria-hidden />
              {t('hr.tabs.components')}
            </span>
          </TabsTrigger>
          <TabsTrigger value="contracts">
            <span className="inline-flex items-center gap-1.5">
              <FileSignature className="size-4" aria-hidden />
              {t('hr.tabs.contracts')}
            </span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="employees">
          <PermissionGate permission="hr.employee.read" showMessage>
            <EmployeesPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="roster">
          <PermissionGate permission="hr.shift.read" showMessage>
            <RosterPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="attendance">
          <PermissionGate permission="hr.attendance.read" showMessage>
            <AttendancePanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="leaves">
          <PermissionGate permission="hr.leave.read" showMessage>
            <LeaveApprovalPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="payroll">
          <PermissionGate permission="payroll.read" showMessage>
            <PayrollPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="statutory">
          {/*
           * Every GET under `/payroll/statutory*` requires only
           * `payroll.statutory.read` server-side (`StatutoryController`) —
           * `payroll.statutory.config` is the WRITE permission (PUT only).
           * Gating the whole tab behind `.config` denied every `.read`-only
           * holder (Owner included — FIX-LOADS #3) from even viewing the
           * current rates. `StatutoryRatesPanel` itself gates each editor's
           * save action behind `.config`, so this only widens who can see
           * the read-only history, matching the backend's own split.
           */}
          <PermissionGate permission="payroll.statutory.read" showMessage>
            <StatutoryRatesPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="components">
          {/* `payroll.read`, matching the SERVER: `GET /payroll/components`
              requires `payroll.read`, while `payroll.component.manage` is the
              WRITE key (POST/PATCH only). Gating the tab on the manage key
              would hide the component list from every read-only holder — the
              same mistake the `statutory` tab below documents having made. */}
          <PermissionGate permission="payroll.read" showMessage>
            <SalaryComponentsPanel />
          </PermissionGate>
        </TabsContent>
        <TabsContent value="contracts">
          {/* `hr.contract.read` is the list permission;
              `hr.contract.read.own` is a DIFFERENT, narrower key that backs
              `GET /hr/contracts/me` for an employee reading their own contract
              (that surface belongs on `/me`, not on this back-office tab), and
              `hr.contract.manage` is the write key checked inside the panel. */}
          <PermissionGate permission="hr.contract.read" showMessage>
            <ContractsPanel />
          </PermissionGate>
        </TabsContent>
      </Tabs>
    </div>
  );
}
