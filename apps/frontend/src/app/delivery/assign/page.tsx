import { PermissionGate } from '@/components/ui';
import { DispatchAssignScreen } from '@/components/delivery/DispatchAssignScreen';

/**
 * F-DELIVERY dispatcher assignment screen — pick a Surat Jalan, assign its
 * driver + truck, reorder its drops. Gated the same way the rest of this
 * module's write actions are (`delivery.sj.create`, KEPALA_GUDANG-only per
 * the RBAC matrix) — this route only ever calls the two endpoints already
 * behind that permission (`PATCH /delivery/surat-jalan/:id`,
 * `PUT /delivery/surat-jalan/:id/route`), so gating the page the same way
 * avoids rendering controls a signed-in user's own PATCH/PUT would be
 * rejected for anyway.
 */
export default function DeliveryAssignPage() {
  return (
    <PermissionGate permission="delivery.sj.create" showMessage>
      <DispatchAssignScreen />
    </PermissionGate>
  );
}
