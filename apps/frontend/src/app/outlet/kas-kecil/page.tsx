'use client';

import { PermissionGate } from '@/components/ui';
import { OutletShell } from '@/components/outlet/OutletShell';
import { PettyCashPanel } from '@/components/outlet/PettyCashPanel';

/**
 * One flow of the Outlet surface, as its own route.
 *
 * These eight were tabs on `/outlet` until 2026-08-27 (owner: "in outlet, these
 * top tab need to be changed into outlet sidebar"). `OutletShell` resolves WHICH
 * OUTLET once and provides it to the panel; the `PermissionGate` here is the
 * same CONTRACTS §3 key the tab carried, so a role sees only what it can act on.
 * The server-side check is still the real boundary — this only hides UI.
 */
export default function Page() {
  return (
    <OutletShell titleKey="outlet.tabs.pettyCash">
      <PermissionGate permission="pettycash.read" showMessage>
        <PettyCashPanel />
      </PermissionGate>
    </OutletShell>
  );
}
