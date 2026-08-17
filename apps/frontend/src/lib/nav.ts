import {
  ShoppingCart, LayoutDashboard, Store, Warehouse, ClipboardList, Landmark,
  Users, Wrench, ShieldCheck, UserCircle, Waypoints, Truck, Route, ClipboardCheck, type LucideIcon,
} from 'lucide-react';
import type { PermissionKeyOrKeys } from './permissions';

/**
 * THE NAV CONFIG — frozen after Gate G1 (BUILD-PLAN §5 Wave 1 note, §6.2).
 *
 * Every one of the 13 frontend surfaces (BUILD-PLAN §4.3) is registered here
 * NOW, each gated by its permission key from CONTRACTS.md §3, so Waves 4–5
 * never touch this file — they only replace the placeholder page bodies at
 * the routes already listed below. Adding a 14th surface or changing a
 * permission key is a contract change (collision rule §6.7): go to the
 * architect, not to this file.
 *
 * POST-G1 ADDITION: `approvals` (`/approvals`, detail at
 * `/approvals/[documentType]/[documentId]`) was added by explicit
 * coordinator direction once the generic approval inbox (D-08,
 * `GET /api/approvals/pending`) shipped a screen — it was reachable only by
 * notification deep-link before this. Same rule applies going forward: this
 * file changes on coordinator/architect direction, not ad hoc.
 *
 * `(auth)` (F01) is deliberately NOT a nav entry — it's the pre-login route
 * group; there is nothing to navigate to before signing in.
 *
 * Gating is ANY-of on `permission` (see `hasPermission` in `./permissions`):
 * several roles reach the same surface through different keys (e.g. Owner
 * via `dashboard.view`, Supervisor via `dashboard.outlet.view`). This is a
 * coarse, nav-level visibility check only — the page itself, and always the
 * server, enforce the real RBAC boundary for what a role can do once inside.
 */

export interface NavItem {
  id: string;
  labelKey: string;
  href: string;
  icon: LucideIcon;
  /** CONTRACTS §3 permission key(s) that make this entry visible. */
  permission: PermissionKeyOrKeys;
}

export interface NavSection {
  id: string;
  labelKey: string;
  items: NavItem[];
}

export const NAV_SECTIONS: readonly NavSection[] = [
  {
    id: 'operasional',
    labelKey: 'nav.section.operasional',
    items: [
      {
        id: 'approvals',
        labelKey: 'nav.approvals',
        href: '/approvals',
        icon: ClipboardCheck,
        // ANY-of the generic approval engine's (D-08) 11 per-document-type
        // approve keys — one per CONTRACTS §2.5 `ApprovalDocumentType` entry
        // (replenishment needs both its supervisor and warehouse steps).
        // There is no single "approval.read"-style key in the RBAC matrix
        // (flagged to the coordinator; composing existing keys here rather
        // than inventing a new one). The inbox itself resolves per-document
        // eligibility — this only answers "is this person ever an approver".
        permission: [
          'replenishment.approve.supervisor',
          'replenishment.approve.warehouse',
          'opname.approve',
          'return.approve',
          'purchasing.pr.approve',
          'purchasing.po.approve',
          'pos.void.approve',
          'payroll.run.approve',
          'payroll.loan.approve',
          'hr.leave.approve',
          'payment.verify',
        ],
      },
      { id: 'pos', labelKey: 'nav.pos', href: '/pos', icon: ShoppingCart, permission: 'pos.catalog.read' },
      {
        id: 'dashboard',
        labelKey: 'nav.dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
        permission: ['dashboard.view', 'dashboard.outlet.view'],
      },
      {
        id: 'outlet',
        labelKey: 'nav.outlet',
        href: '/outlet',
        icon: Store,
        permission: ['replenishment.create', 'opname.create', 'waste.create', 'pettycash.create'],
      },
      { id: 'driver', labelKey: 'nav.driver', href: '/driver', icon: Truck, permission: 'delivery.drop.execute' },
    ],
  },
  {
    id: 'logistik',
    labelKey: 'nav.section.logistik',
    items: [
      { id: 'warehouse', labelKey: 'nav.warehouse', href: '/warehouse', icon: Warehouse, permission: 'delivery.read' },
      // F-DELIVERY — the dispatcher's own surface for M10 delivery (CONTRACTS
      // §4.10): Surat Jalan list/create/status walk + live per-drop/cold-chain
      // tracking for the central-warehouse dispatcher. Distinct from `driver`
      // above (the driver's own mobile job list, `Truck` icon) — `Route` reads
      // as "the dispatch/route view" rather than duplicating that icon.
      { id: 'delivery', labelKey: 'nav.delivery', href: '/delivery', icon: Route, permission: 'delivery.read' },
      { id: 'purchasing', labelKey: 'nav.purchasing', href: '/purchasing', icon: ClipboardList, permission: 'purchasing.read' },
    ],
  },
  {
    id: 'keuangan',
    labelKey: 'nav.section.keuangan',
    items: [
      {
        id: 'finance',
        labelKey: 'nav.finance',
        href: '/finance',
        icon: Landmark,
        permission: ['payment.read', 'accounting.journal.read'],
      },
    ],
  },
  {
    id: 'sdm',
    labelKey: 'nav.section.sdm',
    items: [
      {
        id: 'hr',
        labelKey: 'nav.hr',
        href: '/hr',
        icon: Users,
        permission: ['hr.employee.read', 'hr.attendance.read', 'hr.shift.manage'],
      },
      { id: 'assets', labelKey: 'nav.assets', href: '/assets', icon: Wrench, permission: 'asset.read' },
      { id: 'me', labelKey: 'nav.me', href: '/me', icon: UserCircle, permission: 'payroll.slip.read.own' },
    ],
  },
  {
    id: 'sistem',
    labelKey: 'nav.section.sistem',
    items: [
      {
        id: 'admin',
        labelKey: 'nav.admin',
        href: '/admin',
        icon: ShieldCheck,
        permission: ['user.read', 'audit.read', 'settings.manage'],
      },
      { id: 'topology', labelKey: 'nav.topology', href: '/topology', icon: Waypoints, permission: 'topology.read' },
    ],
  },
] as const;

/** Flat list of every registered nav item, in section order — used by tests and the mobile drawer. */
export const ALL_NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((s) => s.items);
