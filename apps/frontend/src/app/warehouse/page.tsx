import { WarehouseDashboard } from '@/components/warehouse/WarehouseDashboard';

/**
 * F05 `warehouse` — Gudang Pusat's front page (Balikpapan), for Kepala Gudang
 * and warehouse staff (BUILD-PLAN W4-08).
 *
 * This was a title above an eight-tab strip: a container rather than a page.
 * The tabs are now routes of their own under `/warehouse/<slug>`, listed in the
 * sidebar and defined once in `lib/warehouse-panels.ts`, which frees this route
 * to be what the owner asked for — a dashboard of the whole warehouse.
 *
 * Kepala Gudang is not a central role: `Me.locations`/`Me.permissions` are
 * already scoped server-side to the warehouse plus the outlets it ships to, so
 * no client-side location filtering happens here.
 */
export default function WarehousePage() {
  return <WarehouseDashboard />;
}
