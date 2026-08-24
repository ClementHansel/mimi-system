import { WAREHOUSE_PANELS } from './warehouse-panels';
import {
  ShoppingCart,
  LayoutDashboard,
  Store,
  Warehouse,
  ClipboardList,
  Landmark,
  Users,
  Wrench,
  ShieldCheck,
  UserCircle,
  Waypoints,
  Truck,
  Route,
  ClipboardCheck,
  MessageSquare,
  MessageCircle,
  BookOpen,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionKeyOrKeys } from './permissions';

/**
 * THE NAV CONFIG — two levels, not one.
 *
 * LEVEL 1: `INTERFACES` (owner's rulings, 2026-08-21). The system has exactly
 * SEVEN distinct interfaces — different jobs, on different devices, for
 * different kinds of user:
 *
 *   1. `dashboard`  — head office: office staff, managers, owner, superadmin
 *   2. `pos`        — the till, at every branch
 *   3. `outlet`     — the outlet manager's working screen
 *   4. `warehouse`  — Gudang Pusat operations (frozen / chilled / dry)
 *   5. `driver`     — the driver's mobile delivery screen
 *   6. `employee`   — everyone's own personal surface (`/me`)
 *   7. `docs`       — the manual
 *
 * `employee` was promoted OUT of the dashboard (where `/me` used to be one
 * entry in the SDM section) because it is not office work: it is the one
 * interface every single person in the company has, on their own phone,
 * regardless of what they do all day. Which is also what gives a Kasir a
 * reason to see the hub — their two cards are "Kasir (POS)" and "Akun Saya".
 *
 * Everything else (`/approvals`, `/purchasing`, `/finance`, `/hr`, `/assets`,
 * `/me`, `/admin`, `/topology`, `/chat`) is NOT an interface — it is an AREA
 * inside one, and appears only in that interface's sidebar. This is what the
 * hub got wrong before: it listed all 14 routes as if each were a peer
 * destination, which the owner rejected ("the hub is not supposed to be shown
 * like that") because it turned the home screen into a second, flatter copy of
 * the sidebar.
 *
 * LEVEL 2: each interface's own `sections` — the sidebar it renders. The
 * dashboard has the full head-office tree; gudang has its items-and-movement
 * pair (stock floor + Surat Jalan); Outlet, Driver and Dokumentasi are
 * single-screen. Every one of them also carries WhatsApp, and owner/superadmin
 * get the way back to the hub on top.
 *
 * THE OPERATIONAL FLOW the placement follows (owner, 2026-08-21):
 * office APPROVES the outlet's request -> gudang PREPARES and SENDS it ->
 * outlet RECEIVES it. So Pembelian is office work and stays in the dashboard,
 * while Surat Jalan belongs to BOTH: gudang creates, prints and dispatches it
 * (the paper is printed there, three copies per drop — gudang, outlet, kantor),
 * and the office keeps the same document for oversight. Gudang, in one line,
 * is the items and their movement.
 *
 * SHARED SURFACES. A few routes legitimately live in more than one interface —
 * `/delivery` (gudang + office) and `/me/chat` (WhatsApp, which the owner wants
 * in every interface). They are listed in each interface's sections and left
 * out of every interface's `routes`; `interfaceForPath()` then keeps you in the
 * interface you came from instead of teleporting you into another one's
 * sidebar. See `SHARED_ROUTES`.
 *
 * Adding a 7th interface, or moving a route between interfaces, is a contract
 * change (collision rule §6.7): go to the architect, not to this file.
 *
 * `(auth)` (F01) is deliberately NOT registered — it is the pre-login route
 * group; there is nothing to navigate to before signing in.
 *
 * Gating is ANY-of on `permission` (see `hasPermission` in `./permissions`):
 * several roles reach the same surface through different keys (e.g. Owner via
 * `dashboard.view`, Supervisor via `dashboard.outlet.view`). This is a coarse,
 * nav-level visibility check only — the page itself, and always the server,
 * enforce the real RBAC boundary for what a role can do once inside.
 */

export interface NavItem {
  id: string;
  labelKey: string;
  href: string;
  icon: LucideIcon;
  /**
   * CONTRACTS §3 permission key(s) that make this entry visible. Optional:
   * `undefined` means "everyone who can sign in" (`hasPermission` returns true
   * for it), which is right for a surface that is not privileged — your own
   * WhatsApp thread, the manual.
   */
  permission?: PermissionKeyOrKeys;
}

export interface NavSection {
  id: string;
  labelKey: string;
  items: NavItem[];
}

export interface AppInterface {
  id: string;
  labelKey: string;
  /** Where the hub card, and the sidebar's own entry for it, point. */
  href: string;
  icon: LucideIcon;
  /**
   * Permission gate for the hub card. `undefined` means "everyone" — only
   * `docs` uses that: reading the manual is not a privileged act, which is
   * also why it has no RBAC key to gate on.
   */
  permission?: PermissionKeyOrKeys;
  /**
   * Route prefixes owned by this interface, used to resolve which interface
   * the current pathname is in (and therefore which sidebar to render).
   * `href` is always implicitly included.
   */
  routes: readonly string[];
  /**
   * The interface's sidebar. Empty for the single-screen interfaces — the
   * sidebar then shows just this interface's own entry (see `Sidebar`).
   */
  sections: readonly NavSection[];
}

/**
 * WhatsApp, in EVERY interface (owner, 2026-08-21: "pesan whatsapp is for all
 * interface"). Two entries, because they are two different surfaces:
 *
 *  - `/chat` is the ADMIN INBOX — every staff thread, head-office side, gated
 *    on `chat.read`.
 *  - `/me/chat` is YOUR OWN thread. Ungated on purpose: messaging the office
 *    about your own shift is not a privileged act, and the server scopes the
 *    thread to the caller. This is the entry a Kasir, Leader Outlet, gudang
 *    staffer or Driver actually uses.
 *
 * An office role sees both — an inbox and a personal thread are genuinely
 * different things to them, so neither is redundant.
 */
const CHAT_SECTION: NavSection = {
  id: 'pesan',
  labelKey: 'nav.section.pesan',
  items: [
    {
      id: 'chat',
      labelKey: 'nav.chat',
      href: '/chat',
      icon: MessageSquare,
      permission: 'chat.read',
    },
    {
      id: 'myChat',
      labelKey: 'nav.myChat',
      href: '/me/chat',
      icon: MessageCircle,
    },
  ],
};

/** Surat Jalan — the same surface for gudang (create/print/dispatch) and for
 * the office (oversight). Declared once so the two sidebars cannot drift. */
const DELIVERY_ITEM: NavItem = {
  id: 'delivery',
  labelKey: 'nav.delivery',
  href: '/delivery',
  icon: Route,
  permission: 'delivery.read',
};

/** The dashboard's sidebar — every head-office area, grouped as before. */
const DASHBOARD_SECTIONS: readonly NavSection[] = [
  {
    id: 'operasional',
    labelKey: 'nav.section.operasional',
    items: [
      {
        id: 'dashboard',
        labelKey: 'nav.dashboard',
        href: '/dashboard',
        icon: LayoutDashboard,
        permission: ['dashboard.view', 'dashboard.outlet.view'],
      },
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
    ],
  },
  {
    id: 'logistik',
    labelKey: 'nav.section.logistik',
    items: [
      // Surat Jalan (CONTRACTS §4.10) — here for OVERSIGHT: the office
      // approves the request and holds the third printed copy, so it must be
      // able to open the same document. Creating, printing and dispatching it
      // is gudang's job, which is why the identical entry also sits in the
      // warehouse interface below (`DELIVERY_ITEM`, one definition).
      DELIVERY_ITEM,
      // Pembelian is office work — PR/PO to suppliers. The gudang side of
      // purchasing is RECEIVING the goods, which is a tab inside
      // `/warehouse` (`WarehouseShell`), not this entry.
      {
        id: 'purchasing',
        labelKey: 'nav.purchasing',
        href: '/purchasing',
        icon: ClipboardList,
        permission: 'purchasing.read',
      },
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
      {
        id: 'assets',
        labelKey: 'nav.assets',
        href: '/assets',
        icon: Wrench,
        permission: 'asset.read',
      },
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
      {
        id: 'topology',
        labelKey: 'nav.topology',
        href: '/topology',
        icon: Waypoints,
        permission: 'topology.read',
      },
    ],
  },
  CHAT_SECTION,
];

export const INTERFACES: readonly AppInterface[] = [
  {
    id: 'dashboard',
    labelKey: 'nav.dashboard',
    href: '/dashboard',
    icon: LayoutDashboard,
    // Reaching the dashboard interface at all is ANY-of the areas inside it:
    // a Finance user without `dashboard.view` still belongs here (this is the
    // interface their work lives in), they simply work in `/finance` once in.
    permission: [
      'dashboard.view',
      'dashboard.outlet.view',
      'delivery.read',
      'purchasing.read',
      'payment.read',
      'accounting.journal.read',
      'hr.employee.read',
      'hr.attendance.read',
      'hr.shift.manage',
      'asset.read',
      'user.read',
      'audit.read',
      'settings.manage',
      'topology.read',
      'chat.read',
    ],
    // `/delivery` and `/me/chat` are deliberately absent — they are SHARED
    // surfaces (see `SHARED_ROUTES`), not the dashboard's alone.
    routes: [
      '/dashboard',
      '/approvals',
      '/chat',
      '/purchasing',
      '/finance',
      '/hr',
      '/assets',
      '/admin',
      '/topology',
    ],
    sections: DASHBOARD_SECTIONS,
  },
  {
    id: 'pos',
    labelKey: 'nav.pos',
    href: '/pos',
    icon: ShoppingCart,
    permission: 'pos.catalog.read',
    routes: ['/pos'],
    // POS is chromeless (its own top bar, no sidebar — `AppShell`), so it has
    // no sections to render. Its WhatsApp entry lives in `PosTopBar`.
    sections: [],
  },
  {
    id: 'outlet',
    labelKey: 'nav.outlet',
    href: '/outlet',
    icon: Store,
    permission: ['replenishment.create', 'opname.create', 'waste.create', 'pettycash.create'],
    routes: ['/outlet'],
    sections: [
      {
        id: 'outlet',
        labelKey: 'nav.section.outlet',
        items: [
          {
            id: 'outlet',
            labelKey: 'nav.outlet',
            href: '/outlet',
            icon: Store,
            permission: [
              'replenishment.create',
              'opname.create',
              'waste.create',
              'pettycash.create',
            ],
          },
        ],
      },
      CHAT_SECTION,
    ],
  },
  {
    id: 'warehouse',
    labelKey: 'nav.warehouse',
    href: '/warehouse',
    icon: Warehouse,
    permission: 'delivery.read',
    // Every `/warehouse/*` page belongs to this interface, not just the root —
    // otherwise opening Stok Gudang would bounce the user into another
    // interface's shell.
    routes: ['/warehouse'],
    // Gudang is the items and their movement: what is on hand, what came in,
    // and what goes out on a Surat Jalan — which is created, PRINTED and
    // dispatched here, not at a desk in the office.
    sections: [
      {
        id: 'gudang',
        labelKey: 'nav.section.gudang',
        items: [
          {
            id: 'warehouse',
            labelKey: 'nav.warehouse',
            href: '/warehouse',
            icon: Warehouse,
            permission: 'delivery.read',
          },
          // Gudang's eight areas, previously a horizontal tab strip across the
          // top of `/warehouse` while this sidebar held two entries. Built from
          // `WAREHOUSE_PANELS` — the same list `/warehouse/[panel]` resolves its
          // content from — so an area cannot be added to the routes and go
          // missing from the navigation, or the reverse.
          ...WAREHOUSE_PANELS.map((panel) => ({
            id: `warehouse-${panel.slug}`,
            labelKey: panel.labelKey,
            href: `/warehouse/${panel.slug}`,
            icon: panel.icon,
            permission: panel.permission,
          })),
          DELIVERY_ITEM,
        ],
      },
      CHAT_SECTION,
    ],
  },
  {
    id: 'driver',
    labelKey: 'nav.driver',
    href: '/driver',
    icon: Truck,
    permission: 'delivery.drop.execute',
    routes: ['/driver'],
    sections: [
      {
        id: 'driver',
        labelKey: 'nav.section.driver',
        items: [
          {
            id: 'driver',
            labelKey: 'nav.driver',
            href: '/driver',
            icon: Truck,
            permission: 'delivery.drop.execute',
          },
          // The Surat Jalan list, in the delivery interface as well as the
          // dashboard. `/driver` answers "what am I delivering right now", and
          // it answers it ONLY for the signed-in driver — `my-jobs` resolves
          // through the `drivers` table, so for an owner or a kepala gudang it
          // is correctly and permanently empty. Without this item that interface
          // is a dead end for exactly the people who supervise it, which is how
          // it was reported: an owner opened Pengiriman and found nothing.
          //
          // `delivery.read` does the separation on its own. A driver does not
          // hold it and still sees one item; everyone overseeing the fleet holds
          // it and gets the list next to the map.
          DELIVERY_ITEM,
        ],
      },
      CHAT_SECTION,
    ],
  },
  {
    id: 'employee',
    labelKey: 'nav.employee',
    href: '/me',
    icon: UserCircle,
    // UNGATED, like `docs`: your own attendance, payslip and leave are not a
    // privileged read, and every role in the company has them. The server
    // scopes every `/me` fetch to the caller (CONTRACTS §4.14/§4.15), so this
    // is not the boundary — it is just "everyone has a self".
    routes: ['/me'],
    sections: [
      {
        id: 'personal',
        labelKey: 'nav.section.personal',
        items: [
          {
            id: 'me',
            labelKey: 'nav.me',
            href: '/me',
            icon: UserCircle,
          },
        ],
      },
      CHAT_SECTION,
    ],
  },
  {
    id: 'docs',
    labelKey: 'nav.docs',
    href: '/docs',
    icon: BookOpen,
    // No permission: the manual is for everyone who can sign in.
    routes: ['/docs'],
    sections: [
      {
        id: 'docs',
        labelKey: 'nav.section.referensi',
        items: [
          {
            id: 'docs',
            labelKey: 'nav.docs',
            href: '/docs',
            icon: BookOpen,
          },
        ],
      },
      CHAT_SECTION,
    ],
  },
];

/**
 * Routes that belong to more than one interface, each with the interface that
 * OWNS it when we have nothing better to go on. `/delivery` defaults to gudang
 * because that is where a Surat Jalan is created, printed and dispatched; the
 * office reaches the same screen from its own sidebar and stays there.
 */
const SHARED_ROUTES: readonly { route: string; ownerId: string }[] = [
  { route: '/me/chat', ownerId: 'dashboard' },
  { route: '/delivery', ownerId: 'warehouse' },
];

function matches(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

function byId(id: string): AppInterface | null {
  return INTERFACES.find((iface) => iface.id === id) ?? null;
}

/** Does this interface's sidebar contain an entry for `href`? */
function offers(iface: AppInterface, href: string): boolean {
  return iface.sections.some((section) => section.items.some((item) => item.href === href));
}

/**
 * The interface a pathname belongs to, or `null` for the hub / unowned routes.
 *
 * `preferredId` is the interface the user was last in. It only matters for
 * SHARED routes: a dispatcher who opens Surat Jalan from the dashboard keeps
 * the dashboard's sidebar, and a Kepala Gudang who opens the same screen keeps
 * gudang's — rather than either of them being dropped into the other's
 * interface because one of them had to be declared the owner.
 */
export function interfaceForPath(
  pathname: string,
  preferredId?: string | null,
): AppInterface | null {
  // Shared routes first: they are also matched by a broader owned prefix
  // (`/me/chat` sits under the dashboard's `/me`), and the shared reading wins.
  const shared = SHARED_ROUTES.find((entry) => matches(pathname, entry.route));
  if (shared) {
    const preferred = preferredId ? byId(preferredId) : null;
    if (preferred && offers(preferred, shared.route)) return preferred;
    return byId(shared.ownerId) ?? null;
  }

  return (
    INTERFACES.find((iface) => [iface.href, ...iface.routes].some((r) => matches(pathname, r))) ??
    null
  );
}

/**
 * Every registered nav item, in interface + section order, deduplicated by
 * href — used by tests and by anything needing the flat route inventory.
 * Shared surfaces (`/delivery`, `/me/chat`) appear once, and an interface with
 * no sections of its own (POS) contributes a synthetic entry for itself so the
 * inventory stays complete.
 */
export const ALL_NAV_ITEMS: readonly NavItem[] = (() => {
  const items = INTERFACES.flatMap((iface) =>
    iface.sections.length > 0
      ? iface.sections.flatMap((section) => section.items)
      : [
          {
            id: iface.id,
            labelKey: iface.labelKey,
            href: iface.href,
            icon: iface.icon,
            permission: iface.permission,
          },
        ],
  );
  const seen = new Set<string>();
  return items.filter((item) => (seen.has(item.href) ? false : (seen.add(item.href), true)));
})();

/**
 * @deprecated The dashboard's sections. Kept as a named export because it is
 * what the dashboard sidebar renders; new code should reach it through
 * `INTERFACES` / `interfaceForPath()` instead of assuming there is one global
 * nav tree.
 */
export const NAV_SECTIONS = DASHBOARD_SECTIONS;
