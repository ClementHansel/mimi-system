-- =============================================================================
-- W7 chat permission keys.
--
-- `permissions` / `role_permissions` are seeded once in 009 from a literal
-- matrix; the authoritative matrix is `packages/shared/src/rbac.ts`, and these
-- rows are the offline-display cache that has to be kept in step by hand for
-- keys added after 009.
--
-- `chat.read.own` goes to EVERY role including driver and kasir: it is the
-- staff member's own thread with head office, and someone with no location
-- scope must still be able to open it. The inbox keys deliberately do not —
-- reading every conversation is a head-office/manager job, and a kasir must
-- not be able to read a supplier negotiation.
-- =============================================================================

BEGIN;

INSERT INTO permissions (key) VALUES
  ('chat.read.own'),
  ('chat.read'),
  ('chat.send'),
  ('chat.manage')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'chat.read.own'
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key IN ('chat.read', 'chat.send')
   AND r.key IN ('owner', 'manager', 'finance', 'kepala_gudang', 'supervisor', 'hr_admin', 'superadmin')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'chat.manage'
   AND r.key IN ('owner', 'manager', 'kepala_gudang', 'superadmin')
ON CONFLICT DO NOTHING;

COMMIT;
