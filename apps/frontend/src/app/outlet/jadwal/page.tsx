'use client';

import { PermissionGate } from '@/components/ui';
import { OutletShell } from '@/components/outlet/OutletShell';
import { useOutletLocationContext } from '@/components/outlet/lib/outlet-location-context';
import { RosterPanel } from '@/components/hr/RosterPanel';

/**
 * The SAME roster panel `/hr` mounts (owner, 2026-08-27: the schedule "should
 * be in each outlet and dashboard, so either can set schedule for their
 * employees"). One component, so the office and the branch cannot drift into
 * two different rostering screens.
 *
 * Pinned to the outlet `OutletShell` resolved — a branch never rosters another
 * branch from here. `hr.shift.read` is held by every role, so a kasir can see
 * the week they are on; the selects and the save button stay gated on
 * `hr.shift.manage` INSIDE the panel, which supervisor and hr_admin hold and
 * the floor does not.
 */
export default function Page() {
  return (
    <OutletShell titleKey="outlet.tabs.roster">
      <PermissionGate permission="hr.shift.read" showMessage>
        <OutletRoster />
      </PermissionGate>
    </OutletShell>
  );
}

/**
 * Reads the settled outlet from context rather than taking a prop: threading
 * the id down from the shell would be the one place it could be forgotten.
 */
function OutletRoster() {
  const { locationId } = useOutletLocationContext();
  return <RosterPanel locationId={locationId} />;
}
