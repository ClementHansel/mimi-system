/**
 * The RBAC matrix — CONTRACTS.md §3, transcribed verbatim as typed data.
 *
 * 137 permission keys × 9 roles (as amended: D-18/Amendment 1 added the three
 * `payroll.statutory.*` keys, D-19/Amendment 2 added `pos.cash_variance.read`
 * and `pos.cash_variance.approve`, D-20 added `supplier.directory.read` — six
 * keys beyond the original 131. CONTRACTS.md's own footer summary line still
 * reads "131 permission keys" at the time this file was written; that line is
 * stale relative to its own table, which lists 137 rows. This file matches
 * the TABLE, which is the actual contract per BUILD-PLAN §6 rule 7 — flagged
 * for the architect to reconcile the summary line.
 *
 * `PermissionsGuard` (apps/backend) checks a key from here; RLS additionally
 * scopes rows by location — a ✓ never grants cross-location access for scoped
 * roles (KGD/SPV/LDR/KSR/DRV act only within their `user_locations`). Approval
 * keys authorize *acting on the step whose `approver_role` matches*; the
 * engine (`./approvals`) enforces step order.
 */
import { RoleKey } from './enums';

/** Column order matches CONTRACTS.md §3's table exactly. */
export const RBAC_ROLE_ORDER: readonly RoleKey[] = [
  RoleKey.OWNER,
  RoleKey.MANAGER,
  RoleKey.FINANCE,
  RoleKey.KEPALA_GUDANG,
  RoleKey.SUPERVISOR,
  RoleKey.LEADER_OUTLET,
  RoleKey.KASIR,
  RoleKey.HR_ADMIN,
  RoleKey.DRIVER,
] as const;

// Each data row is `[key, flags]` where `flags` is
// `[OWN, MGR, FIN, KGD, SPV, LDR, KSR, HRA, DRV]` in `RBAC_ROLE_ORDER` order.
// `as const` below is load-bearing: it is what turns each row's key into its
// own string-literal type instead of widening to `string`, which is what lets
// `PermissionKey` (derived from this array) be a closed union of the 137
// actual keys rather than semantic-only documentation. Do not add a
// `: SomeType[]` annotation to this declaration — that would re-widen every
// key back to `string` and silently defeat the whole point.
// prettier-ignore
const PERMISSION_ROWS = [
  // ── auth / users / admin ──────────────────────────────────────────────────
  ['auth.pin.set',                        [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['auth.offline_credential.mint',        [true,  true,  false, false, true,  false, false, false, false]],
  ['user.read',                           [true,  true,  true,  false, false, false, false, true,  false]],
  ['user.create',                         [true,  true,  false, false, false, false, false, false, false]],
  ['user.update',                         [true,  true,  false, false, false, false, false, false, false]],
  ['user.deactivate',                     [true,  true,  false, false, false, false, false, false, false]],
  ['user.role.assign',                    [true,  true,  false, false, false, false, false, false, false]],
  ['user.location.assign',                [true,  true,  false, false, false, false, false, false, false]],
  ['user.password.reset',                 [true,  true,  false, false, false, false, false, false, false]],
  ['audit.read',                          [true,  true,  true,  false, false, false, false, false, false]],
  ['settings.read',                       [true,  true,  true,  true,  false, false, false, true,  false]],
  ['settings.manage',                     [true,  true,  false, false, false, false, false, false, false]],
  ['settings.approval_chain.manage',      [true,  false, false, false, false, false, false, false, false]],
  // D-23 (owner-decided, not yet folded into CONTRACTS.md §3 — see enums.ts's `ApprovalMode` doc
  // comment for the same drift note): per-document-type approval MODE (manual/whatsapp/auto/off)
  // is Owner-only, deliberately narrower than `settings.approval_chain.manage`'s own Owner-only row
  // above — turning approval OFF for a document type is a materially bigger lever than editing a
  // chain's step thresholds, so it gets its own key rather than piggybacking on that one.
  ['settings.approval_mode.manage',       [true,  false, false, false, false, false, false, false, false]],
  // ── location / master data ────────────────────────────────────────────────
  ['location.read',                       [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['location.manage',                     [true,  true,  false, false, false, false, false, false, false]],
  ['storage_area.manage',                 [true,  true,  false, false, false, false, false, false, false]],
  ['item.read',                           [true,  true,  true,  true,  true,  true,  false, false, false]],
  ['item.manage',                         [true,  true,  false, true,  false, false, false, false, false]],
  ['unit.manage',                         [true,  true,  false, false, false, false, false, false, false]],
  ['product.read',                        [true,  true,  true,  true,  true,  true,  true,  false, false]],
  ['product.manage',                      [true,  true,  false, false, false, false, false, false, false]],
  ['recipe.read',                         [true,  true,  true,  true,  false, false, false, false, false]],
  ['recipe.manage',                       [true,  true,  false, false, false, false, false, false, false]],
  // ── supplier (FR-SUP-06 role lock; D-20 directory split) ──────────────────
  ['supplier.read',                       [true,  true,  true,  true,  false, false, false, false, false]],
  ['supplier.directory.read',             [true,  true,  true,  true,  true,  true,  false, false, false]],
  ['supplier.manage',                     [true,  true,  false, true,  false, false, false, false, false]],
  ['supplier.price.read',                 [true,  true,  true,  true,  false, false, false, false, false]],
  ['supplier.price.manage',               [true,  true,  false, true,  false, false, false, false, false]],
  // ── inventory ──────────────────────────────────────────────────────────────
  ['inventory.balance.read',              [true,  true,  true,  true,  true,  true,  true,  false, false]],
  ['inventory.movement.read',             [true,  true,  true,  true,  true,  true,  false, false, false]],
  ['inventory.minstock.manage',           [true,  true,  false, true,  false, false, false, false, false]],
  ['inventory.area_transfer.create',      [false, false, false, true,  true,  true,  false, false, false]],
  ['inventory.suggestion.read',           [true,  true,  false, true,  true,  true,  false, false, false]],
  // ── stock opname ───────────────────────────────────────────────────────────
  ['opname.read',                         [true,  true,  true,  true,  true,  true,  false, false, false]],
  ['opname.create',                       [false, false, false, true,  true,  true,  false, false, false]],
  ['opname.submit',                       [false, false, false, true,  true,  true,  false, false, false]],
  ['opname.approve',                      [true,  true,  false, true,  true,  false, false, false, false]],
  // ── replenishment ──────────────────────────────────────────────────────────
  ['replenishment.read',                  [true,  true,  false, true,  true,  true,  false, false, false]],
  ['replenishment.create',                [false, false, false, false, true,  true,  false, false, false]],
  ['replenishment.submit',                [false, false, false, false, true,  true,  false, false, false]],
  ['replenishment.approve.supervisor',    [true,  true,  false, false, true,  false, false, false, false]],
  ['replenishment.approve.warehouse',     [true,  true,  false, true,  false, false, false, false, false]],
  ['replenishment.amend',                 [true,  true,  false, true,  true,  false, false, false, false]],
  // ── delivery / surat jalan ─────────────────────────────────────────────────
  ['delivery.read',                       [true,  true,  false, true,  true,  true,  false, false, true ]],
  ['delivery.sj.create',                  [false, false, false, true,  false, false, false, false, false]],
  ['delivery.sj.dispatch',                [false, false, false, true,  false, false, false, false, false]],
  ['delivery.sj.cancel',                  [false, true,  false, true,  false, false, false, false, false]],
  ['delivery.drop.execute',               [false, false, false, true,  false, false, false, false, true ]],
  ['delivery.receive',                    [false, false, false, false, true,  true,  false, false, false]],
  ['delivery.master.manage',              [true,  true,  false, true,  false, false, false, false, false]],
  // ── purchasing / petty cash ────────────────────────────────────────────────
  ['purchasing.read',                     [true,  true,  true,  true,  true,  false, false, false, false]],
  ['purchasing.pr.create',                [false, false, false, true,  true,  false, false, false, false]],
  ['purchasing.pr.approve',               [true,  true,  false, false, false, false, false, false, false]],
  ['purchasing.po.create',                [false, true,  false, true,  false, false, false, false, false]],
  ['purchasing.po.approve',               [true,  true,  false, false, false, false, false, false, false]],
  ['purchasing.po.receive',               [false, false, false, true,  false, true,  false, false, false]],
  ['purchasing.po.close',                 [false, false, true,  false, false, false, false, false, false]],
  ['pettycash.read',                      [true,  true,  true,  false, true,  true,  false, false, false]],
  ['pettycash.create',                    [false, false, false, false, true,  true,  false, false, false]],
  ['pettycash.verify',                    [false, true,  true,  false, false, false, false, false, false]],
  // ── waste / returns ────────────────────────────────────────────────────────
  ['waste.read',                          [true,  true,  true,  true,  true,  true,  false, false, false]],
  ['waste.create',                        [false, false, false, true,  true,  true,  false, false, false]],
  ['waste.approve',                       [true,  true,  false, true,  true,  false, false, false, false]],
  ['return.read',                         [true,  true,  true,  true,  true,  true,  false, false, false]],
  ['return.create',                       [false, false, false, true,  true,  true,  false, false, false]],
  ['return.approve',                      [true,  true,  false, true,  true,  false, false, false, false]],
  ['return.ship',                         [false, false, false, true,  true,  true,  false, false, false]],
  ['return.receive',                      [false, false, false, true,  false, false, false, false, false]],
  // ── POS ────────────────────────────────────────────────────────────────────
  ['pos.catalog.read',                    [true,  true,  false, false, true,  true,  true,  false, false]],
  ['pos.shift.open',                      [false, false, false, false, true,  false, true,  false, false]],
  ['pos.shift.close',                     [false, false, false, false, true,  false, true,  false, false]],
  ['pos.sale.create',                     [false, false, false, false, true,  false, true,  false, false]],
  ['pos.sale.read',                       [true,  true,  true,  false, true,  true,  true,  false, false]],
  ['pos.void.request',                    [false, false, false, false, true,  false, true,  false, false]],
  ['pos.void.approve',                    [true,  true,  false, false, true,  false, false, false, false]],
  ['pos.online_order.record',             [false, false, false, false, true,  true,  true,  false, false]],
  ['pos.online_order.read',               [true,  true,  true,  false, true,  true,  true,  false, false]],
  ['pos.daily_stock.read',                [true,  true,  false, true,  true,  true,  true,  false, false]],
  ['pos.cash_variance.read',              [true,  true,  true,  false, true,  false, false, true,  false]],
  ['pos.cash_variance.approve',           [true,  true,  false, false, true,  false, false, false, false]],
  // ── HR ─────────────────────────────────────────────────────────────────────
  ['hr.attendance.check',                 [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['hr.attendance.read',                  [true,  true,  false, false, true,  false, false, true,  false]],
  ['hr.attendance.correct',               [false, false, false, false, false, false, false, true,  false]],
  ['hr.shift.read',                       [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['hr.shift.manage',                     [false, true,  false, false, true,  false, false, true,  false]],
  ['hr.employee.read',                    [true,  true,  true,  false, true,  false, false, true,  false]],
  ['hr.employee.manage',                  [true,  true,  false, false, false, false, false, true,  false]],
  ['hr.leave.request',                    [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['hr.leave.approve',                    [true,  true,  false, false, true,  false, false, true,  false]],
  ['hr.leave.read',                       [true,  true,  false, false, true,  false, false, true,  false]],
  // ── payroll ────────────────────────────────────────────────────────────────
  ['payroll.read',                        [true,  true,  true,  false, false, false, false, true,  false]],
  ['payroll.component.manage',            [true,  false, true,  false, false, false, false, true,  false]],
  ['payroll.run.calculate',               [false, false, false, false, false, false, false, true,  false]],
  ['payroll.run.submit',                  [false, false, false, false, false, false, false, true,  false]],
  ['payroll.run.approve',                 [true,  true,  true,  false, false, false, false, false, false]],
  ['payroll.run.pay',                     [true,  false, true,  false, false, false, false, false, false]],
  ['payroll.slip.send',                   [false, false, false, false, false, false, false, true,  false]],
  ['payroll.slip.read.own',               [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['payroll.loan.manage',                 [false, false, true,  false, false, false, false, true,  false]],
  ['payroll.loan.approve',                [true,  true,  true,  false, false, false, false, false, false]],
  ['payroll.statutory.read',              [true,  true,  true,  false, false, false, false, true,  false]],
  ['payroll.statutory.config',            [false, false, true,  false, false, false, false, true,  false]],
  ['payroll.statutory.enable',            [true,  true,  false, false, false, false, false, false, false]],
  // ── assets (PMS) ───────────────────────────────────────────────────────────
  ['asset.read',                          [true,  true,  true,  true,  true,  true,  false, false, false]],
  ['asset.manage',                        [true,  true,  false, false, false, false, false, false, false]],
  ['asset.schedule.manage',               [true,  true,  false, false, false, false, false, false, false]],
  ['asset.job.execute',                   [false, true,  false, true,  true,  true,  false, false, false]],
  ['asset.job.verify',                    [true,  true,  false, false, true,  false, false, false, false]],
  // ── accounting / payments ──────────────────────────────────────────────────
  ['accounting.coa.read',                 [true,  true,  true,  false, false, false, false, false, false]],
  ['accounting.coa.manage',               [true,  false, true,  false, false, false, false, false, false]],
  ['accounting.journal.read',             [true,  true,  true,  false, false, false, false, false, false]],
  ['accounting.journal.post',             [false, false, true,  false, false, false, false, false, false]],
  ['accounting.journal.reverse',          [false, false, true,  false, false, false, false, false, false]],
  ['accounting.period.close',             [true,  false, true,  false, false, false, false, false, false]],
  ['accounting.report.read',              [true,  true,  true,  false, false, false, false, false, false]],
  ['payment.read',                        [true,  true,  true,  false, false, false, false, false, false]],
  ['payment.proof.upload',                [true,  true,  true,  true,  true,  true,  true,  true,  false]],
  ['payment.verify',                      [false, false, true,  false, false, false, false, false, false]],
  ['payment.pay',                         [true,  false, true,  false, false, false, false, false, false]],
  ['payment.reject',                      [false, false, true,  false, false, false, false, false, false]],
  // ── dashboard / reports ─────────────────────────────────────────────────────
  ['dashboard.view',                      [true,  true,  false, false, false, false, false, false, false]],
  ['dashboard.outlet.view',               [true,  true,  false, false, true,  false, false, false, false]],
  ['report.sales.read',                   [true,  true,  true,  false, true,  false, false, false, false]],
  ['report.logistics.read',               [true,  true,  false, true,  false, false, false, false, false]],
  ['report.hr.read',                      [true,  true,  false, false, false, false, false, true,  false]],
  ['report.export',                       [true,  true,  true,  true,  false, false, false, true,  false]],
  // ── devices / topology / sync ───────────────────────────────────────────────
  ['device.read',                         [true,  true,  false, false, true,  false, false, false, false]],
  ['device.pair',                         [true,  true,  false, false, true,  false, false, false, false]],
  ['device.manage',                       [true,  true,  false, false, false, false, false, false, false]],
  ['node.read',                           [true,  true,  false, false, false, false, false, false, false]],
  ['node.manage',                         [true,  true,  false, false, false, false, false, false, false]],
  ['topology.read',                       [true,  true,  false, false, false, false, false, false, false]],
  ['sync.status.read',                    [true,  true,  false, false, true,  false, false, false, false]],
  ['sync.conflict.resolve',               [true,  true,  false, false, false, false, false, false, false]],
  ['sync.exception.review',               [true,  false, true,  false, false, false, false, false, false]],
  // ── kernel ─────────────────────────────────────────────────────────────────
  ['notification.read.own',               [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['attachment.upload',                   [true,  true,  true,  true,  true,  true,  true,  true,  true ]],
] as const;

/**
 * Typed union of every permission key (for `@RequirePermission(<key>)`
 * decorators and `PermissionGate`/similar frontend props). Derived directly
 * from `PERMISSION_ROWS` via `as const`, so it can never drift from the
 * table — adding, removing, or renaming a row automatically updates this
 * type with no second place to edit. A hand-typed key not in this union
 * (e.g. a `supplier.directory.read` typo'd as `suplier.directory.read`) is a
 * COMPILE ERROR, not a silent 403 that looks like an RBAC policy decision.
 */
export type PermissionKey = (typeof PERMISSION_ROWS)[number][0];

/** Every permission key, in contract order. */
export const PERMISSION_KEYS: readonly PermissionKey[] = PERMISSION_ROWS.map(([key]) => key);

export const PERMISSION_KEY_COUNT = PERMISSION_KEYS.length;

/** `RBAC_MATRIX[permissionKey][role] === true` iff the role holds that permission. */
export const RBAC_MATRIX: Readonly<Record<PermissionKey, Readonly<Record<RoleKey, boolean>>>> = Object.fromEntries(
  PERMISSION_ROWS.map(([key, flags]) => [
    key,
    Object.fromEntries(RBAC_ROLE_ORDER.map((role, i) => [role, flags[i]])) as Record<RoleKey, boolean>,
  ]),
) as Record<PermissionKey, Readonly<Record<RoleKey, boolean>>>;

/**
 * The authorization predicate `PermissionsGuard` calls. `permission` is typed
 * as the closed `PermissionKey` union at every call site that types a literal
 * directly (decorators, gate props); the `?? false` fallback remains for
 * defense-in-depth against a value that reached this function through an
 * untyped boundary (e.g. NestJS reflection metadata, which is just a string
 * again by the time a guard reads it back at runtime) — an unknown key is
 * treated as denied (fail closed) rather than throwing.
 */
export function can(role: RoleKey, permission: PermissionKey): boolean {
  return RBAC_MATRIX[permission]?.[role] ?? false;
}

/** Every permission key a role holds — used to build `Me.permissions` at login (M01). */
export function permissionsForRole(role: RoleKey): PermissionKey[] {
  return PERMISSION_KEYS.filter((key) => can(role, key));
}

/** Every role that holds a given permission — used by approval-chain seeding and admin UIs. */
export function rolesWithPermission(permission: PermissionKey): RoleKey[] {
  return RBAC_ROLE_ORDER.filter((role) => can(role, permission));
}
