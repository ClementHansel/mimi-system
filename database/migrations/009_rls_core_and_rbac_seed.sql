-- Migration: 009_rls_core_and_rbac_seed
-- Block: 001-009 (core)
-- Description: the app_user role (D-06), RLS enablement + policies for every
--              table created in blocks 001-009, indexes for this block, and
--              the RBAC seed data (9 roles x 131 permission keys, CONTRACTS.md
--              §3 — becomes packages/shared/rbac.ts verbatim on the FE/BE
--              side; this migration is the source of truth in the DB).
-- Created at: 2026-08-16

BEGIN;

-- =============================================================================
-- APP ROLE (D-06) — the backend connects as its pool login role, then issues
-- SET ROLE app_user per request (RlsContextGuard) after setting the session
-- vars below. app_user itself is NOLOGIN: it can only be assumed via SET ROLE
-- by a role granted membership (done here for whichever role is running this
-- migration, i.e. the app's DB login role in every environment).
-- =============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user NOLOGIN;
  END IF;
END $$;

GRANT app_user TO CURRENT_USER;

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO app_user;

-- =============================================================================
-- RLS — locations: ALL read; writes ROLE(owner,manager)
-- =============================================================================

ALTER TABLE locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE locations FORCE ROW LEVEL SECURITY;

CREATE POLICY locations_select ON locations FOR SELECT USING (true);
CREATE POLICY locations_insert ON locations FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager'));
CREATE POLICY locations_update ON locations FOR UPDATE
  USING (current_setting('app.role', true) IN ('owner','manager'));
CREATE POLICY locations_delete ON locations FOR DELETE
  USING (current_setting('app.role', true) IN ('owner','manager'));

-- =============================================================================
-- RLS — storage_areas: LOC (D-15; central roles see every location)
-- =============================================================================

ALTER TABLE storage_areas ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage_areas FORCE ROW LEVEL SECURITY;

CREATE POLICY storage_areas_loc ON storage_areas FOR ALL
  USING (app_has_location(location_id))
  WITH CHECK (app_has_location(location_id));

-- =============================================================================
-- RLS — users / user_locations: ROLE(owner,manager,hr_admin,finance) read;
-- self-read own row; writes ROLE(owner,manager)
-- =============================================================================

ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;

CREATE POLICY users_select ON users FOR SELECT
  USING (
    current_setting('app.role', true) IN ('owner','manager','hr_admin','finance')
    OR app_is_self(id)
  );
CREATE POLICY users_insert ON users FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager'));
CREATE POLICY users_update ON users FOR UPDATE
  USING (
    current_setting('app.role', true) IN ('owner','manager')
    OR app_is_self(id)
  );
CREATE POLICY users_delete ON users FOR DELETE
  USING (current_setting('app.role', true) IN ('owner','manager'));

ALTER TABLE user_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_locations FORCE ROW LEVEL SECURITY;

CREATE POLICY user_locations_select ON user_locations FOR SELECT
  USING (
    current_setting('app.role', true) IN ('owner','manager','hr_admin','finance')
    OR app_is_self(user_id)
  );
CREATE POLICY user_locations_insert ON user_locations FOR INSERT
  WITH CHECK (current_setting('app.role', true) IN ('owner','manager'));
CREATE POLICY user_locations_delete ON user_locations FOR DELETE
  USING (current_setting('app.role', true) IN ('owner','manager'));

-- =============================================================================
-- RLS — sessions: SELF
-- =============================================================================

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

CREATE POLICY sessions_self ON sessions FOR ALL
  USING (app_is_self(user_id))
  WITH CHECK (app_is_self(user_id));

-- =============================================================================
-- RLS — audit_log: read ROLE(owner,manager,finance); INSERT via app role only
-- (any authenticated session may append its own audit rows); NO update/delete
-- policy defined AND the privileges are explicitly revoked (D-09: immutable).
-- =============================================================================

ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (current_setting('app.role', true) IN ('owner','manager','finance'));
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (true);

REVOKE UPDATE, DELETE ON audit_log FROM app_user;

-- =============================================================================
-- RLS — notifications: SELF
-- =============================================================================

ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications FORCE ROW LEVEL SECURITY;

CREATE POLICY notifications_self ON notifications FOR ALL
  USING (app_is_self(user_id))
  WITH CHECK (app_is_self(user_id));

-- =============================================================================
-- NO RLS (§1.14 "NONE" group; master/kernel config, API-guarded only):
-- roles, permissions, role_permissions, settings, document_counters,
-- attachments, notification_outbox, approval_chain_steps, approvals,
-- approval_steps. Table grants above already cover app_user access.
-- =============================================================================

-- =============================================================================
-- INDEXES — block 001-009
-- =============================================================================

CREATE INDEX idx_storage_areas_location ON storage_areas(location_id);
CREATE INDEX idx_users_role ON users(role_id);
CREATE INDEX idx_user_locations_location ON user_locations(location_id);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_device ON sessions(device_id);
CREATE INDEX idx_audit_log_user ON audit_log(user_id);
CREATE INDEX idx_audit_log_location ON audit_log(location_id);
CREATE INDEX idx_audit_log_entity ON audit_log(entity_type, entity_id);
CREATE INDEX idx_audit_log_created_at ON audit_log(created_at DESC);
CREATE INDEX idx_attachments_entity ON attachments(entity_type, entity_id);
CREATE INDEX idx_attachments_location ON attachments(location_id);
CREATE INDEX idx_notifications_user_unread ON notifications(user_id, read_at) WHERE read_at IS NULL;
CREATE INDEX idx_notification_outbox_status ON notification_outbox(status);
CREATE INDEX idx_approvals_document ON approvals(document_type, document_id);
CREATE INDEX idx_approvals_state ON approvals(state);
CREATE INDEX idx_approvals_location ON approvals(location_id);
CREATE INDEX idx_approval_steps_approval ON approval_steps(approval_id);

-- =============================================================================
-- SEED — roles (9 role keys, CONTRACTS.md §2.1 RoleKey / §3)
-- =============================================================================

INSERT INTO roles (key, name) VALUES
  ('owner',          'Owner'),
  ('manager',        'Manager'),
  ('finance',        'Finance'),
  ('kepala_gudang',  'Kepala Gudang'),
  ('supervisor',     'Supervisor Cabang'),
  ('leader_outlet',  'Leader/Staff Outlet'),
  ('kasir',          'Kasir'),
  ('hr_admin',       'HR Admin'),
  ('driver',         'Driver')
ON CONFLICT (key) DO NOTHING;

-- =============================================================================
-- SEED — permissions + role_permissions (CONTRACTS.md §3, 131 keys)
-- Staged via a temp mapping table: key -> array of role keys granted access.
-- =============================================================================

CREATE TEMP TABLE rbac_matrix (key VARCHAR(100) PRIMARY KEY, roles VARCHAR(30)[]) ON COMMIT DROP;

INSERT INTO rbac_matrix (key, roles) VALUES
  -- auth / users / admin
  ('auth.pin.set', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']),
  ('auth.offline_credential.mint', ARRAY['owner','manager','supervisor']),
  ('user.read', ARRAY['owner','manager','finance','hr_admin']),
  ('user.create', ARRAY['owner','manager']),
  ('user.update', ARRAY['owner','manager']),
  ('user.deactivate', ARRAY['owner','manager']),
  ('user.role.assign', ARRAY['owner','manager']),
  ('user.location.assign', ARRAY['owner','manager']),
  ('user.password.reset', ARRAY['owner','manager']),
  ('audit.read', ARRAY['owner','manager','finance']),
  ('settings.read', ARRAY['owner','manager','finance','kepala_gudang','hr_admin']),
  ('settings.manage', ARRAY['owner','manager']),
  ('settings.approval_chain.manage', ARRAY['owner']),
  -- location / master data
  ('location.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']),
  ('location.manage', ARRAY['owner','manager']),
  ('storage_area.manage', ARRAY['owner','manager']),
  ('item.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet']),
  ('item.manage', ARRAY['owner','manager','kepala_gudang']),
  ('unit.manage', ARRAY['owner','manager']),
  ('product.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir']),
  ('product.manage', ARRAY['owner','manager']),
  ('recipe.read', ARRAY['owner','manager','finance','kepala_gudang']),
  ('recipe.manage', ARRAY['owner','manager']),
  -- supplier (FR-SUP-06 role lock)
  ('supplier.read', ARRAY['owner','manager','finance','kepala_gudang']),
  ('supplier.directory.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet']),
  ('supplier.manage', ARRAY['owner','manager','kepala_gudang']),
  ('supplier.price.read', ARRAY['owner','manager','finance','kepala_gudang']),
  ('supplier.price.manage', ARRAY['owner','manager','kepala_gudang']),
  -- inventory
  ('inventory.balance.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir']),
  ('inventory.movement.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet']),
  ('inventory.minstock.manage', ARRAY['owner','manager','kepala_gudang']),
  ('inventory.area_transfer.create', ARRAY['kepala_gudang','supervisor','leader_outlet']),
  ('inventory.suggestion.read', ARRAY['owner','manager','kepala_gudang','supervisor','leader_outlet']),
  -- stock opname
  ('opname.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet']),
  ('opname.create', ARRAY['kepala_gudang','supervisor','leader_outlet']),
  ('opname.submit', ARRAY['kepala_gudang','supervisor','leader_outlet']),
  ('opname.approve', ARRAY['owner','manager','kepala_gudang','supervisor']),
  -- replenishment
  ('replenishment.read', ARRAY['owner','manager','kepala_gudang','supervisor','leader_outlet']),
  ('replenishment.create', ARRAY['supervisor','leader_outlet']),
  ('replenishment.submit', ARRAY['supervisor','leader_outlet']),
  ('replenishment.approve.supervisor', ARRAY['owner','manager','supervisor']),
  ('replenishment.approve.warehouse', ARRAY['owner','manager','kepala_gudang']),
  ('replenishment.amend', ARRAY['owner','manager','kepala_gudang','supervisor']),
  -- delivery / surat jalan
  ('delivery.read', ARRAY['owner','manager','kepala_gudang','supervisor','leader_outlet','driver']),
  ('delivery.sj.create', ARRAY['kepala_gudang']),
  ('delivery.sj.dispatch', ARRAY['kepala_gudang']),
  ('delivery.sj.cancel', ARRAY['manager','kepala_gudang']),
  ('delivery.drop.execute', ARRAY['kepala_gudang','driver']),
  ('delivery.receive', ARRAY['supervisor','leader_outlet']),
  ('delivery.master.manage', ARRAY['owner','manager','kepala_gudang']),
  -- purchasing / petty cash
  ('purchasing.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor']),
  ('purchasing.pr.create', ARRAY['kepala_gudang','supervisor']),
  ('purchasing.pr.approve', ARRAY['owner','manager']),
  ('purchasing.po.create', ARRAY['manager','kepala_gudang']),
  ('purchasing.po.approve', ARRAY['owner','manager']),
  ('purchasing.po.receive', ARRAY['kepala_gudang','leader_outlet']),
  ('purchasing.po.close', ARRAY['finance']),
  ('pettycash.read', ARRAY['owner','manager','finance','supervisor','leader_outlet']),
  ('pettycash.create', ARRAY['supervisor','leader_outlet']),
  ('pettycash.verify', ARRAY['manager','finance']),
  -- waste / returns
  ('waste.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet']),
  ('waste.create', ARRAY['kepala_gudang','supervisor','leader_outlet']),
  ('waste.approve', ARRAY['owner','manager','kepala_gudang','supervisor']),
  ('return.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet']),
  ('return.create', ARRAY['kepala_gudang','supervisor','leader_outlet']),
  ('return.approve', ARRAY['owner','manager','kepala_gudang','supervisor']),
  ('return.ship', ARRAY['kepala_gudang','supervisor','leader_outlet']),
  ('return.receive', ARRAY['kepala_gudang']),
  -- POS
  ('pos.catalog.read', ARRAY['owner','manager','supervisor','leader_outlet','kasir']),
  ('pos.shift.open', ARRAY['supervisor','kasir']),
  ('pos.shift.close', ARRAY['supervisor','kasir']),
  ('pos.sale.create', ARRAY['supervisor','kasir']),
  ('pos.sale.read', ARRAY['owner','manager','finance','supervisor','leader_outlet','kasir']),
  ('pos.void.request', ARRAY['supervisor','kasir']),
  ('pos.void.approve', ARRAY['owner','manager','supervisor']),
  ('pos.online_order.record', ARRAY['supervisor','leader_outlet','kasir']),
  ('pos.online_order.read', ARRAY['owner','manager','finance','supervisor','leader_outlet','kasir']),
  ('pos.daily_stock.read', ARRAY['owner','manager','kepala_gudang','supervisor','leader_outlet','kasir']),
  ('pos.cash_variance.read', ARRAY['owner','manager','finance','supervisor','hr_admin']),
  ('pos.cash_variance.approve', ARRAY['owner','manager','supervisor']),
  -- HR
  ('hr.attendance.check', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']),
  ('hr.attendance.read', ARRAY['owner','manager','supervisor','hr_admin']),
  ('hr.attendance.correct', ARRAY['hr_admin']),
  ('hr.shift.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']),
  ('hr.shift.manage', ARRAY['manager','supervisor','hr_admin']),
  ('hr.employee.read', ARRAY['owner','manager','finance','supervisor','hr_admin']),
  ('hr.employee.manage', ARRAY['owner','manager','hr_admin']),
  ('hr.leave.request', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']),
  ('hr.leave.approve', ARRAY['owner','manager','supervisor','hr_admin']),
  ('hr.leave.read', ARRAY['owner','manager','supervisor','hr_admin']),
  -- payroll
  ('payroll.read', ARRAY['owner','manager','finance','hr_admin']),
  ('payroll.component.manage', ARRAY['owner','finance','hr_admin']),
  ('payroll.run.calculate', ARRAY['hr_admin']),
  ('payroll.run.submit', ARRAY['hr_admin']),
  ('payroll.run.approve', ARRAY['owner','manager','finance']),
  ('payroll.run.pay', ARRAY['owner','finance']),
  ('payroll.slip.send', ARRAY['hr_admin']),
  ('payroll.slip.read.own', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']),
  ('payroll.loan.manage', ARRAY['finance','hr_admin']),
  ('payroll.loan.approve', ARRAY['owner','manager','finance']),
  ('payroll.statutory.read', ARRAY['owner','manager','finance','hr_admin']),
  ('payroll.statutory.config', ARRAY['finance','hr_admin']),
  ('payroll.statutory.enable', ARRAY['owner','manager']),
  -- assets (PMS)
  ('asset.read', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet']),
  ('asset.manage', ARRAY['owner','manager']),
  ('asset.schedule.manage', ARRAY['owner','manager']),
  ('asset.job.execute', ARRAY['manager','kepala_gudang','supervisor','leader_outlet']),
  ('asset.job.verify', ARRAY['owner','manager','supervisor']),
  -- accounting / payments
  ('accounting.coa.read', ARRAY['owner','manager','finance']),
  ('accounting.coa.manage', ARRAY['owner','finance']),
  ('accounting.journal.read', ARRAY['owner','manager','finance']),
  ('accounting.journal.post', ARRAY['finance']),
  ('accounting.journal.reverse', ARRAY['finance']),
  ('accounting.period.close', ARRAY['owner','finance']),
  ('accounting.report.read', ARRAY['owner','manager','finance']),
  ('payment.read', ARRAY['owner','manager','finance']),
  ('payment.proof.upload', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin']),
  ('payment.verify', ARRAY['finance']),
  ('payment.pay', ARRAY['owner','finance']),
  ('payment.reject', ARRAY['finance']),
  -- dashboard / reports
  ('dashboard.view', ARRAY['owner','manager']),
  ('dashboard.outlet.view', ARRAY['owner','manager','supervisor']),
  ('report.sales.read', ARRAY['owner','manager','finance','supervisor']),
  ('report.logistics.read', ARRAY['owner','manager','kepala_gudang']),
  ('report.hr.read', ARRAY['owner','manager','hr_admin']),
  ('report.export', ARRAY['owner','manager','finance','kepala_gudang','hr_admin']),
  -- devices / topology / sync
  ('device.read', ARRAY['owner','manager','supervisor']),
  ('device.pair', ARRAY['owner','manager','supervisor']),
  ('device.manage', ARRAY['owner','manager']),
  ('node.read', ARRAY['owner','manager']),
  ('node.manage', ARRAY['owner','manager']),
  ('topology.read', ARRAY['owner','manager']),
  ('sync.status.read', ARRAY['owner','manager','supervisor']),
  ('sync.conflict.resolve', ARRAY['owner','manager']),
  ('sync.exception.review', ARRAY['owner','finance']),
  -- kernel
  ('notification.read.own', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']),
  ('attachment.upload', ARRAY['owner','manager','finance','kepala_gudang','supervisor','leader_outlet','kasir','hr_admin','driver']);

INSERT INTO permissions (key)
  SELECT key FROM rbac_matrix
  ON CONFLICT (key) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id
  FROM rbac_matrix m
  JOIN permissions p ON p.key = m.key
  CROSS JOIN LATERAL unnest(m.roles) AS role_key
  JOIN roles r ON r.key = role_key
  ON CONFLICT DO NOTHING;

COMMIT;
