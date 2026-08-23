/**
 * The RBAC matrix — CONTRACTS.md §3, transcribed verbatim as typed data.
 *
 * 150 permission keys × 10 roles (as amended: D-18/Amendment 1 added the three
 * `payroll.statutory.*` keys, D-19/Amendment 2 added `pos.cash_variance.read`
 * and `pos.cash_variance.approve`, D-20 added `supplier.directory.read` — six
 * keys beyond the original 131. CONTRACTS.md's own footer summary line still
 * reads "131 permission keys" at the time this file was written; that line is
 * stale relative to its own table, which lists 137 rows. This file matches
 * the TABLE, which is the actual contract per BUILD-PLAN §6 rule 7 — flagged
 * for the architect to reconcile the summary line.
 *
 * KOKI (`koki`, "Juru Masak") was added 2026-08-23 at the owner's request: an
 * outlet crew is a supervisor, a cashier and TWO COOKS per shift, and the cooks
 * had no role of their own. They were being created as `leader_outlet`, which
 * meant 120 cooks each holding `purchasing.po.receive`, `pettycash.create`,
 * `opname.submit`, `replenishment.submit` and `return.ship` — a kitchen hand
 * able to receive a supplier delivery and sign off a stock count.
 *
 * The column is deliberately NARROW and the line it draws is "your own record,
 * plus the kitchen floor, and no document workflow": attendance, own contract /
 * payslip / loan / leave, own chat thread; then read the menu and what is in
 * stock, move stock between storage areas (thawing is the cook's job), and
 * record spoilage. It cannot open a till, submit a count, receive a delivery,
 * or touch petty cash.
 *
 * No RLS change was needed, which is worth recording because it was the thing
 * feared most: the location-scoped tables key off `app_has_location()` and the
 * personal ones off `app_is_self()`, so neither cares that a tenth role exists.
 * Only `drivers_select` and `suppliers_select` name `leader_outlet` by hand, and
 * a cook needs neither.
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
  RoleKey.KOKI,
  RoleKey.SUPERADMIN,
] as const;

// Each data row is `[key, flags]` where `flags` is
// `[OWN, MGR, FIN, KGD, SPV, LDR, KSR, HRA, DRV, KOK, SA]` in `RBAC_ROLE_ORDER` order.
// SA (superadmin) is `true` on every row by definition — see RoleKey.SUPERADMIN.
// `as const` below is load-bearing: it is what turns each row's key into its
// own string-literal type instead of widening to `string`, which is what lets
// `PermissionKey` (derived from this array) be a closed union of the 137
// actual keys rather than semantic-only documentation. Do not add a
// `: SomeType[]` annotation to this declaration — that would re-widen every
// key back to `string` and silently defeat the whole point.
// prettier-ignore
const PERMISSION_ROWS = [
  // ── auth / users / admin ──────────────────────────────────────────────────
  ['auth.pin.set',                        [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['auth.offline_credential.mint',        [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  // B-15 (owner decisions 2026-08-22). `approval.code.issue` mints the one-time
  // code that replaced the static-PIN check; `auth.lockout.clear` frees a caller
  // who burned their attempts. BOTH are deliberately coarse — the real checks
  // are in the service: eligibility comes from `eligibleActorsForAction` (the
  // §5.2 state machine, not a grant table), and clearing a lock additionally
  // requires the clearer to outrank the locked user by `ROLE_RANK` (Q6), which
  // is why supervisor holds `auth.lockout.clear` yet cannot free another
  // supervisor. Kasir/driver/leader_outlet hold neither: none is a named
  // approver on any chain, so the key would read like an authorization it is not.
  ['approval.code.issue',                 [true,  true,  true,  true,  true,  false, false, true,  false, false, true ]],
  ['auth.lockout.clear',                  [true,  true,  false, true,  true,  false, false, true,  false, false, true ]],
  ['user.read',                           [true,  true,  true,  false, false, false, false, true,  false, false, true ]],
  ['user.create',                         [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['user.update',                         [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['user.deactivate',                     [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['user.role.assign',                    [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['user.location.assign',                [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['user.password.reset',                 [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['audit.read',                          [true,  true,  true,  false, false, false, false, false, false, false, true ]],
  ['settings.read',                       [true,  true,  true,  true,  false, false, false, true,  false, false, true ]],
  ['settings.manage',                     [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['settings.approval_chain.manage',      [true,  false, false, false, false, false, false, false, false, false, true ]],
  // D-23 (owner-decided, not yet folded into CONTRACTS.md §3 — see enums.ts's `ApprovalMode` doc
  // comment for the same drift note): per-document-type approval MODE (manual/whatsapp/auto/off)
  // is Owner-only, deliberately narrower than `settings.approval_chain.manage`'s own Owner-only row
  // above — turning approval OFF for a document type is a materially bigger lever than editing a
  // chain's step thresholds, so it gets its own key rather than piggybacking on that one.
  ['settings.approval_mode.manage',       [true,  false, false, false, false, false, false, false, false, false, true ]],
  // ── location / master data ────────────────────────────────────────────────
  ['location.read',                       [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['location.manage',                     [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['storage_area.manage',                 [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['item.read',                           [true,  true,  true,  true,  true,  true,  false, false, false, true,  true ]],
  ['item.manage',                         [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['unit.manage',                         [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['product.read',                        [true,  true,  true,  true,  true,  true,  true,  false, false, true,  true ]],
  ['product.manage',                      [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['recipe.read',                         [true,  true,  true,  true,  false, false, false, false, false, false, true ]],
  ['recipe.manage',                       [true,  true,  false, false, false, false, false, false, false, false, true ]],
  // ── supplier (FR-SUP-06 role lock; D-20 directory split) ──────────────────
  ['supplier.read',                       [true,  true,  true,  true,  false, false, false, false, false, false, true ]],
  ['supplier.directory.read',             [true,  true,  true,  true,  true,  true,  false, false, false, false, true ]],
  ['supplier.manage',                     [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['supplier.price.read',                 [true,  true,  true,  true,  false, false, false, false, false, false, true ]],
  ['supplier.price.manage',               [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  // ── inventory ──────────────────────────────────────────────────────────────
  ['inventory.balance.read',              [true,  true,  true,  true,  true,  true,  true,  false, false, true,  true ]],
  ['inventory.movement.read',             [true,  true,  true,  true,  true,  true,  false, false, false, true,  true ]],
  ['inventory.minstock.manage',           [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['inventory.area_transfer.create',      [false, false, false, true,  true,  true,  false, false, false, true,  true ]],
  ['inventory.suggestion.read',           [true,  true,  false, true,  true,  true,  false, false, false, false, true ]],
  // ── stock opname ───────────────────────────────────────────────────────────
  ['opname.read',                         [true,  true,  true,  true,  true,  true,  false, false, false, false, true ]],
  ['opname.create',                       [true,  false, false, true,  true,  true,  false, false, false, false, true ]],
  ['opname.submit',                       [false, false, false, true,  true,  true,  false, false, false, false, true ]],
  ['opname.approve',                      [true,  true,  false, true,  true,  false, false, false, false, false, true ]],
  // ── replenishment ──────────────────────────────────────────────────────────
  ['replenishment.read',                  [true,  true,  false, true,  true,  true,  false, false, false, false, true ]],
  ['replenishment.create',                [true,  false, false, false, true,  true,  false, false, false, false, true ]],
  ['replenishment.submit',                [false, false, false, false, true,  true,  false, false, false, false, true ]],
  ['replenishment.approve.supervisor',    [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  ['replenishment.approve.warehouse',     [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['replenishment.amend',                 [true,  true,  false, true,  true,  false, false, false, false, false, true ]],
  // ── delivery / surat jalan ─────────────────────────────────────────────────
  ['delivery.read',                       [true,  true,  false, true,  true,  true,  false, false, true,  false, true ]],
  ['delivery.sj.create',                  [true,  false, false, true,  false, false, false, false, false, false, true ]],
  ['delivery.sj.dispatch',                [true,  false, false, true,  false, false, false, false, false, false, true ]],
  ['delivery.sj.cancel',                  [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['delivery.drop.execute',               [true,  false, false, true,  false, false, false, false, true,  false, true ]],
  ['delivery.receive',                    [true,  false, false, false, true,  true,  false, false, false, false, true ]],
  ['delivery.master.manage',              [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  // ── purchasing / petty cash ────────────────────────────────────────────────
  ['purchasing.read',                     [true,  true,  true,  true,  true,  false, false, false, false, false, true ]],
  ['purchasing.pr.create',                [true,  false, false, true,  true,  false, false, false, false, false, true ]],
  ['purchasing.pr.approve',               [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['purchasing.po.create',                [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['purchasing.po.approve',               [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['purchasing.po.receive',               [true,  false, false, true,  false, true,  false, false, false, false, true ]],
  ['purchasing.po.close',                 [true,  false, true,  false, false, false, false, false, false, false, true ]],
  ['pettycash.read',                      [true,  true,  true,  false, true,  true,  false, false, false, false, true ]],
  ['pettycash.create',                    [true,  false, false, false, true,  true,  false, false, false, false, true ]],
  ['pettycash.verify',                    [false, true,  true,  false, false, false, false, false, false, false, true ]],
  // ── waste / returns ────────────────────────────────────────────────────────
  ['waste.read',                          [true,  true,  true,  true,  true,  true,  false, false, false, true,  true ]],
  ['waste.create',                        [true,  false, false, true,  true,  true,  false, false, false, true,  true ]],
  ['waste.approve',                       [true,  true,  false, true,  true,  false, false, false, false, false, true ]],
  ['return.read',                         [true,  true,  true,  true,  true,  true,  false, false, false, false, true ]],
  ['return.create',                       [false, false, false, true,  true,  true,  false, false, false, false, true ]],
  ['return.approve',                      [true,  true,  false, true,  true,  false, false, false, false, false, true ]],
  ['return.ship',                         [false, false, false, true,  true,  true,  false, false, false, false, true ]],
  ['return.receive',                      [false, false, false, true,  false, false, false, false, false, false, true ]],
  // ── POS ────────────────────────────────────────────────────────────────────
  ['pos.catalog.read',                    [true,  true,  false, false, true,  true,  true,  false, false, false, true ]],
  ['pos.shift.open',                      [false, false, false, false, true,  false, true,  false, false, false, true ]],
  ['pos.shift.close',                     [false, false, false, false, true,  false, true,  false, false, false, true ]],
  ['pos.sale.create',                     [false, false, false, false, true,  false, true,  false, false, false, true ]],
  ['pos.sale.read',                       [true,  true,  true,  false, true,  true,  true,  false, false, false, true ]],
  ['pos.void.request',                    [false, false, false, false, true,  false, true,  false, false, false, true ]],
  ['pos.void.approve',                    [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  ['pos.online_order.record',             [false, false, false, false, true,  true,  true,  false, false, false, true ]],
  ['pos.online_order.read',               [true,  true,  true,  false, true,  true,  true,  false, false, false, true ]],
  ['pos.daily_stock.read',                [true,  true,  false, true,  true,  true,  true,  false, false, true,  true ]],
  ['pos.cash_variance.read',              [true,  true,  true,  false, true,  false, false, true,  false, false, true ]],
  ['pos.cash_variance.approve',           [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  // ── HR ─────────────────────────────────────────────────────────────────────
  ['hr.attendance.check',                 [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['hr.attendance.read',                  [true,  true,  false, false, true,  false, false, true,  false, false, true ]],
  ['hr.attendance.correct',               [false, false, false, false, false, false, false, true,  false, false, true ]],
  ['hr.shift.read',                       [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['hr.shift.manage',                     [false, true,  false, false, true,  false, false, true,  false, false, true ]],
  ['hr.employee.read',                    [true,  true,  true,  false, true,  false, false, true,  false, false, true ]],
  // Your OWN employee record — name, NIK, position, join date, bank account —
  // for the `employee` interface. `hr.employee.read` above is the office's
  // "read anyone" key and stays office-only.
  ['hr.employee.read.own',                [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  // Employment contracts (kontrak kerja, W7). `read.own` is universal — your own
  // contract is the point of the `employee` interface's Kontrak tab; reading
  // anyone's is an office act, and writing one is owner/HR only.
  ['hr.contract.read.own',                [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['hr.contract.read',                    [true,  true,  true,  false, true,  false, false, true,  false, false, true ]],
  ['hr.contract.manage',                  [true,  false, false, false, false, false, false, true,  false, false, true ]],
  ['hr.employee.manage',                  [true,  true,  false, false, false, false, false, true,  false, false, true ]],
  ['hr.leave.request',                    [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['hr.leave.approve',                    [true,  true,  false, false, true,  false, false, true,  false, false, true ]],
  ['hr.leave.read',                       [true,  true,  false, false, true,  false, false, true,  false, false, true ]],
  // ── payroll ────────────────────────────────────────────────────────────────
  ['payroll.read',                        [true,  true,  true,  false, false, false, false, true,  false, false, true ]],
  ['payroll.component.manage',            [true,  false, true,  false, false, false, false, true,  false, false, true ]],
  ['payroll.run.calculate',               [false, false, false, false, false, false, false, true,  false, false, true ]],
  ['payroll.run.submit',                  [false, false, false, false, false, false, false, true,  false, false, true ]],
  ['payroll.run.approve',                 [true,  true,  true,  false, false, false, false, false, false, false, true ]],
  ['payroll.run.pay',                     [true,  false, true,  false, false, false, false, false, false, false, true ]],
  ['payroll.slip.send',                   [false, false, false, false, false, false, false, true,  false, false, true ]],
  ['payroll.slip.read.own',               [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  // The `employee` interface (W7): reading and RAISING your own kasbon. Both
  // universal — a driver with no location scope still has a self, and these
  // grant access to nothing but that self. Approving one stays office-only
  // (`payroll.loan.approve` below).
  ['payroll.loan.read.own',               [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['payroll.loan.request.own',            [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['payroll.loan.manage',                 [false, false, true,  false, false, false, false, true,  false, false, true ]],
  ['payroll.loan.approve',                [true,  true,  true,  false, false, false, false, false, false, false, true ]],
  ['payroll.statutory.read',              [true,  true,  true,  false, false, false, false, true,  false, false, true ]],
  ['payroll.statutory.config',            [false, false, true,  false, false, false, false, true,  false, false, true ]],
  ['payroll.statutory.enable',            [true,  true,  false, false, false, false, false, false, false, false, true ]],
  // ── assets (PMS) ───────────────────────────────────────────────────────────
  ['asset.read',                          [true,  true,  true,  true,  true,  true,  false, false, false, false, true ]],
  ['asset.manage',                        [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['asset.schedule.manage',               [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['asset.job.execute',                   [false, true,  false, true,  true,  true,  false, false, false, false, true ]],
  ['asset.job.verify',                    [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  // ── accounting / payments ──────────────────────────────────────────────────
  ['accounting.coa.read',                 [true,  true,  true,  false, false, false, false, false, false, false, true ]],
  ['accounting.coa.manage',               [true,  false, true,  false, false, false, false, false, false, false, true ]],
  ['accounting.journal.read',             [true,  true,  true,  false, false, false, false, false, false, false, true ]],
  ['accounting.journal.post',             [false, false, true,  false, false, false, false, false, false, false, true ]],
  ['accounting.journal.reverse',          [false, false, true,  false, false, false, false, false, false, false, true ]],
  ['accounting.period.close',             [true,  false, true,  false, false, false, false, false, false, false, true ]],
  ['accounting.report.read',              [true,  true,  true,  false, false, false, false, false, false, false, true ]],
  ['payment.read',                        [true,  true,  true,  false, false, false, false, false, false, false, true ]],
  ['payment.proof.upload',                [true,  true,  true,  true,  true,  true,  true,  true,  false, false, true ]],
  ['payment.verify',                      [false, false, true,  false, false, false, false, false, false, false, true ]],
  ['payment.pay',                         [true,  false, true,  false, false, false, false, false, false, false, true ]],
  ['payment.reject',                      [false, false, true,  false, false, false, false, false, false, false, true ]],
  // ── dashboard / reports ─────────────────────────────────────────────────────
  ['dashboard.view',                      [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['dashboard.outlet.view',               [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  ['report.sales.read',                   [true,  true,  true,  false, true,  false, false, false, false, false, true ]],
  ['report.logistics.read',               [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['report.hr.read',                      [true,  true,  false, false, false, false, false, true,  false, false, true ]],
  ['report.export',                       [true,  true,  true,  true,  false, false, false, true,  false, false, true ]],
  // ── devices / topology / sync ───────────────────────────────────────────────
  ['device.read',                         [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  ['device.pair',                         [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  ['device.manage',                       [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['node.read',                           [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['node.manage',                         [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['topology.read',                       [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['sync.status.read',                    [true,  true,  false, false, true,  false, false, false, false, false, true ]],
  ['sync.conflict.resolve',               [true,  true,  false, false, false, false, false, false, false, false, true ]],
  ['sync.exception.review',               [true,  false, true,  false, false, false, false, false, false, false, true ]],
  // ── kernel ─────────────────────────────────────────────────────────────────
  ['notification.read.own',               [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  // Two-way WhatsApp chat (W7). `chat.read.own` is universal — it is the staff
  // member's own thread with head office, and a driver or kasir with no
  // location scope must still be able to open it. The INBOX keys are not:
  // reading and replying to every conversation is a head-office/outlet-manager
  // job, and a kasir must not be able to read a supplier negotiation.
  ['chat.read.own',                       [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
  ['chat.read',                           [true,  true,  true,  true,  true,  false, false, true,  false, false, true ]],
  ['chat.send',                           [true,  true,  true,  true,  true,  false, false, true,  false, false, true ]],
  ['chat.manage',                         [true,  true,  false, true,  false, false, false, false, false, false, true ]],
  ['attachment.upload',                   [true,  true,  true,  true,  true,  true,  true,  true,  true,  true,  true ]],
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
export const RBAC_MATRIX: Readonly<Record<PermissionKey, Readonly<Record<RoleKey, boolean>>>> =
  Object.fromEntries(
    PERMISSION_ROWS.map(([key, flags]) => [
      key,
      Object.fromEntries(RBAC_ROLE_ORDER.map((role, i) => [role, flags[i]])) as Record<
        RoleKey,
        boolean
      >,
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
