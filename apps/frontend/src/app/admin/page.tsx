import { AdminShell } from '@/components/admin/AdminShell';

/**
 * F10 `admin` (BUILD-PLAN §4.3, CONTRACTS §8.3) — Owner/Manager back-office:
 * users & roles, master data, the audit trail viewer, and settings (incl. the
 * payroll-statutory enable/disable gate). See `components/admin/AdminShell`
 * for the tab structure and per-tab permission gating.
 */
export default function AdminPage() {
  return <AdminShell />;
}
