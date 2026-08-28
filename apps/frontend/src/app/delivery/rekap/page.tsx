import { PermissionGate } from '@/components/ui';
import { DeliveryShell } from '@/components/delivery/DeliveryShell';

/**
 * `/delivery/rekap` — the daily logistics recap, as the fourth tab of the
 * dispatcher's shell (owner, 2026-08-27: Rekap Harian, Pengiriman (Dispatcher)
 * and Penugasan Pengiriman "need to be combined like dashboard"). It used to be
 * `/warehouse/rekap`, one of Gudang Pusat's sidebar panels; that URL now
 * redirects here.
 *
 * A real route rather than tab-only state, for the same reason
 * `/delivery/assign` is one: the recap is the screen someone links to in a
 * message ("look at today's numbers"), and a tab inside one URL cannot be
 * linked, bookmarked, or opened side by side.
 *
 * Gated on the key the old panel checked (`report.logistics.read`), so a direct
 * hit without it shows the standard no-access message instead of silently
 * falling back to the Surat Jalan list.
 */
export default function DeliveryRekapPage() {
  return (
    <PermissionGate permission="report.logistics.read" showMessage>
      <DeliveryShell initialTab="rekap" />
    </PermissionGate>
  );
}
