-- Migration: 003_identity_rbac
-- Block: 001-009 (core)
-- Description: roles, permissions, role_permissions, users, user_locations,
--              sessions. device_id / node columns referenced by later blocks
--              are added here as nullable UUID with no FK yet (FK added in
--              block 110-119 once devices/branch_nodes exist).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE roles (            -- seeded with the 9 role keys of CONTRACTS.md §3; not user-creatable in v1
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(30) UNIQUE NOT NULL,               -- 'owner'..'driver'
  name VARCHAR(100) NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (      -- seeded verbatim from CONTRACTS.md §3 permission keys
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) UNIQUE NOT NULL,              -- 'module.action'
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions ( -- seeded verbatim from CONTRACTS.md §3 matrix
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,          -- login id; unique per staf (FR-POS-02)
  email VARCHAR(255) UNIQUE,                     -- nullable: kasir may have no email
  phone VARCHAR(30),                             -- WA target for slips/alerts
  password_hash VARCHAR(255) NOT NULL,
  pin_hash VARCHAR(255),                         -- 6-digit PIN: POS supervisor override + offline credential (D-17)
  name VARCHAR(255) NOT NULL,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,  -- exactly one role per user (v1, Appendix A-11)
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE user_locations (   -- location grants for scoped roles (kepala_gudang, supervisor, leader_outlet, kasir, driver)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) NOT NULL,
  device_id UUID,                                -- FK added in block 110 (fk_sessions_device)
  ip_address INET,
  user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
