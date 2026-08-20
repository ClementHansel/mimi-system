-- =============================================================================
-- Owner gains the delivery + purchasing CREATE rights (follow-up to 222).
--
-- Migration 222 gave owner five create rights under the owner's standing
-- decision ("owner sees and does everything, accepting the segregation-of-
-- duties break"). It missed these eight, with a visible consequence: logged in
-- as owner there was no "buat surat jalan" button on the dispatcher screen and
-- no "add PO" button in purchasing, because both are rendered behind a
-- PermissionGate. The features were built and wired all along — they were
-- simply invisible to the one account the owner actually uses.
--
-- SEGREGATION OF DUTIES, STATED PLAINLY: owner already held
-- `purchasing.po.approve` and `purchasing.pr.approve`. Adding
-- `purchasing.po.create` means one account can now raise AND approve the same
-- purchase order. That is a real control weakness and it is accepted
-- deliberately, not overlooked — a two-person rule is meaningless in a company
-- where the owner is one of the two people. Every action is still audited, so
-- the trail survives even though the gate does not.
--
-- `role_permissions` here is the offline-display cache only; the authoritative
-- matrix is `packages/shared/src/rbac.ts`, updated in the same commit.
-- =============================================================================

BEGIN;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE r.key = 'owner'
   AND p.key IN (
     'delivery.sj.create',
     'delivery.sj.dispatch',
     'delivery.sj.cancel',
     'delivery.receive',
     'purchasing.pr.create',
     'purchasing.po.create',
     'purchasing.po.receive',
     'purchasing.po.close'
   )
ON CONFLICT DO NOTHING;

COMMIT;
