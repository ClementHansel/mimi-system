import {
  Boxes,
  ClipboardCheck,
  ListChecks,
  PackageCheck,
  Route,
  Trash2,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { PermissionKeyOrKeys } from './permissions';

/**
 * THE ONE DEFINITION of Gudang Pusat's areas — metadata only.
 *
 * These were tabs inside `WarehouseShell`: eight across the top of a page whose
 * sidebar held two items. Owner, 2026-08-24: "all this top bar should be in the
 * sidebar." Right, and not only for tidiness — tabs made every area a
 * client-side toggle inside ONE url, so nothing here could be linked to,
 * bookmarked, opened beside another in a second window, or reached with the
 * back button. On a phone, eight tabs scroll off the screen sideways while the
 * sidebar sits nearly empty.
 *
 * METADATA ONLY, deliberately kept apart from the components that render each
 * area (`components/warehouse/panels.tsx`). `nav.ts` needs the labels, icons and
 * permissions to build the sidebar; it must not drag eight panel components —
 * and their tables, modals and data hooks — into every page that imports the
 * navigation.
 *
 * `permission` mirrors what each tab checked with `can()`; an array means "any
 * of these".
 */
export interface WarehousePanelMeta {
  /** URL segment: `/warehouse/<slug>`. */
  slug: string;
  /** Unchanged from the tab labels, so nothing needs retranslating. */
  labelKey: string;
  icon: LucideIcon;
  /**
   * Typed rather than `string`, so a permission that does not exist is a build
   * error here instead of a screen that silently refuses to open for everyone.
   */
  permission: PermissionKeyOrKeys;
}

export const WAREHOUSE_PANELS: readonly WarehousePanelMeta[] = [
  {
    slug: 'approvals',
    labelKey: 'warehouse.tabs.approvalQueue',
    icon: ClipboardCheck,
    permission: 'replenishment.approve.warehouse',
  },
  {
    slug: 'stock',
    labelKey: 'warehouse.tabs.stock',
    icon: Boxes,
    permission: 'inventory.balance.read',
  },
  {
    slug: 'receiving',
    labelKey: 'warehouse.tabs.receiving',
    icon: PackageCheck,
    permission: ['purchasing.po.receive', 'purchasing.read'],
  },
  {
    slug: 'opname',
    labelKey: 'warehouse.tabs.opname',
    icon: ListChecks,
    permission: ['opname.read', 'opname.create'],
  },
  {
    slug: 'waste',
    labelKey: 'warehouse.tabs.waste',
    icon: Trash2,
    permission: ['waste.read', 'waste.create'],
  },
  {
    slug: 'retur',
    labelKey: 'warehouse.tabs.return',
    icon: Undo2,
    permission: ['return.create', 'return.read'],
  },
  {
    slug: 'pengiriman',
    labelKey: 'warehouse.tabs.suratJalan',
    icon: Route,
    permission: ['delivery.sj.create', 'delivery.read'],
  },
];

/**
 * `rekap` ("Rekap Harian") IS NO LONGER A PANEL HERE. Owner, 2026-08-27: the
 * daily recap, Pengiriman (Dispatcher) and Penugasan Pengiriman "need to be
 * combined like dashboard" — three sidebar entries for one job (what is going
 * out today, who is driving it, and the day's totals) meant three screens to
 * cross-check by hand. All three are now tabs of `DeliveryShell`
 * (`components/delivery/DeliveryShell.tsx`), which is what "like dashboard"
 * means here: one surface, tabs across it, each still permission-gated on its
 * own key (`report.logistics.read` for this one, unchanged).
 *
 * `/warehouse/rekap` still resolves — `app/warehouse/rekap/page.tsx` redirects
 * to `/delivery/rekap` — so bookmarks and old links land on the tab instead of
 * a 404. `CalendarRange` is no longer imported for the same reason.
 */

export function isWarehousePanelSlug(slug: string): boolean {
  return WAREHOUSE_PANELS.some((p) => p.slug === slug);
}
