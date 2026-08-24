import { ImportPanel } from '@/components/import/ImportPanel';
import { PermissionGate } from '@/components/ui/PermissionGate';

/**
 * `/admin/import` — bulk master-data import (owner, 2026-08-24). A separate
 * route rather than a fifth `AdminShell` tab: `AdminShell`/`MasterDataPanel`/
 * `nav.ts` are owned by another in-flight change to this checkout, so this
 * page stands alone for now — the owner adds the nav entry (and, per this
 * feature's delivery report, the `importData.*` i18n copy) once both land.
 *
 * Permission-gated the same way `AdminShell`'s own tabs are: ANY of the
 * entities' manage keys, because the 9-role matrix does not grant
 * `item.manage`/`product.manage` uniformly (CONTRACTS.md §3) — the real
 * boundary per entity is still enforced server-side by `ImportController`.
 */
export default function AdminImportPage() {
  return (
    <PermissionGate permission={['item.manage', 'product.manage']} showMessage>
      <ImportPanel />
    </PermissionGate>
  );
}
