-- Migration: 013_suppliers
-- Block: 010-019 (master data)
-- Description: suppliers (FR-SUP-01..06). Amendment 3 (D-20): suppliers grows
--              an outlet_visible flag — Supervisor/Leader may read the row
--              (name/contact directory projection only, PRD 8.6.1 nama
--              supplier/toko); price and termin stay stripped at the API
--              layer per FR-SUP-06. supplier_items / supplier_price_history
--              stay fully hidden from outlet roles (RLS in file 014).
-- Created at: 2026-08-16

BEGIN;

CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  phone VARCHAR(30),
  email VARCHAR(255),
  address TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0, -- termin (FR-SUP-01) — HIDDEN from outlet roles (Amendment 3)
  bank_name VARCHAR(100),
  bank_account VARCHAR(100),
  bank_account_name VARCHAR(255),                -- hidden from outlet roles
  outlet_visible BOOLEAN NOT NULL DEFAULT false, -- Amendment 3: outlet roles (SPV/LDR) may read the NAME/CONTACT
                                                  -- projection of flagged suppliers (PRD 8.6.1 nama supplier/toko)
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE supplier_items (                    -- FR-SUP-03: what we usually buy from whom
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  supplier_sku VARCHAR(50),
  current_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  lead_time_days INTEGER NOT NULL DEFAULT 1,
  is_preferred BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (supplier_id, item_id)
);

CREATE TRIGGER set_updated_at BEFORE UPDATE ON supplier_items
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE supplier_price_history (            -- FR-SUP-04 (append-only)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  supplier_id UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  price NUMERIC(18,2) NOT NULL,
  effective_date DATE NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','po')),
  recorded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMIT;
