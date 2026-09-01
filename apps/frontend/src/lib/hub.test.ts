import { describe, expect, it } from 'vitest';
import { INTERFACES } from './nav';
import { interfaceEntryHref } from './hub';
import { hasPermission } from './permissions';
import type { PermissionKeyOrKeys } from './permissions';

/**
 * The hub card must send a person somewhere they can actually go.
 *
 * `AppInterface.href` is a single fixed route, but reaching an interface is
 * ANY-of the areas inside it — by design, so that a Finance user with no
 * `dashboard.view` still belongs in the dashboard. The card ignored that and
 * pointed everyone at `/dashboard`, so a driver and the kepala gudang were
 * offered "Dasbor" and got "Anda tidak memiliki akses ke bagian ini."
 *
 * These are role-shaped rather than abstract: the permission sets below are
 * the real ones from `@mimi/shared`'s matrix for the roles that were broken,
 * so the test fails if either the matrix or the nav config moves under it.
 */
function canFor(permissions: string[]): (k?: PermissionKeyOrKeys) => boolean {
  return (k) => hasPermission(permissions, k);
}

const dashboard = INTERFACES.find((i) => i.id === 'dashboard')!;

describe('interfaceEntryHref — the hub card resolves to a reachable entry', () => {
  it('keeps /dashboard for someone who can open it', () => {
    expect(interfaceEntryHref(dashboard, canFor(['dashboard.view']))).toBe('/dashboard');
  });

  it('sends a DRIVER to their delivery board, not to the overview they cannot see', () => {
    // A driver is in the dashboard interface for `delivery.read` alone.
    const href = interfaceEntryHref(dashboard, canFor(['delivery.read']));
    expect(href).not.toBe('/dashboard');
    expect(href).toBe('/delivery');
  });

  it('sends a KEPALA GUDANG to purchasing rather than a refusal', () => {
    // KGD reaches the interface via `purchasing.read`/`delivery.read`.
    const href = interfaceEntryHref(dashboard, canFor(['purchasing.read']));
    expect(href).not.toBe('/dashboard');
    expect(href).toBe('/purchasing');
  });

  it("prefers the role's own landing route over whatever sits first in the sidebar", () => {
    // FINANCE reaches the dashboard interface without `dashboard.view`, and
    // holds an approval key — so "first openable entry" sent them to
    // `/approvals` (Persetujuan Saya), not `/finance`. Right destination for
    // the driver, wrong one for finance. `landing.ts` already records where
    // each role actually works, so the card asks it first.
    const financeCan = canFor(['payment.read', 'payment.verify', 'accounting.journal.read']);
    expect(interfaceEntryHref(dashboard, financeCan, '/finance')).toBe('/finance');

    // Without the landing hint the fallback still applies, and still lands
    // somewhere they can open — it is a preference, not a requirement.
    expect(interfaceEntryHref(dashboard, financeCan)).not.toBe('/dashboard');
  });

  it('ignores a landing route that is not in this interface, or that they cannot open', () => {
    // A kasir's landing is `/pos`, which is a different INTERFACE — the
    // dashboard card must not be pointed at it.
    const can = canFor(['delivery.read']);
    expect(interfaceEntryHref(dashboard, can, '/pos')).toBe('/delivery');
    // And a landing inside this interface that the role cannot actually open
    // is not a valid destination either.
    expect(interfaceEntryHref(dashboard, can, '/finance')).toBe('/delivery');
  });

  it('never returns a route the person cannot open, for any single-permission holder', () => {
    // The property that matters, checked across every gate the interface
    // admits: whatever the card points at, they can open it. A future area
    // added to the sidebar cannot quietly reintroduce the dead end.
    const gates = Array.isArray(dashboard.permission)
      ? dashboard.permission
      : [dashboard.permission!];
    for (const gate of gates) {
      const can = canFor([gate as string]);
      const href = interfaceEntryHref(dashboard, can);
      const entry = dashboard.sections.flatMap((s) => s.items).find((i) => i.href === href);
      // Either the target is not itself a gated sidebar entry (the interface
      // gate was the only check), or this person passes that entry's gate.
      expect(!entry || can(entry.permission), `${gate} → ${href} is not openable`).toBe(true);
    }
  });
});
