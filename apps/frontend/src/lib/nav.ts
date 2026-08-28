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
  Mail,
  BookOpen,
  QrCode,
  FileText,
  CalendarPlus,
  HandCoins,
  FileSignature,
  Boxes,
  ListChecks,
  Trash2,
  Undo2,
  Wallet,
  CalendarClock,
  Ticket,
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
 * single-screen. Every one of them also carries Chats and Mail; WhatsApp is
 * the dashboard's alone. Owner/superadmin get the way back to the hub on top.
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
 * `/delivery` (gudang + office), and `/chat/internal` + `/me/chat` (Chats and
 * Mail, which the owner wants in every interface). They are listed in each
 * interface's sections and left out of every interface's `routes`;
 * `interfaceForPath()` then keeps you in the interface you came from instead of
 * teleporting you into another one's sidebar. See `SHARED_ROUTES`.
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
  /**
   * Highlight this entry only on an EXACT pathname match. Needed where an
   * entry's href is the prefix of its siblings' — `/me` (the overview) sits
   * above `/me/absen`, `/me/slip`, … and would otherwise stay lit on all six,
   * showing two active rows at once.
   */
  exact?: boolean;
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
 * MESSAGING, in EVERY interface (owner, 2026-08-27). Two entries, because they
 * are two different surfaces — and both are INTERNAL, which is why they are
 * everywhere while WhatsApp is not:
 *
 *  - `/chat/internal` — "Chats": staff-to-staff, person-to-person and group.
 *    Gated on `chat.read.own`, which every role holds.
 *  - `/me/chat` — "Mail": your own thread with head office. Ungated on
 *    purpose: messaging the office about your own shift is not a privileged
 *    act, and the server scopes the thread to the caller.
 *
 * WhatsApp (`/chat`, the admin inbox) is deliberately NOT here. Owner,
 * 2026-08-27: "feature whatsapp only for dashboard" — talking to suppliers and
 * customers over WhatsApp is head-office work, so that entry lives in
 * `DASHBOARD_MESSAGING_SECTION` below and nowhere else. It supersedes the
 * 2026-08-21 ruling that put WhatsApp in every interface.
 *
 * Both routes are SHARED (see `SHARED_ROUTES`): opening Chats or Mail from
 * gudang, the outlet or the till keeps you in THAT interface's sidebar instead
 * of dropping you into the dashboard ("so each interface should have their own
 * chats and mail. so dont redirect to dashboard").
 */
const CHATS_ITEM: NavItem = {
  id: 'chat-internal',
  labelKey: 'chatInternal.title',
  href: '/chat/internal',
  icon: MessageCircle,
  permission: 'chat.read.own',
};

const MAIL_ITEM: NavItem = {
  id: 'myChat',
  labelKey: 'nav.myChat',
  href: '/me/chat',
  icon: Mail,
};

const MESSAGING_SECTION: NavSection = {
  id: 'pesan',
  labelKey: 'nav.section.pesan',
  items: [CHATS_ITEM, MAIL_ITEM],
};

/**
 * The dashboard's messaging section: the same two internal surfaces, plus the
 * WhatsApp admin inbox that only head office gets. `chat.read` narrows it
 * further — most office roles never open it either.
 */
const DASHBOARD_MESSAGING_SECTION: NavSection = {
  id: 'pesan',
  labelKey: 'nav.section.pesan',
  items: [
    CHATS_ITEM,
    MAIL_ITEM,
    {
      id: 'chat',
      labelKey: 'nav.chat',
      href: '/chat',
      icon: MessageSquare,
      permission: 'chat.read',
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

/**
 * Pembelian — PR/PO to suppliers.
 *
 * Declared once because it belongs in TWO interfaces. It was previously
 * office-only, on the reasoning that "the gudang side of purchasing is
 * RECEIVING the goods". That reasoning does not survive contact with the
 * permissions: `kepala_gudang` holds `purchasing.read`, `purchasing.pr.create`
 * AND `purchasing.po.create`, so the warehouse was always meant to raise its
 * own requests — it simply had no link to the screen that does it.
 *
 * Owner, 2026-08-24: "gudang should be able to request PO for gudang stock."
 * Nothing had to be built; the capability existed and was unreachable, which is
 * the same shape as the driver's Surat Jalan list earlier today. Permission
 * grants and navigation drifting apart is worth watching for elsewhere.
 */
/**
 * Dispatcher assignment ("Penugasan Pengiriman") used to be its own nav
 * entry pointing at `/delivery/assign`. Owner, 2026-08-27: "this should be
 * displayed as a tab inside pengiriman (dispatcher)" — it is now the
 * "Penugasan" tab of `DeliveryShell` (mounted at `DELIVERY_ITEM`'s
 * `/delivery`), gated the same way (`delivery.sj.create`) but inside the
 * shell's own tab list instead of the sidebar. `/delivery/assign` still
 * resolves — it renders `DeliveryShell` pre-selected to that tab — so no
 * nav entry is needed for it here.
 */

const PURCHASING_ITEM: NavItem = {
  id: 'purchasing',
  labelKey: 'nav.purchasing',
  href: '/purchasing',
  icon: ClipboardList,
  permission: 'purchasing.read',
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
      PURCHASING_ITEM,
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
      // Vouchers — placed in Keuangan rather than a top-level interface or
      // Operasional (owner rulings this ticket follows, not a new one):
      //
      // A voucher's entire mechanical effect is a discount taken off
      // revenue at the till — it is a Rupiah amount or a percentage applied
      // against a sale's subtotal (`VoucherRules`,
      // `packages/shared/src/voucher/index.ts`), which is exactly the kind
      // of thing Keuangan already owns a screen for (`/finance`,
      // payments/GL). And `voucher.read`'s holders per the RBAC matrix
      // (owner, manager, finance/admin-keuangan, supervisor) are the same
      // audience Keuangan already serves — a Kasir does not hold it and was
      // never meant to see this screen; the till only REDEEMS
      // (`voucher.redeem`), which lives on the POS payment screen, not
      // behind a nav entry, exactly like `voucher.manage`/`.issue` do NOT
      // reach the outlet roles in `rbac.ts`.
      //
      // REJECTED: a top-level interface. Batches, issuing print runs and
      // closing them out is one screen doing one job, not a distinct
      // workspace the way `dashboard`/`pos`/`outlet`/`warehouse` each are —
      // it does not warrant its own hub card or sidebar tree.
      //
      // REJECTED: `operasional`. That section is the daily approvals queue
      // (dashboard overview, the approval inbox) — things an office worker
      // checks every shift. Minting and closing a voucher batch is a
      // periodic promotions task, not a daily operational one; it belongs
      // next to Pembayaran/GL, not the daily queue.
      {
        id: 'vouchers',
        labelKey: 'voucher.title',
        href: '/vouchers',
        icon: Ticket,
        permission: 'voucher.read',
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
      // Bulk CSV import/export has NO nav entry of its own (owner, 2026-08-25).
      // It used to be `/admin/import`, which made a bulk edit a destination:
      // leave the list, re-state which entity you meant in a dropdown, come
      // back to see whether it worked. It now lives as Export/Import buttons in
      // the Data Master tab that owns each list (`components/admin/MasterDataIo`),
      // where the entity is implied and a successful import reloads the table
      // underneath it.
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
  DASHBOARD_MESSAGING_SECTION,
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
    // `/delivery`, `/chat/internal` and `/me/chat` are deliberately absent —
    // they are SHARED surfaces (see `SHARED_ROUTES`), not the dashboard's
    // alone. `/chat` (the WhatsApp inbox) IS listed: it is dashboard-only.
    routes: [
      '/dashboard',
      '/approvals',
      '/chat',
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
    // POS itself is chromeless — `AppShell` renders no sidebar under `/pos`,
    // so these sections are never drawn AT the till (the cashier reaches Chats
    // and Mail from `PosTopBar` instead). They exist so that when a cashier
    // DOES open one of those shared surfaces, `interfaceForPath()` finds them
    // offered here and keeps them in the POS interface rather than dropping
    // them into the dashboard's sidebar — the sidebar they get on
    // `/chat/internal` says "Kasir (POS)" and links back to the till.
    sections: [
      {
        id: 'kasir',
        labelKey: 'nav.section.kasir',
        items: [
          {
            id: 'pos',
            labelKey: 'nav.pos',
            href: '/pos',
            icon: ShoppingCart,
            permission: 'pos.catalog.read',
          },
        ],
      },
      MESSAGING_SECTION,
    ],
  },
  {
    id: 'outlet',
    labelKey: 'nav.outlet',
    href: '/outlet',
    icon: Store,
    permission: ['replenishment.create', 'opname.create', 'waste.create', 'pettycash.create'],
    // Prefix, not an exact list: every `/outlet/*` flow belongs to this
    // interface, so opening Stok Opname keeps the outlet sidebar instead of
    // bouncing the user into another interface's shell.
    routes: ['/outlet'],
    sections: [
      {
        id: 'outlet',
        labelKey: 'nav.section.outlet',
        /**
         * The eight flows an outlet actually does, one entry each (owner,
         * 2026-08-27: "in outlet, these top tab need to be changed into outlet
         * sidebar"). They were tabs on `/outlet`, which made them unlinkable,
         * lost on reload, and a row that wrapped on a till-sized screen.
         *
         * Order follows the working day rather than the alphabet: ask for stock,
         * receive it, look at what you hold, count it, write off what spoiled,
         * send back what was wrong, log the cash you spent, then the roster.
         *
         * Each `permission` is the READ key for that flow — a Supervisor who can
         * see waste but not create it still needs the entry. The create-side
         * gates live inside the panels.
         */
        items: [
          {
            id: 'outlet-replenishment',
            labelKey: 'outlet.tabs.replenishment',
            href: '/outlet',
            icon: ClipboardList,
            // `/outlet` is the prefix of all seven siblings, so without this it
            // would stay lit on every one of them — two active rows at once.
            exact: true,
            permission: ['replenishment.read', 'replenishment.create'],
          },
          {
            id: 'outlet-receiving',
            labelKey: 'outlet.tabs.receiving',
            href: '/outlet/terima',
            icon: Truck,
            permission: ['delivery.receive', 'delivery.read'],
          },
          {
            id: 'outlet-stock',
            labelKey: 'outlet.tabs.stock',
            href: '/outlet/stok',
            icon: Boxes,
            permission: 'inventory.balance.read',
          },
          {
            id: 'outlet-opname',
            labelKey: 'outlet.tabs.opname',
            href: '/outlet/opname',
            icon: ListChecks,
            permission: ['opname.read', 'opname.create'],
          },
          {
            id: 'outlet-waste',
            labelKey: 'outlet.tabs.waste',
            href: '/outlet/waste',
            icon: Trash2,
            permission: 'waste.read',
          },
          {
            id: 'outlet-return',
            labelKey: 'outlet.return.tab',
            href: '/outlet/retur',
            icon: Undo2,
            permission: 'return.read',
          },
          {
            id: 'outlet-petty-cash',
            labelKey: 'outlet.tabs.pettyCash',
            href: '/outlet/kas-kecil',
            icon: Wallet,
            permission: 'pettycash.read',
          },
          {
            id: 'outlet-roster',
            labelKey: 'outlet.tabs.roster',
            href: '/outlet/jadwal',
            icon: CalendarClock,
            // Held by every role: a kasir sees the week they are on. Editing is
            // gated on `hr.shift.manage` inside `RosterPanel`.
            permission: 'hr.shift.read',
          },
        ],
      },
      MESSAGING_SECTION,
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
          PURCHASING_ITEM,
        ],
      },
      MESSAGING_SECTION,
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
      MESSAGING_SECTION,
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
          // `/me` itself is now the personal-analytics overview; the six
          // surfaces below used to be its tab strip. Owner, 2026-08-27: "these
          // menu should be in the sidebar or hamburger". A tab could not be
          // linked to, bookmarked, or opened from a notification — a route
          // can, and on a phone the hamburger reaches all seven without
          // scrolling a two-row strip of narrow targets.
          //
          // All ungated for the same reason the interface is: your own
          // attendance, payslip, leave, profile, kasbon and contract are not a
          // privileged read, and the server scopes every `/me` fetch to the
          // caller (CONTRACTS §4.14/§4.15).
          {
            id: 'me',
            labelKey: 'nav.me',
            href: '/me',
            icon: UserCircle,
            exact: true,
          },
          {
            id: 'me-absen',
            labelKey: 'me.tabs.absen',
            href: '/me/absen',
            icon: QrCode,
          },
          {
            id: 'me-slip',
            labelKey: 'me.tabs.slip',
            href: '/me/slip',
            icon: FileText,
          },
          {
            id: 'me-cuti',
            labelKey: 'me.tabs.cuti',
            href: '/me/cuti',
            icon: CalendarPlus,
          },
          {
            id: 'me-profil',
            labelKey: 'me.tabs.profile',
            href: '/me/profil',
            icon: UserCircle,
          },
          {
            id: 'me-pinjaman',
            labelKey: 'me.tabs.pinjaman',
            href: '/me/pinjaman',
            icon: HandCoins,
          },
          {
            id: 'me-kontrak',
            labelKey: 'me.tabs.kontrak',
            href: '/me/kontrak',
            icon: FileSignature,
          },
        ],
      },
      MESSAGING_SECTION,
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
      MESSAGING_SECTION,
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
  // Chats and Mail — in every interface, and they must not move you out of the
  // one you are in (owner, 2026-08-27: "each interface should have their own
  // chats and mail. so dont redirect to dashboard"). `/chat/internal` MUST be
  // listed: without it the dashboard's `/chat` prefix claimed it, so a Kepala
  // Gudang who opened Chats lost the gudang sidebar.
  { route: '/chat/internal', ownerId: 'dashboard' },
  { route: '/me/chat', ownerId: 'dashboard' },
  { route: '/delivery', ownerId: 'warehouse' },
  // Pembelian. It was listed in the DASHBOARD's `routes` while also sitting in
  // gudang's sidebar, so a Kepala Gudang who tapped it was thrown out of the
  // warehouse interface and into the head-office one — the sidebar swapped
  // under them and the way back to Stok Gudang disappeared (owner, 2026-08-27:
  // "on click of the pembelian shouldnt move to dashboard. stay on gudang but
  // show the page"). Declared shared instead, exactly like `/delivery`: the
  // office keeps the office sidebar, gudang keeps gudang's. `ownerId` is the
  // dashboard because purchasing is head-office work when we have nothing
  // better to go on (a direct link, a cold load).
  { route: '/purchasing', ownerId: 'dashboard' },
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
 * Shared surfaces (`/delivery`, `/chat/internal`, `/me/chat`) appear once, and
 * an interface with no sections of its own contributes a synthetic entry for
 * itself so the inventory stays complete.
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
