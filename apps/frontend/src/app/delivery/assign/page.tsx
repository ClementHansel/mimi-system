import { PermissionGate } from '@/components/ui';
import { DeliveryShell } from '@/components/delivery/DeliveryShell';

/**
 * `/delivery/assign` — the dispatcher assignment screen (pick a Surat Jalan,
 * assign its driver + truck, reorder its drops) used to live here as its own
 * page. Owner, 2026-08-27: "this should be displayed as a tab inside
 * pengiriman (dispatcher)" — it is now the "Penugasan" tab of `DeliveryShell`
 * (`app/delivery/page.tsx`). This route is kept, rather than deleted, purely
 * so anything that still links or navigates straight to `/delivery/assign`
 * (a bookmark, a deep link) lands on that tab instead of a 404 — it renders
 * the exact same shell, pre-selected to `assign`.
 *
 * Gated the same way the rest of this module's write actions are
 * (`delivery.sj.create`, KEPALA_GUDANG-only per the RBAC matrix) — this
 * screen only ever calls the two endpoints already behind that permission
 * (`PATCH /delivery/surat-jalan/:id`, `PUT /delivery/surat-jalan/:id/route`),
 * so gating the page the same way avoids rendering controls a signed-in
 * user's own PATCH/PUT would be rejected for anyway. Kept as an explicit
 * gate here (rather than relying only on the tab being hidden inside
 * `DeliveryShell`) so a direct hit on this URL without the permission shows
 * the standard "no access" message instead of silently falling back to the
 * list tab.
 */
export default function DeliveryAssignPage() {
  return (
    <PermissionGate permission="delivery.sj.create" showMessage>
      <DeliveryShell initialTab="assign" />
    </PermissionGate>
  );
}
