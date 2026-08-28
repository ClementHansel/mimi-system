-- Migration: 255_doc_voucher_permissions
-- Block: 250-259 (document designers + vouchers)
-- Description: seeds the six document-designer / voucher permission keys into
--              `permissions` + `role_permissions`.
-- Created at: 2026-08-27
--
-- `permissions` / `role_permissions` are seeded once in 009 from a literal
-- matrix; the AUTHORITATIVE matrix is `packages/shared/src/rbac.ts`, and these
-- rows are the offline-display cache that has to be kept in step by hand for
-- keys added after 009 (see 226's header — same job, same shape). The rows
-- below are transcribed from the six lines rbac.ts adds under its
-- "document designers + vouchers (2026-08-27)" heading; the role lists here
-- and the `true` columns there must match exactly, and
-- `doc-voucher.rbac.spec.ts` asserts the RUNTIME guard against `RBAC_MATRIX`
-- so a drift between this file and rbac.ts cannot ship as a working-but-wrong
-- permission.
--
-- `doc_template.read` GOES TO EVERY ROLE, deliberately, and this is the one
-- row worth explaining twice. A kasir does not hold `settings.read`, but the
-- till must fetch the receipt LAYOUT to print a nota, and a driver must fetch
-- the Surat Jalan layout on a tablet. A layout discloses nothing: it is
-- boxes, coordinates and field TOKENS — never a customer, a price or a
-- quantity. The data that fills those tokens comes from a separate,
-- permission-checked resolver (`GET /api/documents/**`, gated on
-- `pos.sale.read` / `purchasing.read` / `delivery.read` / `voucher.read`),
-- and that path is RLS-scoped on top. Gating the layout behind
-- `settings.read` would have meant either widening that key to the whole
-- outlet floor or shipping a POS that cannot print.
--
-- `voucher.issue` IS THE NARROW ONE. Minting a print run of coupons is
-- minting money, so it stops at owner / manager / finance even though
-- `voucher.redeem` (taking a coupon at the till, which IS the cashier's job)
-- reaches supervisor and kasir. `voucher.read` sits between them: it lists a
-- batch's unspent CODES, which is a list of live coupon numbers, so it
-- reaches the outlet floor (a supervisor and a kasir need to look one up) but
-- not the warehouse, HR, drivers or cooks, none of whom ever handle one.
--
-- `leader_outlet` is RETIRED (migration 237) and holds none of the five
-- non-universal keys; it is not named below. It DOES pick up
-- `doc_template.read` from the CROSS JOIN, which is correct and harmless —
-- the role has no holders, and the universal row is meant to be universal.

BEGIN;

INSERT INTO permissions (key) VALUES
  ('doc_template.read'),
  ('doc_template.manage'),
  ('voucher.read'),
  ('voucher.manage'),
  ('voucher.issue'),
  ('voucher.redeem')
ON CONFLICT (key) DO NOTHING;

-- Universal — every role, present and future. CROSS JOIN with no role filter,
-- exactly as 226 seeds `chat.read.own`.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'doc_template.read'
ON CONFLICT DO NOTHING;

-- Redrawing company stationery: owner/manager only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'doc_template.manage'
   AND r.key IN ('owner', 'manager', 'superadmin')
ON CONFLICT DO NOTHING;

-- Reading batches and the codes inside them — head office plus the outlet
-- floor that has to look a coupon up.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'voucher.read'
   AND r.key IN ('owner', 'manager', 'finance', 'supervisor', 'kasir', 'superadmin')
ON CONFLICT DO NOTHING;

-- Authoring, editing and closing a batch; voiding a single coupon.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key IN ('voucher.manage', 'voucher.issue')
   AND r.key IN ('owner', 'manager', 'finance', 'superadmin')
ON CONFLICT DO NOTHING;

-- Taking a coupon at the till.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'voucher.redeem'
   AND r.key IN ('owner', 'manager', 'supervisor', 'kasir', 'superadmin')
ON CONFLICT DO NOTHING;

COMMIT;
