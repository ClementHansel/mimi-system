-- Migration: 220_dbpvrls_payment_verifications_fulfilment_select
-- Fix block: 2xx. Ticket DB-PV-RLS.
--
-- THE BUG: migration 095's `payment_verifications_role` is `FOR ALL USING
-- (role IN owner,manager,finance)` with no SELECT carve-out. `kepala_gudang`
-- (KGD) is the role that actually performs `purchasing.po.receive`
-- (`PurchaseOrderService.receive`), and receiving a PO calls
-- `PaymentVerificationsService.createSystemVerification` to insert the PO's
-- `payment_verifications` row — an INSERT that only succeeds because it
-- escalates around itself (`assertSystemContext`, see that service's own
-- "CARRIED ITEM #3" doc comment for the identical gap on the WITH CHECK
-- side). Once back on KGD's own session, `PurchaseOrderRepository`'s
-- `LEFT JOIN payment_verifications` (CONTRACTS.md §4.11's `paymentStatus`)
-- is silently RLS-filtered: `received.paymentStatus` reads back `null` for
-- the very user who just caused the row to exist, while the same PO re-read
-- as `owner` correctly shows `'pending'`. Proven live (see this migration's
-- verification note and `payment-verifications-fulfilment.rls.spec.ts`).
--
-- THE FIX, AND WHY THIS SHAPE: the requested behaviour is fulfilment roles
-- may SELECT the payment-verification rows attached to POs within their
-- scope; create/update/verify/pay stay owner/manager/finance-only — this is
-- a genuine segregation-of-duties boundary (Finance verifies payments) that
-- widening `FOR ALL` would destroy.
--
--   * Reuses `app_is_fulfilment_role()` (209) rather than inventing a new
--     helper — this is exactly the "next table that needs the same
--     treatment" case that function's own doc comment anticipated.
--   * A NEW, COMMAND-SCOPED `FOR SELECT` policy, not a change to 095's
--     `FOR ALL` policy. Postgres combines multiple PERMISSIVE policies for
--     the same command with OR, but a `FOR SELECT` policy contributes
--     NOTHING to INSERT's `WITH CHECK`, or to the row-visibility check
--     UPDATE/DELETE make via their own applicable policies — only 095's
--     original `FOR ALL` policy governs those, unchanged. Editing 095 in
--     place is also against this project's rule (README.md: applied
--     migrations are never edited) — a second reason this had to be an
--     additive policy, not a rewritten one.
--   * Scoped to `ref_type = 'purchase_order'` AND an existing purchase_order
--     the caller can already see (`app_has_location(o.location_id)`, the
--     same predicate `purchase_orders_loc_role` (044) uses for KGD). This
--     is deliberately narrower than trusting `payment_verifications.
--     location_id` directly (which happens to mirror the referenced PO's
--     `location_id` today, per `PurchaseOrderService.receive`'s
--     `createSystemVerification` call — see purchase-order.service.ts) or
--     dropping the `ref_type` filter — either shortcut would also open
--     visibility into `payroll_run`/`petty_cash`/`maintenance_job`/`thr`/
--     `incentive`-linked rows at a location KGD holds (i.e. the warehouse),
--     which is exactly the blanket-visibility mistake 209's own header
--     rejected for `app_is_central()`. KGD gets exactly what it fulfils and
--     nothing else in this table.
--
-- OVER-WIDENING PROOF (performed live, see final report for full output):
--   * `kasir` (never in scope for this table, before or after) — 0 visible
--     `payment_verifications` rows, unchanged.
--   * `kepala_gudang` — sees the PO-linked row it just caused to exist, and
--     does NOT see a `petty_cash`-linked row at its own warehouse location
--     (`ref_type` filter holding).
--   * `kepala_gudang` attempting `INSERT`/`UPDATE` against `payment_
--     verifications` is still blocked by 095's unmodified `FOR ALL` policy
--     (INSERT: RLS-violation error off `WITH CHECK`; UPDATE: 0 rows
--     affected, since the SELECT-only policy added here never contributes
--     to UPDATE's own row-visibility check).
--
-- SIBLING AUDIT (per this ticket's request — swept every other policy in
-- 095's table family for the identical "FOR ALL, no SELECT carve-out, but a
-- non-listed role writes a row via system-context escalation and later
-- reads it back under its own session" shape):
--   * `chart_of_accounts_role`, `fiscal_periods_role`, `journal_entries_
--     role`, `journal_lines_role`, `posting_rules_role` — NOT affected.
--     Every read path into these five tables (`accounting.controller.ts`'s
--     `ReportsController`/`AccountingController`, `reports.service.ts`) sits
--     behind `accounting.coa.read` / `accounting.journal.read` /
--     `accounting.report.read`, and `packages/shared/src/rbac.ts` grants all
--     three exclusively to `[owner, manager, finance]` — the identical role
--     set already in 095's `USING` clause. No other module ever joins these
--     four tables and surfaces a status field to a narrower role the way
--     `PurchaseOrderRepository` does for `payment_verifications` (grepped
--     every `journal_entries`/`chart_of_accounts`/`posting_rules`/
--     `journal_lines` reference under `apps/backend/src`; the only hits
--     outside the accounting module itself are `kernel/sync` and
--     `auth.service.ts`, both central-role/system paths). `payment_
--     verifications` is the only member of this migration's table family
--     with both an escalated-write path AND a narrower-role read-back path,
--     which is why it is the only one fixed here — reported, not changed,
--     per this ticket's explicit "report what you find" instruction for
--     this part.
--
-- Created at: 2026-08-17

BEGIN;

CREATE POLICY payment_verifications_fulfilment_select ON payment_verifications
  FOR SELECT
  USING (
    app_is_fulfilment_role()
    AND ref_type = 'purchase_order'
    AND EXISTS (
      SELECT 1 FROM purchase_orders o
      WHERE o.id = payment_verifications.ref_id
        AND app_has_location(o.location_id)
    )
  );

COMMIT;
