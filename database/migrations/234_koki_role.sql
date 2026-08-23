-- =============================================================================
-- A role for the cooks (`koki`, "Juru Masak") — owner request 2026-08-23.
--
-- An outlet shift is a supervisor, a cashier and TWO COOKS, and the cooks had no
-- role of their own. `database/simulate-org.ts` had to create them as
-- `leader_outlet`, which handed every one of the 120 cooks
-- `purchasing.po.receive`, `pettycash.create`, `opname.submit`,
-- `replenishment.submit` and `return.ship`: a kitchen hand who could receive a
-- supplier delivery and sign off a stock count.
--
-- The authoritative matrix is `packages/shared/src/rbac.ts` — `PermissionsGuard`
-- calls `can()` against it, never this table. These rows are the offline-display
-- cache kept in step by hand (same note as 226 and 233), so the two must be
-- edited together or the UI will describe permissions the server does not
-- enforce. The 21 keys below are exactly rbac.ts's `KOK` column.
--
-- NO RLS CHANGE IS REQUIRED, which is the part worth recording because it was
-- the reason this looked expensive. Location-scoped tables gate on
-- `app_has_location(location_id)` and personal ones on `app_is_self(...)`;
-- neither cares how many roles exist. Only `drivers_select` and
-- `suppliers_select` name `leader_outlet` literally, and a cook needs neither —
-- so a cook sees their own outlet's stock and their own HR records, and nothing
-- else, with no new policy.
--
-- Where the line is drawn: your own record, plus the kitchen floor, and no
-- document workflow. Attendance, own contract/payslip/loan/leave, own chat
-- thread; read the menu and the stock, move stock between storage areas
-- (thawing is the cook's job), record spoilage. No till, no count submission,
-- no goods receipt, no petty cash.
-- =============================================================================

BEGIN;

INSERT INTO roles (key, name)
VALUES ('koki', 'Juru Masak')
ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name;

-- Idempotent, and scoped to `koki` only: a re-run must not silently widen or
-- narrow any other role.
DELETE FROM role_permissions
 WHERE role_id = (SELECT id FROM roles WHERE key = 'koki');

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.key = 'koki'
   AND p.key IN (
     -- every employee, for their own record
     'auth.pin.set',
     'attachment.upload',
     'chat.read.own',
     'hr.attendance.check',
     'hr.contract.read.own',
     'hr.employee.read.own',
     'hr.leave.request',
     'hr.shift.read',
     'notification.read.own',
     'payroll.loan.read.own',
     'payroll.loan.request.own',
     'payroll.slip.read.own',
     -- the kitchen floor
     'location.read',
     'item.read',
     'product.read',
     'inventory.balance.read',
     'inventory.movement.read',
     'inventory.area_transfer.create',
     'pos.daily_stock.read',
     'waste.create',
     'waste.read'
   )
ON CONFLICT DO NOTHING;

-- Fail loudly rather than ship a half-populated cache: a typo in the list above
-- would otherwise be a role quietly missing a permission, discovered by a cook
-- who cannot clock in.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n
    FROM role_permissions rp
    JOIN roles r ON r.id = rp.role_id
   WHERE r.key = 'koki';
  IF n <> 21 THEN
    RAISE EXCEPTION 'koki should hold 21 permissions, got % — a key in 234 does not exist in `permissions`', n;
  END IF;
END $$;

COMMIT;
