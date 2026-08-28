-- =============================================================================
-- Supervisor gains `report.export`.
--
-- `permissions` / `role_permissions` are seeded once in 009 from a literal
-- matrix; the authoritative matrix is `packages/shared/src/rbac.ts`, and these
-- rows are the offline-display cache that has to be kept in step by hand
-- (same rationale as 226, 233, 234, 250).
--
-- WHY: the dashboard gained Penjualan (sales) and Pemasaran (marketing) report
-- tabs (CONTRACTS §4.18's note pointing at §4.19). A Supervisor's entire
-- dashboard IS one outlet, and they have always held `report.sales.read` — they
-- could read their own outlet's figures on screen but not download them, so the
-- export buttons would have had to be hidden from the one role whose daily job
-- those tabs exist for. The reports render client-side from `format=json` data
-- the role is already entitled to, so withholding the button withheld a FILE
-- FORMAT, not data.
--
-- WHAT THIS DOES NOT DO: widen reach. `report.export` is checked per-request by
-- `assertExportPermission` and gates `?format=` only;
-- `assertLocationInScope`/`scopeClause` still confine every row a Supervisor
-- can read or export to their own `user_locations`, and RLS is unchanged. No
-- policy, role, or grant is touched here — this is one cache row.
--
-- `report.export` already exists in `permissions` (seeded in 009), so only the
-- role_permissions link is inserted; the permissions INSERT is kept as a
-- belt-and-braces no-op for environments seeded out of order.
-- =============================================================================

BEGIN;

INSERT INTO permissions (key) VALUES ('report.export')
ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  CROSS JOIN permissions p
 WHERE p.key = 'report.export'
   AND r.key = 'supervisor'
ON CONFLICT DO NOTHING;

COMMIT;
