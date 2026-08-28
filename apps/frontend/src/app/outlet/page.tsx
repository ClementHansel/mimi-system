'use client';

import { PermissionGate } from '@/components/ui';
import { OutletShell } from '@/components/outlet/OutletShell';
import { ReplenishmentPanel } from '@/components/outlet/ReplenishmentPanel';

/**
 * F04 `outlet` — the daily working screens for Leader/Staff Outlet and
 * Supervisor Cabang (BUILD-PLAN W4-07).
 *
 * WAS A TABBED SHELL, NOW EIGHT ROUTES (owner, 2026-08-27: "in outlet, these
 * top tab need to be changed into outlet sidebar"). Each flow lives at its own
 * URL under `/outlet/*` and appears as a sidebar entry in `lib/nav.ts`; see
 * `components/outlet/OutletShell.tsx` for why tabs were the wrong control and
 * where the shared outlet resolution went.
 *
 * `/outlet` ITSELF IS MINTA BARANG rather than an index page or a redirect.
 * The interface's `href` has to land somewhere real, an outlet's most frequent
 * job is requesting stock, and every link and bookmark to `/outlet` that
 * existed while this was a tabbed shell still opens a working screen instead of
 * a stub. Its sidebar entry is `exact` so it does not stay lit on the seven
 * sibling routes.
 */
export default function OutletPage() {
  return (
    <OutletShell titleKey="outlet.tabs.replenishment">
      <PermissionGate permission={['replenishment.read', 'replenishment.create']} showMessage>
        <ReplenishmentPanel />
      </PermissionGate>
    </OutletShell>
  );
}
