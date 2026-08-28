import { redirect } from 'next/navigation';

/**
 * `/warehouse/rekap` — where "Rekap Harian" used to live as one of Gudang
 * Pusat's eight panels. Owner, 2026-08-27: the recap, Pengiriman (Dispatcher)
 * and Penugasan Pengiriman "need to be combined like dashboard", so the recap
 * is now the "Rekap Harian" tab of `DeliveryShell` at `/delivery/rekap`.
 *
 * Kept as a redirect rather than deleted: a static segment beats the
 * `[panel]` dynamic route, so without this file a bookmark or an old link to
 * this URL would hit `notFound()` (the slug is gone from `WAREHOUSE_PANELS`).
 * The redirect also keeps the user inside whatever interface they came from —
 * `/delivery` is a SHARED route (`lib/nav.ts`), so arriving from gudang keeps
 * gudang's sidebar.
 */
export default function WarehouseRekapRedirectPage() {
  redirect('/delivery/rekap');
}
