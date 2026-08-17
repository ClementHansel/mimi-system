# Mimi Chicken OS — CONTRACTS.md (Wave 0 output)

**Status:** Contract of record for all implementation agents. Changes only via the architect (BUILD-PLAN §6 rule 7).
**Sources:** PRD v1.0 (15 Aug 2026) + BUILD-PLAN.md §1 locked decisions D-01..D-17. Where PRD and a decision conflict, the decision wins and the conflict is noted inline.
**Companion:** `docs/SYNC-PROTOCOL.md` (three-tier sync; authored separately). This document references it but never redefines it.

## 0. Global conventions (binding for every agent)

- **Single tenant.** There is NO `tenant_id` column anywhere. The scoping dimension is `location_id` (D-05). `locations.type ∈ ('warehouse','outlet')`.
- **Stock key** is `(location_id, storage_area_id, item_id)` (D-15). `stock_balances` is written ONLY by `StockLedgerService` (D-07) and is derived, never synced (D-16).
- **Types:** `UUID PRIMARY KEY DEFAULT gen_random_uuid()`; `created_at/updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`; money `NUMERIC(18,2)`; quantity `NUMERIC(14,3)`; temperature `NUMERIC(4,1)`; settings/payloads `JSONB` (D-10).
- **Timezone:** stored `TIMESTAMPTZ` (UTC on the wire, ISO-8601), rendered `Asia/Makassar` / `id-ID` client-side (D-11). Dates as `'YYYY-MM-DD'` strings.
- **Wire precision rule:** money, quantity and temperature travel as **decimal strings** in JSON (`"125000.00"`, `"12.500"`, `"-18.0"`), never JS numbers. `packages/shared` owns parse/format/arithmetic. TS aliases used throughout §4: `type Money = string; type Qty = string; type Temp = string; type UUID = string; type ISODate = string; type ISODateTime = string;`
- **Naming:** DB `snake_case`; JSON/TS `camelCase`; enum TS keys `SCREAMING_SNAKE`, enum string values `lower_snake`.
- **Every mutating endpoint**: `@RequirePermission(<key from §3>)` + `@Audited()` + emits a sync event (BUILD-PLAN §6 rule 6).
- **Error shape** (exception filter): `{ statusCode: number; code: string; message: string; details?: unknown }` — `code` is a stable machine key (e.g. `ERR_STOCK_INSUFFICIENT`, `ERR_APPROVAL_STEP_ROLE`, `ERR_GEOFENCE_OUT_OF_RANGE`); user-facing text resolved from i18n by the frontend.
- **Pagination:** list endpoints accept `?page=1&pageSize=50` (max 200) and return `Paginated<T> = { rows: T[]; total: number; page: number; pageSize: number }`. Endpoints returning plain arrays are marked `T[]` explicitly.
- **Soft delete:** master data rows carry `is_active BOOLEAN NOT NULL DEFAULT true`; DELETE endpoints deactivate, never remove rows.
- **Document numbers:** cloud-issued via `document_counters` (format `<PREFIX>/<YYYYMM>/<seq>`, e.g. `SJ/202608/0042`, `PO/202608/0007`). Offline-born documents (sales, shifts) use device-local numbers `<locationCode>-<deviceCode>-<localSeq>` and are never renumbered on sync.
- **Photo evidence (wajib foto)** is an `attachments` row linked by `(entity_type, entity_id, kind)`; endpoints that the PRD marks photo-mandatory reject the transition if the required `kind` is missing (FR-LOG-15, FR-WST-01, petty cash, FR-HR-01, FR-PMS-04, every SJ drop).

---

## 1. Schema (migration blocks 001–129)

DDL sketches below are the contract; W1-C turns them into real migrations (adding indexes beyond those listed is W1-C's discretion; removing/renaming columns is not). Every table gets the standard `updated_at` trigger unless marked *append-only* (no updates allowed at all).

### 1.1 Block 001–009 — core: identity, RBAC, audit, kernel

```sql
-- 001: extensions + trigger fn
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- fn set_updated_at() … attached to every table with updated_at

-- 002: locations & storage areas ------------------------------------------
-- One row per gudang pusat / outlet. THE scoping dimension (D-05).
CREATE TABLE locations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) UNIQUE NOT NULL,              -- used in doc numbers, e.g. 'GDG', 'BPP01'
  name VARCHAR(255) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('warehouse','outlet')),
  city VARCHAR(100) NOT NULL,                    -- 4 Kalimantan cities; topology level 2
  address TEXT,
  phone VARCHAR(30),
  latitude NUMERIC(9,6), longitude NUMERIC(9,6), -- geofence centre (FR-HR-01)
  geofence_radius_m INTEGER NOT NULL DEFAULT 100,
  timezone VARCHAR(50) NOT NULL DEFAULT 'Asia/Makassar',
  is_active BOOLEAN NOT NULL DEFAULT true,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Typed storage areas inside a location (D-15). Stock lives per area.
CREATE TABLE storage_areas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  code VARCHAR(20) NOT NULL,
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('freezer','chiller','dry_store','display','kitchen_line')),
  temp_min NUMERIC(4,1), temp_max NUMERIC(4,1),  -- expected range; breach alerts compare against this
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, code)
);

-- 003: identity & RBAC ------------------------------------------------------
CREATE TABLE roles (            -- seeded with the 9 role keys of §3; never user-created in v1
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(30) UNIQUE NOT NULL,               -- 'owner'..'driver' (§3)
  name VARCHAR(100) NOT NULL,
  is_system BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE permissions (      -- seeded verbatim from §3 permission keys
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(100) UNIQUE NOT NULL,              -- 'module.action'
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE role_permissions ( -- seeded verbatim from §3 matrix
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
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,  -- exactly one role per user (v1)
  is_active BOOLEAN NOT NULL DEFAULT true,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE user_locations (   -- location grants for scoped roles (kepala_gudang, supervisor, leader_outlet, kasir, driver)
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(255) NOT NULL,
  device_id UUID,                                -- FK added in block 110
  ip_address INET, user_agent TEXT,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 004: audit (append-only; written ONLY by the @Audited interceptor, D-09)
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id),
  role_key VARCHAR(30),
  location_id UUID REFERENCES locations(id),
  module VARCHAR(50) NOT NULL,                   -- 'pos', 'replenishment', …
  action VARCHAR(100) NOT NULL,                  -- permission key or verb
  entity_type VARCHAR(100) NOT NULL,
  entity_id UUID,
  before_value JSONB,                            -- FR-AUDIT-01
  after_value JSONB,                             -- FR-AUDIT-01
  reason TEXT,                                   -- FR-AUDIT-02 (mandatory on reject/amend paths)
  ip_address INET,
  device_id UUID,                                -- FK added in block 110
  offline_authorized BOOLEAN NOT NULL DEFAULT false,  -- D-17 provenance
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),     -- client time for offline-born actions
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()       -- server receive time
);

-- 005: attachments (MinIO objects; photo evidence everywhere)
CREATE TABLE attachments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket VARCHAR(50) NOT NULL DEFAULT 'mimi',
  object_key VARCHAR(500) UNIQUE NOT NULL,
  file_name VARCHAR(255) NOT NULL,
  mime_type VARCHAR(100) NOT NULL,
  size_bytes BIGINT NOT NULL,
  sha256 VARCHAR(64),
  entity_type VARCHAR(100),                      -- e.g. 'sj_drop', 'waste_record', 'attendance'
  entity_id UUID,
  kind VARCHAR(50) NOT NULL,                     -- 'receiving_photo','selfie','waste_photo','payment_proof',
                                                 -- 'service_proof','signature','petty_cash_photo','return_proof','slip_pdf','sj_pdf'
  location_id UUID REFERENCES locations(id),
  uploaded_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 006: notifications (in-app) + outbound queue (email/WA via n8n, D-03)
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,                     -- 'low_stock','approval_pending','approval_decided','cold_chain_breach',
                                                 -- 'outlet_offline','maintenance_due','payment_pending','payroll_slip','sync_exception'
  title VARCHAR(255) NOT NULL,                   -- i18n-resolved Bahasa Indonesia at render time; store key+params in payload
  body TEXT,
  payload JSONB NOT NULL DEFAULT '{}',
  location_id UUID REFERENCES locations(id),
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE notification_outbox (               -- RISK-P4: WA channel mocks into this table until credentials arrive
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel VARCHAR(20) NOT NULL CHECK (channel IN ('email','whatsapp')),
  recipient VARCHAR(255) NOT NULL,               -- email address or WA number
  template_key VARCHAR(100) NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 007: settings + document counters
CREATE TABLE settings (                          -- M20 reads/writes; namespaced keys, e.g. 'company.profile',
  key VARCHAR(100) PRIMARY KEY,                  -- 'approval.threshold.void', 'approval.threshold.po',
  value JSONB NOT NULL,                          -- 'hr.geofence_radius_m', 'hr.late_grace_minutes', 'hr.overtime_rate',
  description TEXT,                              -- 'coldchain.frozen.max_temp', 'leave.annual_quota_days'=12,
  updated_by UUID REFERENCES users(id),          -- 'leave.marriage_days'=3, 'sync.stale_thresholds', 'wa.enabled'
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE document_counters (                 -- cloud-only numbering; offline docs use device-local numbers (§0)
  doc_type VARCHAR(30) NOT NULL,                 -- 'SJ','PO','PR','PC','OPN','RET','WST','JE','PRUN','PV','RR','GR'
  period VARCHAR(6) NOT NULL,                    -- 'YYYYMM'
  last_number INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (doc_type, period)
);

-- 008: generic approval engine (D-08) — used by all 8 approvable doc types (§5)
CREATE TABLE approval_chain_steps (              -- config: seeded from §5, editable via M20 (settings.approval_chain.manage)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(40) NOT NULL,            -- exactly the ApprovalDocumentType enum values (§2.5):
                                                 -- 'replenishment_request','void_refund','purchase_request','purchase_order',
                                                 -- 'stock_opname','return','waste','payroll_run','payment_verification',
                                                 -- 'leave_request','employee_loan','cash_variance_proposal'
  step_no INTEGER NOT NULL,
  approver_role VARCHAR(30) NOT NULL,            -- role key from §3
  min_amount NUMERIC(18,2),                      -- step applies only when doc amount ≥ min_amount (threshold escalation)
  max_amount NUMERIC(18,2),
  UNIQUE (document_type, step_no)
);

CREATE TABLE approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_type VARCHAR(40) NOT NULL,
  document_id UUID NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','cancelled')),
  current_step INTEGER NOT NULL DEFAULT 1,
  amount NUMERIC(18,2),                          -- doc value used for threshold routing (nullable)
  location_id UUID REFERENCES locations(id),
  requested_by UUID NOT NULL REFERENCES users(id),
  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_type, document_id)
);

CREATE TABLE approval_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id UUID NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  step_no INTEGER NOT NULL,
  approver_role VARCHAR(30) NOT NULL,
  state VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','approved','rejected','skipped')),
  acted_by UUID REFERENCES users(id),
  acted_at TIMESTAMPTZ,
  reason TEXT,                                   -- REQUIRED on reject/amend (FR-LOG-13, FR-SO-02); engine enforces
  offline_authorized BOOLEAN NOT NULL DEFAULT false,   -- D-17
  offline_credential_id UUID,                    -- FK added in block 120
  reverified_at TIMESTAMPTZ,
  reverification_status VARCHAR(20) CHECK (reverification_status IN ('verified','failed','unprovable')),
    -- three-valued per SYNC-PROTOCOL §7.4 (unprovable ⇒ finance exception queue, human verdict)
  UNIQUE (approval_id, step_no)
);

-- 009: RLS policies + app role (see §1.13 matrix). Session vars set per-request by RlsContextGuard:
--   app.user_id, app.role, app.location_ids (csv of UUIDs from user_locations)
-- Helper (SECURITY nothing, STABLE):
--   fn app_is_central() → current_setting('app.role') IN ('owner','manager','finance','hr_admin')
--   fn app_has_location(loc UUID) → app_is_central() OR loc = ANY(string_to_array(current_setting('app.location_ids',true),',')::uuid[])
```

### 1.2 Block 010–019 — master data: items, products/recipes, suppliers

```sql
-- 010: categories & units
CREATE TABLE item_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(100) UNIQUE NOT NULL,             -- 'Ayam Mentah','Bumbu','Sembako','Kemasan','Minuman'
  parent_id UUID REFERENCES item_categories(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE units (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(20) UNIQUE NOT NULL,              -- 'kg','gr','ltr','ml','pcs','box','pack','ekor'
  name VARCHAR(50) NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 011: items (stockable ingredients & goods; menu products are separate)
CREATE TABLE items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sku VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category_id UUID REFERENCES item_categories(id),
  base_unit_id UUID NOT NULL REFERENCES units(id),
  storage_type VARCHAR(20) NOT NULL DEFAULT 'dry' CHECK (storage_type IN ('frozen','chilled','dry')),
    -- drives frozen/dry shipment split (FR-LOG-02) and valid storage-area types
  is_sellable BOOLEAN NOT NULL DEFAULT false,    -- true = can appear on a 1:1 product (e.g. bottled drink)
  shelf_life_days INTEGER,
  temp_min NUMERIC(4,1), temp_max NUMERIC(4,1),  -- item-level cold-chain bounds (frozen chicken: -25..-15)
  avg_cost NUMERIC(18,2) NOT NULL DEFAULT 0,     -- moving average, recomputed by cloud on PO receipt; feeds GL amounts
  last_purchase_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  barcode VARCHAR(100),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE unit_conversions (                  -- item-specific overrides generic (item_id NULL = generic)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id UUID REFERENCES items(id) ON DELETE CASCADE,
  from_unit_id UUID NOT NULL REFERENCES units(id),
  to_unit_id UUID NOT NULL REFERENCES units(id),
  factor NUMERIC(14,6) NOT NULL CHECK (factor > 0),   -- qty_to = qty_from * factor
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, from_unit_id, to_unit_id)
);

-- 012: menu products + recipes (BOM) — drives FR-POS-06 usage estimate
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(50) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(100) NOT NULL DEFAULT 'Umum', -- menu category: 'Ayam','Paket','Minuman','Tambahan'
  price NUMERIC(18,2) NOT NULL,                  -- POS price, IDR
  photo_attachment_id UUID REFERENCES attachments(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recipes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID UNIQUE NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  yield_qty NUMERIC(14,3) NOT NULL DEFAULT 1,    -- portions produced per recipe execution
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE recipe_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipe_id UUID NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),    -- per 1 product unit, in unit_id below
  unit_id UUID NOT NULL REFERENCES units(id),
  UNIQUE (recipe_id, item_id)
);

-- 013: suppliers (FR-SUP-01..06; price columns role-locked at API layer + table RLS)
CREATE TABLE suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  contact_name VARCHAR(255),
  phone VARCHAR(30), email VARCHAR(255),
  address TEXT,
  payment_terms_days INTEGER NOT NULL DEFAULT 0, -- termin (FR-SUP-01) — HIDDEN from outlet roles (Amendment 3)
  bank_name VARCHAR(100), bank_account VARCHAR(100), bank_account_name VARCHAR(255), -- hidden from outlet roles
  outlet_visible BOOLEAN NOT NULL DEFAULT false, -- Amendment 3: outlet roles (SPV/LDR) may read the NAME/CONTACT
                                                 -- projection of flagged suppliers (PRD 8.6.1 nama supplier/toko)
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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
```

### 1.3 Block 020–029 — stock: balances, movements, min-stock, opname, reconciliation

```sql
-- 020: the derived balance table (D-15, D-16, D-07). NO synthetic id — the key IS the identity.
CREATE TABLE stock_balances (
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id) ON DELETE RESTRICT,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
  qty_on_hand NUMERIC(14,3) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (location_id, storage_area_id, item_id)
);
-- INVARIANT (property-tested by W2-A): qty_on_hand ≡ Σ signed stock_movements for the same key.
-- Written ONLY by StockLedgerService.post(tx, movements). Never synced between tiers (D-16).

-- 021: the movement ledger (append-only; source of truth for balances)
CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  movement_type VARCHAR(30) NOT NULL CHECK (movement_type IN (
    'opening_balance','purchase_in','transfer_in','transfer_out','usage_out',
    'waste_out','return_in','return_out','adjustment_in','adjustment_out')),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),    -- always positive; sign comes from the type (…_in / …_out)
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,    -- items.avg_cost at posting time; feeds §6 amounts
  ref_type VARCHAR(40) NOT NULL,                 -- 'sale','sj_drop','goods_receipt','po_receipt','waste_record',
                                                 -- 'return','stock_adjustment','area_transfer','seed'
  ref_id UUID,
  counterparty_location_id UUID REFERENCES locations(id),   -- transfers: the other side
  counterparty_storage_area_id UUID REFERENCES storage_areas(id), -- intra-location area moves
  actor_id UUID REFERENCES users(id),
  reason TEXT,
  sync_event_id UUID UNIQUE,                     -- idempotency: one movement set per applied sync event
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- INDEX (location_id, item_id, occurred_at DESC); (ref_type, ref_id)

-- 022: min-stock rules (FR-LOG-06, FR-LOG-17) — outlet rules AND warehouse rules in one table
CREATE TABLE min_stock_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  min_qty NUMERIC(14,3) NOT NULL CHECK (min_qty >= 0),
  reorder_qty NUMERIC(14,3),                     -- default suggested replenishment qty (FR-LOG-08/19 fallback)
  is_active BOOLEAN NOT NULL DEFAULT true,
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (location_id, item_id)
);
-- Low-stock detection (FR-LOG-07/18): balance summed across areas per (location,item) vs min_qty.

-- 023: stock opname (FR-SO-01..04); countable per storage area (D-15)
CREATE TABLE stock_opname (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opname_number VARCHAR(30) UNIQUE NOT NULL,     -- 'OPN/YYYYMM/nnnn' (cloud) or device-local
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID REFERENCES storage_areas(id),  -- NULL = whole location (lines carry area)
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','counting','submitted','approved','rejected','adjusted','cancelled')),
  counted_by UUID NOT NULL REFERENCES users(id), -- FR-SO-01: who
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), -- FR-SO-01: when
  submitted_at TIMESTAMPTZ,
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  notes TEXT,
  client_id UUID UNIQUE,                         -- offline idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stock_opname_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  opname_id UUID NOT NULL REFERENCES stock_opname(id) ON DELETE CASCADE,
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  system_qty NUMERIC(14,3) NOT NULL,             -- snapshot at submit time (FR-SO-02)
  counted_qty NUMERIC(14,3) NOT NULL,
  diff_qty NUMERIC(14,3) NOT NULL,               -- counted - system; engine recomputes, never trusts client
  variance_reason TEXT,                          -- REQUIRED when diff_qty <> 0 (FR-SO-02)
  UNIQUE (opname_id, storage_area_id, item_id)
);

-- 024: adjustments (the approved output of an opname, or manual w/ approval; FR-SO-03/04)
CREATE TABLE stock_adjustments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  adjustment_number VARCHAR(30) UNIQUE NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  qty_delta NUMERIC(14,3) NOT NULL,              -- signed; posts adjustment_in/out via ledger
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  reason TEXT NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'opname' CHECK (source IN ('opname','manual','reconciliation')),
  opname_id UUID REFERENCES stock_opname(id),
  created_by UUID NOT NULL REFERENCES users(id),
  approved_by UUID REFERENCES users(id),         -- FR-SO-04: who adjusted
  applied_at TIMESTAMPTZ,                        -- when ledger posting happened
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 025: reconciliation exceptions (D-16: divergence is an exception, never an overwrite)
CREATE TABLE stock_reconciliations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  tier VARCHAR(10) NOT NULL CHECK (tier IN ('device','node','cloud')),
  expected_qty NUMERIC(14,3) NOT NULL,           -- Σ movements (recomputed)
  stored_qty NUMERIC(14,3) NOT NULL,             -- what the balance row said
  divergence NUMERIC(14,3) NOT NULL,
  detail JSONB NOT NULL DEFAULT '{}',
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 1.4 Block 030–039 — replenishment + Surat Jalan logistics (D-14)

```sql
-- 030: replenishment requests (FR-LOG-06..13)
CREATE TABLE replenishment_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number VARCHAR(30) UNIQUE NOT NULL,    -- 'RR/YYYYMM/nnnn' or device-local
  location_id UUID NOT NULL REFERENCES locations(id),  -- requesting outlet
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN (
    'draft','submitted','awaiting_approval','approved','rejected',
    'processing','shipped','received','completed')),          -- the 9 states of FR-LOG-11
  source VARCHAR(20) NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','auto_suggestion')), -- FR-LOG-08/09
  requested_by UUID NOT NULL REFERENCES users(id),             -- FR-LOG-05: who requested
  submitted_at TIMESTAMPTZ,
  needed_by DATE,                                              -- FR-LOG-03: flexible cadence is data, not config
  approval_id UUID REFERENCES approvals(id),
  sj_id UUID,                                                  -- fulfilment link; FK added after surat_jalan below
  rejection_reason TEXT,                                       -- FR-LOG-13 (also on approval_steps.reason)
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE replenishment_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES replenishment_requests(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty_requested NUMERIC(14,3) NOT NULL CHECK (qty_requested > 0),
  qty_approved NUMERIC(14,3),                    -- set by approver; differs ⇒ amend_reason REQUIRED (FR-LOG-13)
  qty_shipped NUMERIC(14,3),
  qty_received NUMERIC(14,3),
  amend_reason TEXT,
  UNIQUE (request_id, item_id)
);
-- FR-LOG-12 history of qty changes: audit_log rows (interceptor) on every line mutation.

-- 031: drivers & vehicles
CREATE TABLE drivers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID,                              -- FK added in block 060 (employees created later)
  user_id UUID UNIQUE REFERENCES users(id),      -- login for F13 driver surface (role 'driver')
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(30),
  license_number VARCHAR(50),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plate_number VARCHAR(20) UNIQUE NOT NULL,
  type VARCHAR(30) NOT NULL DEFAULT 'van',       -- 'van','truck','pickup','motorcycle'
  brand VARCHAR(100), model VARCHAR(100),
  has_freezer BOOLEAN NOT NULL DEFAULT false,    -- cold-chain capable (FR-LOG-02)
  notes TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 032: shipment types as data (FR-LOG-02): seeded 'frozen' + 'dry'
CREATE TABLE shipment_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key VARCHAR(20) UNIQUE NOT NULL,               -- 'frozen','dry'
  name VARCHAR(50) NOT NULL,                     -- 'Frozen','Barang Kering'
  requires_temperature_log BOOLEAN NOT NULL DEFAULT false,
  requires_seal BOOLEAN NOT NULL DEFAULT false,
  temp_min NUMERIC(4,1), temp_max NUMERIC(4,1),  -- frozen seeded -25.0 .. -15.0; breach when outside
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 033: Surat Jalan (D-14). One SJ = one vehicle run; frozen and dry NEVER share an SJ (FR-LOG-02).
CREATE TABLE surat_jalan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_number VARCHAR(30) UNIQUE NOT NULL,         -- 'SJ/YYYYMM/nnnn' — cloud-issued (warehouse creates online)
  origin_location_id UUID NOT NULL REFERENCES locations(id),   -- gudang pusat
  shipment_type_id UUID NOT NULL REFERENCES shipment_types(id),
  driver_id UUID NOT NULL REFERENCES drivers(id),
  vehicle_id UUID NOT NULL REFERENCES vehicles(id),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','ready','loading','in_transit','completed','cancelled')),
  planned_date DATE NOT NULL,                    -- FR-LOG-03 flexible frequency
  dispatched_at TIMESTAMPTZ,                     -- stock leaves warehouse here (ledger transfer_out → in-transit)
  completed_at TIMESTAMPTZ,
  created_by UUID NOT NULL REFERENCES users(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE replenishment_requests
  ADD CONSTRAINT fk_rr_sj FOREIGN KEY (sj_id) REFERENCES surat_jalan(id);

-- 034: multi-drop route (D-14) — per-drop timestamps, signature, photo, discrepancy
CREATE TABLE sj_drops (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_seq INTEGER NOT NULL,                     -- route order
  location_id UUID NOT NULL REFERENCES locations(id),         -- destination outlet
  replenishment_request_id UUID REFERENCES replenishment_requests(id),
  status VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','en_route','arrived','completed','completed_discrepancy','failed')),
  departed_at TIMESTAMPTZ,                       -- FR/D-14 per-drop departure
  arrived_at TIMESTAMPTZ,                        -- per-drop arrival
  received_by UUID REFERENCES users(id),         -- outlet staff (FR-LOG-14)
  received_at TIMESTAMPTZ,
  signature_attachment_id UUID REFERENCES attachments(id),    -- receiving signature (D-14)
  discrepancy_notes TEXT,
  failure_reason TEXT,                           -- REQUIRED when status='failed'
  client_id UUID UNIQUE,                         -- driver/outlet offline idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sj_id, drop_seq)
);
-- Receiving photo (FR-LOG-15, wajib): attachments(entity_type='sj_drop', entity_id=drop.id, kind='receiving_photo') — enforced at receive.

CREATE TABLE sj_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_id UUID NOT NULL REFERENCES sj_drops(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  qty_received NUMERIC(14,3),                    -- set at receiving; NULL until then
  received_storage_area_id UUID REFERENCES storage_areas(id), -- putaway area chosen at receiving (D-15)
  discrepancy_reason TEXT,                       -- REQUIRED when qty_received <> qty
  request_line_id UUID REFERENCES replenishment_request_lines(id),
  UNIQUE (drop_id, item_id)
);
-- SJ receiving is the `sj_drops.received` sync event (SYNC-PROTOCOL §3.3 group 4): it updates sj_drops,
-- sj_lines.qty_received + received_storage_area_id, and posts transfer_in movements directly. It does NOT
-- create a goods_receipts row — goods_receipts is reserved for the flows below.

-- 035: cold chain (D-14): temperature at load and at EVERY drop; seals
CREATE TABLE sj_temperature_logs (               -- append-only
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_id UUID REFERENCES sj_drops(id) ON DELETE CASCADE,     -- NULL = measured at load (warehouse)
  stage VARCHAR(10) NOT NULL CHECK (stage IN ('load','depart','arrive')),
  temp_c NUMERIC(4,1) NOT NULL,
  is_breach BOOLEAN NOT NULL DEFAULT false,      -- computed vs shipment_types.temp_min/max at insert
  logged_by UUID REFERENCES users(id),
  logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT,
  client_id UUID UNIQUE
);
-- is_breach=true ⇒ NotificationService 'cold_chain_breach' to KGD + Manager + Owner.

CREATE TABLE sj_seals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sj_id UUID NOT NULL REFERENCES surat_jalan(id) ON DELETE CASCADE,
  drop_id UUID REFERENCES sj_drops(id) ON DELETE CASCADE,     -- NULL = applied at load
  seal_number VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'applied' CHECK (status IN
    ('applied','verified_intact','broken','replaced')),
  checked_by UUID REFERENCES users(id),
  checked_at TIMESTAMPTZ,
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 036: goods receipts — outlet-side inbound receiving OUTSIDE the SJ and PO flows
-- (SYNC-PROTOCOL §3.3 group 4): supplier-direct-to-outlet deliveries (PRD 8.6.1) and
-- blind receipts of deliveries the device has no SJ for ('unmatched_delivery', reconciled by R5/C6).
-- SJ receiving = sj_drops.received; PO receiving = po_receipts (block 040); return receiving = returns.received_at_warehouse.
CREATE TABLE goods_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number VARCHAR(30) UNIQUE NOT NULL,    -- 'GR/YYYYMM/nnnn' or device-local
  receipt_type VARCHAR(20) NOT NULL CHECK (receipt_type IN ('supplier_direct','unmatched_delivery')),
  location_id UUID NOT NULL REFERENCES locations(id),         -- receiving location
  ref_id UUID,                                   -- optional link (e.g. suspected sj_drops.id for unmatched)
  received_by UUID NOT NULL REFERENCES users(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft','confirmed')),
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE goods_receipt_lines (               -- WHERE the goods were put away (D-15)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  qty_expected NUMERIC(14,3) NOT NULL,
  qty_received NUMERIC(14,3) NOT NULL,
  discrepancy_reason TEXT,                       -- REQUIRED when qty_received <> qty_expected
  UNIQUE (receipt_id, item_id, storage_area_id)
);
-- Confirming a goods_receipt posts transfer_in (per area) via StockLedgerService (FR-LOG-16).
```

### 1.5 Block 040–049 — purchasing: PR, PO, receiving, petty cash

```sql
-- 040: purchase requests (8.6.2 "Request Pembelian")
CREATE TABLE purchase_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_number VARCHAR(30) UNIQUE NOT NULL,         -- 'PR/YYYYMM/nnnn'
  location_id UUID NOT NULL REFERENCES locations(id),   -- warehouse; or outlet for direct purchase
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','submitted','approved','rejected','converted','cancelled')),
  requested_by UUID NOT NULL REFERENCES users(id),
  needed_by DATE,
  approval_id UUID REFERENCES approvals(id),
  rejection_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE purchase_request_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pr_id UUID NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  est_price NUMERIC(18,2) NOT NULL DEFAULT 0,
  suggested_supplier_id UUID REFERENCES suppliers(id),
  UNIQUE (pr_id, item_id)
);

-- 041: purchase orders (FR-PO-01..04)
CREATE TABLE purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_number VARCHAR(30) UNIQUE NOT NULL,         -- FR-PO-01
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  location_id UUID NOT NULL REFERENCES locations(id),   -- deliver-to (gudang, or outlet for direct)
  pr_id UUID REFERENCES purchase_requests(id),
  status VARCHAR(30) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','pending_approval','approved','issued','partially_received','received','closed','cancelled')),
  order_date DATE NOT NULL,
  expected_date DATE,                            -- FR-PO-02 estimasi barang datang
  payment_terms_days INTEGER NOT NULL DEFAULT 0,
  subtotal NUMERIC(18,2) NOT NULL DEFAULT 0,
  tax NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL DEFAULT 0,        -- FR-PO-01 total nilai pembelian
  approval_id UUID REFERENCES approvals(id),
  payment_verification_id UUID,                  -- FK added in block 090
  created_by UUID NOT NULL REFERENCES users(id),
  cancel_reason TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE po_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  unit_id UUID NOT NULL REFERENCES units(id),
  qty_ordered NUMERIC(14,3) NOT NULL CHECK (qty_ordered > 0),
  unit_price NUMERIC(18,2) NOT NULL,             -- FR-PO-01 harga beli; writes supplier_price_history(source='po')
  line_total NUMERIC(18,2) NOT NULL,
  qty_received NUMERIC(14,3) NOT NULL DEFAULT 0, -- FR-PO-02/03 diterima vs dipesan
  UNIQUE (po_id, item_id)
);

-- 042: PO receiving (FR-PO-02..04)
CREATE TABLE po_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number VARCHAR(30) UNIQUE NOT NULL,
  po_id UUID NOT NULL REFERENCES purchase_orders(id),
  received_by UUID NOT NULL REFERENCES users(id),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','verified')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Bukti receiving (FR-PO-04): attachments(entity_type='po_receipt', kind='receiving_photo'), required to verify.

CREATE TABLE po_receipt_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  po_receipt_id UUID NOT NULL REFERENCES po_receipts(id) ON DELETE CASCADE,
  po_line_id UUID NOT NULL REFERENCES po_lines(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id), -- putaway area (D-15)
  qty_received NUMERIC(14,3) NOT NULL CHECK (qty_received >= 0),
  condition_notes TEXT,                          -- FR-PO-03 discrepancy note
  UNIQUE (po_receipt_id, po_line_id, storage_area_id)
);
-- Verifying a po_receipt posts purchase_in via ledger, updates po_lines.qty_received,
-- items.avg_cost/last_purchase_cost, supplier_price_history, and emits GUDANG_PURCHASE (§6).

-- 043: petty cash (8.6.1)
CREATE TABLE petty_cash (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pc_number VARCHAR(30) UNIQUE NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  purchased_by UUID NOT NULL REFERENCES users(id),      -- siapa yang membeli
  purchase_date DATE NOT NULL,
  store_name VARCHAR(255) NOT NULL,              -- nama supplier/toko
  total_amount NUMERIC(18,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','rejected')),
  verified_by UUID REFERENCES users(id),         -- siapa yang verifikasi
  verified_at TIMESTAMPTZ,
  rejection_reason TEXT,
  payment_verification_id UUID,                  -- FK added in block 090 (FR-ACCT-04 petty cash)
  notes TEXT,
  client_id UUID UNIQUE,                         -- outlet offline idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Wajib foto: attachments kind='payment_proof' (bukti pembayaran) AND kind='petty_cash_photo' (foto barang), both required to verify.

CREATE TABLE petty_cash_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  petty_cash_id UUID NOT NULL REFERENCES petty_cash(id) ON DELETE CASCADE,
  description VARCHAR(255) NOT NULL,             -- barang yang dibeli
  item_id UUID REFERENCES items(id),             -- set when the purchase is stockable → posts purchase_in on verify
  storage_area_id UUID REFERENCES storage_areas(id),
  qty NUMERIC(14,3),
  amount NUMERIC(18,2) NOT NULL,
  expense_category VARCHAR(50) NOT NULL DEFAULT 'operasional'  -- posting rules map category → COA account (§6)
);
```

### 1.6 Block 050–059 — POS (offline-first origin data)

```sql
-- 050: cashier shifts (FR-POS-02). Offline-born: device-local numbers, client_id idempotency.
CREATE TABLE pos_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_number VARCHAR(40) UNIQUE NOT NULL,      -- '<locationCode>-<deviceCode>-S<localSeq>'
  location_id UUID NOT NULL REFERENCES locations(id),
  device_id UUID,                                -- FK added in block 110
  opened_by UUID NOT NULL REFERENCES users(id),  -- kasir (unique login, FR-POS-02)
  opened_at TIMESTAMPTZ NOT NULL,
  opening_cash NUMERIC(18,2) NOT NULL DEFAULT 0,
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  closing_cash_counted NUMERIC(18,2),
  expected_cash NUMERIC(18,2),                   -- opening + Σ cash sales − Σ cash refunds
  cash_variance NUMERIC(18,2),                   -- counted − expected
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  sales_count INTEGER NOT NULL DEFAULT 0,
  gross_sales NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  client_id UUID UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 051: sales + lines + payments (append-only aggregates; void is a separate document)
CREATE TABLE sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_number VARCHAR(40) UNIQUE NOT NULL,    -- device-local, printed on the nota (FR-POS-01)
  client_id UUID UNIQUE NOT NULL,                -- sync idempotency key
  location_id UUID NOT NULL REFERENCES locations(id),
  shift_id UUID NOT NULL REFERENCES pos_shifts(id),
  kasir_id UUID NOT NULL REFERENCES users(id),
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided','refunded')),
  subtotal NUMERIC(18,2) NOT NULL,
  discount NUMERIC(18,2) NOT NULL DEFAULT 0,
  total NUMERIC(18,2) NOT NULL,
  paid_amount NUMERIC(18,2) NOT NULL,
  change_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  offline_created BOOLEAN NOT NULL DEFAULT false,
  occurred_at TIMESTAMPTZ NOT NULL,              -- client clock (advisory; ordering by client_seq per SYNC-PROTOCOL)
  synced_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sale_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(18,2) NOT NULL,             -- price at sale time (products.price snapshot)
  discount NUMERIC(18,2) NOT NULL DEFAULT 0,
  line_total NUMERIC(18,2) NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);
-- Applying a sale posts usage_out per recipe explosion (kitchen_line area) via ledger → FR-POS-06 estimates.

CREATE TABLE sale_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  method VARCHAR(20) NOT NULL CHECK (method IN ('cash','qris','bank_transfer')),  -- FR-POS-04
  amount NUMERIC(18,2) NOT NULL,
  reference VARCHAR(100),
  payment_status VARCHAR(20) NOT NULL CHECK (payment_status IN ('pending','verified','paid')),
    -- cash → 'paid' at once; qris → 'verified' (settles later); bank_transfer → 'pending' until Finance verifies (NFR-09, FR-ACCT-03)
  proof_attachment_id UUID REFERENCES attachments(id),
  verified_by UUID REFERENCES users(id),
  verified_at TIMESTAMPTZ
);

-- 052: void/refund (FR-POS-03) — supervisor-authorized, offline-provisional capable (D-17)
CREATE TABLE void_refunds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sale_id UUID NOT NULL REFERENCES sales(id),
  type VARCHAR(10) NOT NULL CHECK (type IN ('void','refund')),
  amount NUMERIC(18,2) NOT NULL,
  reason TEXT NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  requested_by UUID NOT NULL REFERENCES users(id),      -- kasir
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),                -- supervisor (APR-02)
  approved_at TIMESTAMPTZ,
  offline_authorized BOOLEAN NOT NULL DEFAULT false,    -- D-17
  reverification_status VARCHAR(20) CHECK (reverification_status IN ('verified','failed','unprovable')),
  rejection_reason TEXT,
  client_id UUID UNIQUE NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Approval applied ⇒ sales.status flips, payments reversed, usage_out reversed (usage 'return_in' to kitchen_line), journal reversal (§6).

-- 053: manual GoFood/ShopeeFood records (FR-POS-05, FR-POS-07)
CREATE TABLE online_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id UUID UNIQUE NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  platform VARCHAR(20) NOT NULL CHECK (platform IN ('gofood','shopeefood')),
  order_ref VARCHAR(100) NOT NULL,               -- nomor order ID platform
  order_date DATE NOT NULL,                      -- tanggal transaksi
  gross_amount NUMERIC(18,2) NOT NULL,           -- nilai pesanan
  discount_amount NUMERIC(18,2) NOT NULL DEFAULT 0,
  platform_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  other_fee NUMERIC(18,2) NOT NULL DEFAULT 0,
  net_received NUMERIC(18,2) NOT NULL,           -- pembayaran diterima (validated: gross − discount − fees)
  status VARCHAR(20) NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','cancelled')),
  settlement_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (settlement_status IN ('pending','settled')),
  items JSONB,                                   -- optional [{productId, qty}] → enables usage posting (see Appendix A-7)
  recorded_by UUID NOT NULL REFERENCES users(id),
  shift_id UUID REFERENCES pos_shifts(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (platform, order_ref)
);

-- 054: cash variance proposals (Amendment 2 — auto-propose, human-approve; supersedes A-17)
CREATE TABLE cash_variance_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id UUID UNIQUE NOT NULL REFERENCES pos_shifts(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  kasir_user_id UUID NOT NULL REFERENCES users(id),   -- who closed short
  employee_id UUID,                              -- deduction target; FK added in block 060 (employees created later)
  amount NUMERIC(18,2) NOT NULL CHECK (amount > 0),   -- the shortfall: expected_cash − closing_cash_counted
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approval_id UUID REFERENCES approvals(id),
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,                          -- REQUIRED on BOTH approve and reject (Amendment 2, §5.9)
  payroll_line_id UUID,                          -- FK added in block 060; set when an approved run consumes it
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Auto-created (cloud, at pos_shifts.closed apply / R7) when shortfall > settings 'pos.cash_variance_propose_above'.
-- It does NOT reach payroll until approved (§5.9); approved ⇒ payroll deduction line, component
-- 'deduction_cash_variance', source_ref_type='cash_variance_proposal'. Overage (counted > expected) creates
-- no proposal — it stays an R7 finance exception. NOT eligible for offline authorization (SYNC-PROTOCOL §7.6).
```

### 1.7 Block 060–069 — HR & payroll

```sql
-- 060: employees & employment history
CREATE TABLE employees (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_number VARCHAR(30) UNIQUE NOT NULL,
  user_id UUID UNIQUE REFERENCES users(id),      -- nullable: not every employee gets a login
  name VARCHAR(255) NOT NULL,
  nik VARCHAR(30),                               -- KTP number
  phone VARCHAR(30), email VARCHAR(255),
  address TEXT,
  birth_date DATE,
  join_date DATE NOT NULL,                       -- feeds tunjangan masa kerja (PIN-05)
  employment_status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (employment_status IN
    ('active','probation','resigned','terminated')),
  position VARCHAR(100) NOT NULL,                -- feeds tunjangan jabatan (PIN-06)
  location_id UUID NOT NULL REFERENCES locations(id),  -- home location
  bank_name VARCHAR(100), bank_account_number VARCHAR(50), bank_account_name VARCHAR(255),
  photo_attachment_id UUID REFERENCES attachments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE drivers ADD CONSTRAINT fk_drivers_employee
  FOREIGN KEY (employee_id) REFERENCES employees(id);
ALTER TABLE cash_variance_proposals ADD CONSTRAINT fk_cvp_employee
  FOREIGN KEY (employee_id) REFERENCES employees(id);          -- Amendment 2 retro-FK

CREATE TABLE employments (                       -- position/salary history; current row has end_date NULL
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  position VARCHAR(100) NOT NULL,
  location_id UUID NOT NULL REFERENCES locations(id),
  base_salary NUMERIC(18,2) NOT NULL,            -- PIN-01
  start_date DATE NOT NULL,
  end_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 061: shifts & roster (FR-HR-02)
CREATE TABLE work_shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID REFERENCES locations(id),     -- NULL = global template
  name VARCHAR(50) NOT NULL,                     -- 'Pagi','Sore','Malam'
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,                        -- may wrap past midnight (end < start)
  break_minutes INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE shift_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  work_shift_id UUID REFERENCES work_shifts(id), -- NULL = day off ('libur')
  location_id UUID NOT NULL REFERENCES locations(id),
  date DATE NOT NULL,
  assigned_by UUID NOT NULL REFERENCES users(id),      -- supervisor (FR-HR-02)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

-- 062: attendance (FR-HR-01: GPS geofence 100m + selfie; FR-HR-03 inputs)
CREATE TABLE attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  location_id UUID NOT NULL REFERENCES locations(id),
  date DATE NOT NULL,
  shift_assignment_id UUID REFERENCES shift_assignments(id),
  check_in_at TIMESTAMPTZ,
  check_in_lat NUMERIC(9,6), check_in_lng NUMERIC(9,6),
  check_in_distance_m INTEGER,                   -- computed vs location geofence
  check_in_selfie_attachment_id UUID REFERENCES attachments(id),  -- wajib (FR-HR-01)
  check_in_device_id UUID,                       -- FK added in block 110
  check_out_at TIMESTAMPTZ,
  check_out_lat NUMERIC(9,6), check_out_lng NUMERIC(9,6),
  check_out_distance_m INTEGER,
  check_out_selfie_attachment_id UUID REFERENCES attachments(id),
  status VARCHAR(20) NOT NULL DEFAULT 'present' CHECK (status IN
    ('present','late','absent','sick','permission','leave','holiday','off')),
  late_minutes INTEGER NOT NULL DEFAULT 0,       -- POUT-07
  overtime_minutes INTEGER NOT NULL DEFAULT 0,   -- PIN-02 (beyond shift end; policy in settings)
  work_minutes INTEGER,
  geofence_ok BOOLEAN NOT NULL DEFAULT true,
  corrected_by UUID REFERENCES users(id),        -- HR manual correction
  correction_reason TEXT,                        -- REQUIRED when corrected (FR-AUDIT-02)
  client_id UUID UNIQUE,                         -- offline check-in idempotency
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, date)
);

-- 063: leave (F-HR-06; POUT-01/02/04; quotas in settings: annual=12, marriage=3)
CREATE TABLE leave_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id),
  type VARCHAR(20) NOT NULL CHECK (type IN ('annual','marriage','sick','permission','unpaid')),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  days NUMERIC(4,1) NOT NULL,
  reason TEXT,
  attachment_id UUID REFERENCES attachments(id), -- surat dokter etc.
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  approval_id UUID REFERENCES approvals(id),
  decided_by UUID REFERENCES users(id),
  decided_at TIMESTAMPTZ,
  rejection_reason TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 064: salary component master (PIN-01..07, POUT-01..09) + per-employee assignment
CREATE TABLE salary_components (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(40) UNIQUE NOT NULL,              -- PayrollComponentCode enum (§2)
  name VARCHAR(100) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('earning','deduction','employer_cost')),
    -- 'employer_cost' (Amendment 1): BPJS employer shares — company cost lines, never net-pay-affecting;
    -- shown as an info section on the slip, posted Dr Beban BPJS / Cr Hutang BPJS
  is_statutory BOOLEAN NOT NULL DEFAULT false,   -- Amendment 1: statutory rows compute only when payroll.statutory enabled
  calc_method VARCHAR(20) NOT NULL CHECK (calc_method IN ('fixed','per_day','per_hour','formula','manual')),
  formula_key VARCHAR(50),                       -- calculator in packages/shared: 'overtime','late_penalty',
                                                 -- 'absence','so_shortfall','loan_installment','attendance_bonus','tenure'
  default_amount NUMERIC(18,2),
  is_system BOOLEAN NOT NULL DEFAULT false,      -- seeded 16 components are system rows (non-deletable)
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE employee_salary_components (        -- per-employee amount overrides (tunjangan jabatan, insentif, dll)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  component_id UUID NOT NULL REFERENCES salary_components(id),
  amount NUMERIC(18,2),                          -- NULL = use component default/formula
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (employee_id, component_id, effective_from)
);

-- 065: loans / kasbon (POUT-06) with automatic amortization
CREATE TABLE employee_loans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_number VARCHAR(30) UNIQUE NOT NULL,
  employee_id UUID NOT NULL REFERENCES employees(id),
  principal NUMERIC(18,2) NOT NULL,
  monthly_installment NUMERIC(18,2) NOT NULL,
  outstanding NUMERIC(18,2) NOT NULL,            -- sisa pinjaman otomatis
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','active','paid_off','written_off','rejected')),
  reason TEXT,
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  disbursed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE employee_loan_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES employee_loans(id) ON DELETE CASCADE,
  payroll_line_id UUID,                          -- FK added after payroll_lines below
  amount NUMERIC(18,2) NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'payroll_deduction' CHECK (method IN ('payroll_deduction','cash')),
  paid_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  notes TEXT
);

-- 066: payroll periods, runs, lines (FR-HR-03/04)
CREATE TABLE payroll_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code VARCHAR(7) UNIQUE NOT NULL,        -- '2026-08'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'open' CHECK (status IN ('open','processing','closed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE payroll_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id UUID NOT NULL REFERENCES payroll_periods(id),
  run_seq INTEGER NOT NULL DEFAULT 1,
  run_number VARCHAR(30) UNIQUE NOT NULL,        -- 'PRUN/YYYYMM/nn'
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','calculated','pending_approval','approved','paid','cancelled')),
  statutory_mode BOOLEAN NOT NULL DEFAULT false, -- Amendment 1: mode the run EXECUTED in (snapshot of the
                                                 -- payroll.statutory flag at calculate time) — historical runs stay
                                                 -- reproducible after a later toggle; recalculate re-snapshots
  calculated_by UUID REFERENCES users(id),
  calculated_at TIMESTAMPTZ,
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  paid_at TIMESTAMPTZ,
  payment_verification_id UUID,                  -- FK added in block 090 (FR-ACCT-04 payroll)
  total_gross NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_deductions NUMERIC(18,2) NOT NULL DEFAULT 0,
  total_net NUMERIC(18,2) NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (period_id, run_seq)
);

CREATE TABLE payroll_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES payroll_runs(id) ON DELETE CASCADE,
  employee_id UUID NOT NULL REFERENCES employees(id),
  component_id UUID NOT NULL REFERENCES salary_components(id),
  qty NUMERIC(14,3),                             -- e.g. overtime hours, late minutes, absent days, SO diff qty
  rate NUMERIC(18,2),                            -- per-unit rate used
  amount NUMERIC(18,2) NOT NULL,                 -- positive; sign implied by component type
  source_ref_type VARCHAR(40),                   -- 'attendance','stock_opname','employee_loan','manual'
  source_ref_id UUID,                            -- traceability: POUT-05 links the opname, POUT-06 the loan
  manual_override BOOLEAN NOT NULL DEFAULT false,
  override_reason TEXT,                          -- REQUIRED when manual_override
  UNIQUE (run_id, employee_id, component_id)
);
ALTER TABLE employee_loan_payments ADD CONSTRAINT fk_elp_payroll_line
  FOREIGN KEY (payroll_line_id) REFERENCES payroll_lines(id);
ALTER TABLE cash_variance_proposals ADD CONSTRAINT fk_cvp_payroll_line
  FOREIGN KEY (payroll_line_id) REFERENCES payroll_lines(id);  -- Amendment 2 retro-FK
-- Slip gaji (8.3.3): generated PDF stored as attachments(kind='slip_pdf', entity_type='payroll_run', entity_id),
-- delivery via notification_outbox (email/WA) after run approved.

-- 067–068: STATUTORY PAYROLL (Amendment 1 — optional capability, gated by settings 'payroll.statutory').
-- All rate tables are EFFECTIVE-DATED (rates change annually; the client maintains them via §4.15 config
-- endpoints). Nothing here executes unless the flag is ON; the calculators live in packages/shared.

CREATE TABLE bpjs_configs (                      -- one row per programme per effective window
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  program VARCHAR(20) NOT NULL CHECK (program IN ('kesehatan','jht','jkk','jkm','jp')),
  employer_pct NUMERIC(6,3) NOT NULL,            -- % of base, e.g. kesehatan 4.000, jht 3.700, jp 2.000
  employee_pct NUMERIC(6,3) NOT NULL DEFAULT 0,  -- kesehatan 1.000, jht 2.000, jp 1.000; jkk/jkm employee = 0
  salary_floor NUMERIC(18,2),                    -- min calculation base (e.g. UMK), NULL = none
  salary_cap NUMERIC(18,2),                      -- max calculation base (kesehatan/jp caps), NULL = none
  notes TEXT,                                    -- e.g. chosen JKK risk class rationale
  effective_from DATE NOT NULL,
  effective_to DATE,                             -- NULL = current
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (program, effective_from)
);

CREATE TABLE pph21_ter_rates (                   -- TER (Tarif Efektif Rata-rata) monthly withholding brackets
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category VARCHAR(1) NOT NULL CHECK (category IN ('A','B','C')),
  bracket_min NUMERIC(18,2) NOT NULL,            -- monthly gross lower bound (inclusive)
  bracket_max NUMERIC(18,2),                     -- upper bound (exclusive); NULL = open-ended top bracket
  rate_pct NUMERIC(6,3) NOT NULL,
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (category, bracket_min, effective_from)
);

CREATE TABLE pph21_ptkp (                        -- PTKP by marital status + dependants; maps status → TER category
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ptkp_code VARCHAR(10) NOT NULL,                -- 'TK/0'..'TK/3', 'K/0'..'K/3', 'K/I/0'..'K/I/3'
  annual_amount NUMERIC(18,2) NOT NULL,          -- e.g. TK/0 = 54,000,000.00
  ter_category VARCHAR(1) NOT NULL CHECK (ter_category IN ('A','B','C')),
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (ptkp_code, effective_from)
);

CREATE TABLE pph21_article17_brackets (          -- ANNUAL progressive brackets (Art. 17 UU PPh) — the December
                                                 -- true-up schedule. Effective-dated and client-maintained like the
                                                 -- other rate tables (Amendment 1 / D-18): never hardcoded in code.
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bracket_min NUMERIC(18,2) NOT NULL,            -- annual taxable income lower bound (inclusive); first row = 0
  bracket_max NUMERIC(18,2),                     -- upper bound (exclusive); NULL = open-ended top bracket
  rate_pct NUMERIC(6,3) NOT NULL,                -- seed = the 2022 schedule: 5/15/25/30/35
  effective_from DATE NOT NULL,
  effective_to DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (bracket_min, effective_from)
);

CREATE TABLE employee_tax_profiles (             -- per-employee tax/BPJS profile (wizard step 3)
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id UUID UNIQUE NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  npwp VARCHAR(25),                              -- NULL = no NPWP (calculator applies the non-NPWP surcharge rule)
  ptkp_code VARCHAR(10) NOT NULL DEFAULT 'TK/0', -- validated against pph21_ptkp codes
  dependants_count SMALLINT NOT NULL DEFAULT 0 CHECK (dependants_count BETWEEN 0 AND 3),
  bpjs_enrollments JSONB NOT NULL DEFAULT '{}',  -- {"kesehatan":{"enrolledSince":"2026-01-01","endedAt":null},
                                                 --  "jht":{...},"jkk":{...},"jkm":{...},"jp":{...}} — absent = not enrolled
  bpjs_salary_base NUMERIC(18,2),                -- override base when it differs from employments.base_salary; NULL = use base
  updated_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Calculation notes (contract for the packages/shared calculators, W1-B):
--  * Rate row selection: the row whose [effective_from, effective_to] window contains the payroll period end date.
--  * Monthly PPh21 = TER rate (by employee's ter_category via ptkp_code) × monthly gross (statutory definition).
--  * DECEMBER RUN performs the annual true-up: Article-17 progressive tax (brackets from
--    pph21_article17_brackets, effective-dated) on annualized income minus PTKP, minus Jan–Nov TER
--    withholdings — in scope of the calculator. Maintaining the annual rate/PTKP/bracket tables
--    is the CLIENT'S operational responsibility (Amendment 1).
--  * statutory lines appear ONLY on runs with statutory_mode = true.
```

### 1.8 Block 070–079 — assets & maintenance (PMS)

```sql
-- 070: asset inventory (FR-PMS-01)
CREATE TABLE assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_number VARCHAR(30) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  category VARCHAR(20) NOT NULL CHECK (category IN
    ('machine','vehicle','equipment','electronics','furniture','other')),
  location_id UUID NOT NULL REFERENCES locations(id),
  serial_number VARCHAR(100),
  brand VARCHAR(100), model VARCHAR(100),
  purchase_date DATE,
  purchase_price NUMERIC(18,2),
  vehicle_id UUID REFERENCES vehicles(id),       -- link when the asset is a registered delivery vehicle
  condition VARCHAR(10) NOT NULL DEFAULT 'good' CHECK (condition IN ('good','fair','poor','broken')),
  status VARCHAR(20) NOT NULL DEFAULT 'active' CHECK (status IN ('active','in_maintenance','retired','lost')),
  assigned_to UUID REFERENCES employees(id),     -- PIC maintenance (data-level, not a role — Appendix A-3)
  photo_attachment_id UUID REFERENCES attachments(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 071: recurring schedules (FR-PMS-02) + reminder (FR-PMS-03)
CREATE TABLE maintenance_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  name VARCHAR(100) NOT NULL,                    -- 'Service AC', 'Ganti Oli'
  interval_type VARCHAR(10) NOT NULL CHECK (interval_type IN ('days','months')),
  interval_value INTEGER NOT NULL CHECK (interval_value > 0),   -- AC = months:3
  last_done_at DATE,
  next_due_at DATE NOT NULL,
  reminder_days_before INTEGER NOT NULL DEFAULT 7,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Daily job: schedules due within reminder window ⇒ notification 'maintenance_due' + auto-create maintenance_job(status='due').

-- 072: jobs (execution of a schedule, or corrective)
CREATE TABLE maintenance_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_number VARCHAR(30) UNIQUE NOT NULL,
  asset_id UUID NOT NULL REFERENCES assets(id),
  schedule_id UUID REFERENCES maintenance_schedules(id),
  type VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (type IN ('scheduled','corrective')),
  status VARCHAR(20) NOT NULL DEFAULT 'scheduled' CHECK (status IN
    ('scheduled','due','in_progress','done','verified','skipped')),
  due_date DATE,
  assigned_to UUID REFERENCES employees(id),
  completed_by UUID REFERENCES users(id),
  completed_at TIMESTAMPTZ,
  cost NUMERIC(18,2),
  verified_by UUID REFERENCES users(id),         -- Supervisor/Manager verifikasi (PRD 14.5)
  verified_at TIMESTAMPTZ,
  payment_verification_id UUID,                  -- FK added in block 090 (FR-ACCT-04 biaya maintenance)
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Wajib bukti servis (FR-PMS-04): attachments(kind='service_proof') required for status='done'.

-- 073: service history (FR-PMS-04 riwayat servis + kondisi per unit)
CREATE TABLE service_history (                   -- append-only
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_id UUID NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  job_id UUID REFERENCES maintenance_jobs(id),
  service_date DATE NOT NULL,
  description TEXT NOT NULL,
  vendor VARCHAR(255),
  cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  condition_after VARCHAR(10) NOT NULL CHECK (condition_after IN ('good','fair','poor','broken')),
  odometer_km INTEGER,                           -- vehicles
  recorded_by UUID NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 1.9 Block 080–089 — waste & returns

```sql
-- 080: waste (8.8; FR-WST-01..04). One row per wasted item; batch_id groups a single waste event.
CREATE TABLE waste_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  waste_number VARCHAR(30) UNIQUE NOT NULL,
  batch_id UUID NOT NULL,                        -- groups items reported together in the UI
  location_id UUID NOT NULL REFERENCES locations(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id),
  item_id UUID NOT NULL REFERENCES items(id),
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,    -- avg_cost at approval; feeds §6 GUDANG/OUTLET_WASTE
  reason VARCHAR(30) NOT NULL CHECK (reason IN
    ('expired','damaged','lost','contaminated','cold_chain_breach','production_error','other')),
  reason_detail TEXT,                            -- FR-WST-01 alasan + kondisi
  status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  reported_by UUID NOT NULL REFERENCES users(id),      -- FR-WST-02 siapa mengajukan
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),               -- FR-WST-02 siapa menyetujui
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Wajib foto (FR-WST-01): attachments(entity_type='waste_record', kind='waste_photo') required to submit.
-- Approval posts waste_out via ledger (FR-WST-04) + journal (§6).

-- 081: returns, both directions (8.8.1 outlet→gudang, 8.8.2 gudang→supplier)
CREATE TABLE returns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_number VARCHAR(30) UNIQUE NOT NULL,     -- 'RET/YYYYMM/nnnn'
  direction VARCHAR(30) NOT NULL CHECK (direction IN ('outlet_to_warehouse','warehouse_to_supplier')),
  from_location_id UUID NOT NULL REFERENCES locations(id),
  to_location_id UUID REFERENCES locations(id),  -- NULL when direction = warehouse_to_supplier
  supplier_id UUID REFERENCES suppliers(id),     -- required when warehouse_to_supplier
  status VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN
    ('draft','submitted','approved','rejected','in_transit','received','completed','cancelled')),
  requested_by UUID NOT NULL REFERENCES users(id),     -- FR-WST-02
  approval_id UUID REFERENCES approvals(id),
  approved_by UUID REFERENCES users(id),
  approved_at TIMESTAMPTZ,
  rejection_reason TEXT,
  shipped_at TIMESTAMPTZ,                        -- bukti kirim = attachments kind='return_proof' (FR-WST-03)
  received_by UUID REFERENCES users(id),
  received_at TIMESTAMPTZ,                       -- bukti terima = attachments kind='receiving_photo' (FR-WST-03)
  notes TEXT,
  client_id UUID UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (direction <> 'warehouse_to_supplier' OR supplier_id IS NOT NULL),
  CHECK (direction <> 'outlet_to_warehouse' OR to_location_id IS NOT NULL)
);

CREATE TABLE return_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  item_id UUID NOT NULL REFERENCES items(id),
  storage_area_id UUID NOT NULL REFERENCES storage_areas(id), -- source area at from_location
  qty NUMERIC(14,3) NOT NULL CHECK (qty > 0),    -- FR-WST-01 jumlah
  condition VARCHAR(20) NOT NULL CHECK (condition IN ('damaged','expired','wrong_item','quality','other')),
  reason TEXT NOT NULL,                          -- FR-WST-01 alasan
  qty_received NUMERIC(14,3),
  unit_cost NUMERIC(18,2) NOT NULL DEFAULT 0,
  UNIQUE (return_id, item_id)
);
-- Ship posts return_out at from_location; receive posts return_in at to_location (or AP credit for supplier) — FR-WST-04, §6.
```

### 1.10 Block 090–099 — accounting: COA, journal, posting rules, payment verification (D-04)

```sql
-- 090: chart of accounts (seed in §6.1)
CREATE TABLE chart_of_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(10) UNIQUE NOT NULL,
  name VARCHAR(150) NOT NULL,
  type VARCHAR(20) NOT NULL CHECK (type IN ('asset','liability','equity','revenue','expense')),
  normal_balance VARCHAR(6) NOT NULL CHECK (normal_balance IN ('debit','credit')),
  parent_id UUID REFERENCES chart_of_accounts(id),
  is_postable BOOLEAN NOT NULL DEFAULT true,     -- header accounts: false
  is_system BOOLEAN NOT NULL DEFAULT false,      -- referenced by posting_rules ⇒ cannot deactivate
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 091: fiscal periods
CREATE TABLE fiscal_periods (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_code VARCHAR(7) UNIQUE NOT NULL,        -- '2026-08'
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','locked')),
  closed_by UUID REFERENCES users(id),
  closed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Posting into closed ⇒ ERR_PERIOD_CLOSED; 'locked' additionally forbids reversal entries.

-- 092: journal (double-entry; always balanced — property-tested)
CREATE TABLE journal_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_number VARCHAR(30) UNIQUE NOT NULL,      -- 'JE/YYYYMM/nnnnn'
  entry_date DATE NOT NULL,
  fiscal_period_id UUID NOT NULL REFERENCES fiscal_periods(id),
  event_type VARCHAR(50),                        -- JournalEventType (§2); NULL for manual entries
  source VARCHAR(10) NOT NULL DEFAULT 'system' CHECK (source IN ('system','manual')),
  ref_type VARCHAR(40),                          -- 'po_receipt','surat_jalan','sj_drop','sale_day','waste_batch',
  ref_id UUID,                                   -- 'stock_adjustment','return','petty_cash','payroll_run','payment_verification'
  location_id UUID REFERENCES locations(id),     -- reporting dimension (jurnal gudang vs outlet)
  description TEXT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','reversed')),
  reversed_by_entry_id UUID REFERENCES journal_entries(id),
  posted_by UUID REFERENCES users(id),           -- NULL for engine postings
  posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Idempotency: UNIQUE (event_type, ref_type, ref_id) WHERE source='system' — the engine can replay events safely.

CREATE TABLE journal_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id UUID NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no INTEGER NOT NULL,
  account_id UUID NOT NULL REFERENCES chart_of_accounts(id),
  debit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(18,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  location_id UUID REFERENCES locations(id),
  memo TEXT,
  CHECK ((debit = 0) <> (credit = 0)),           -- exactly one side per line
  UNIQUE (entry_id, line_no)
);

-- 093: declarative posting rules (D-04) — seeded from §6.2, editable only by Finance/Owner
CREATE TABLE posting_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type VARCHAR(50) NOT NULL,               -- JournalEventType (§2)
  rule_seq INTEGER NOT NULL,                     -- one event may emit several Dr/Cr pairs
  condition JSONB,                               -- e.g. {"method":"cash"} | {"direction":"shortage"} | NULL = always
  debit_account_code VARCHAR(10) NOT NULL,
  credit_account_code VARCHAR(10) NOT NULL,
  amount_source VARCHAR(100) NOT NULL,           -- named selector resolved by the engine (§6.2 column)
  description_template TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_type, rule_seq)
);

-- 094: payment verification queue (8.9.1; FR-ACCT-01..04)
CREATE TABLE payment_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pv_number VARCHAR(30) UNIQUE NOT NULL,
  ref_type VARCHAR(40) NOT NULL CHECK (ref_type IN
    ('purchase_order','payroll_run','petty_cash','maintenance_job','sale_payment','online_order','incentive','thr','other')),
  ref_id UUID,
  payee_type VARCHAR(20) NOT NULL CHECK (payee_type IN ('supplier','employee','platform','other')),
  payee_id UUID,                                 -- suppliers.id / employees.id
  amount NUMERIC(18,2) NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','paid','rejected')),
  proof_attachment_id UUID REFERENCES attachments(id),  -- FR-ACCT-01 bukti pembayaran
  reference_number VARCHAR(100),                 -- FR-ACCT-01 nomor referensi
  submitted_by UUID NOT NULL REFERENCES users(id),
  verified_by UUID REFERENCES users(id),         -- FR-ACCT-02 siapa + kapan
  verified_at TIMESTAMPTZ,
  approval_id UUID REFERENCES approvals(id),     -- owner step above threshold (§5.8)
  paid_by UUID REFERENCES users(id),
  paid_at TIMESTAMPTZ,
  paid_via VARCHAR(20) CHECK (paid_via IN ('cash','bank_transfer','qris')),
  rejection_reason TEXT,
  location_id UUID REFERENCES locations(id),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE purchase_orders ADD CONSTRAINT fk_po_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);
ALTER TABLE petty_cash ADD CONSTRAINT fk_pc_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);
ALTER TABLE payroll_runs ADD CONSTRAINT fk_prun_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);
ALTER TABLE maintenance_jobs ADD CONSTRAINT fk_mj_pv FOREIGN KEY (payment_verification_id) REFERENCES payment_verifications(id);
```

### 1.11 Block 100–109 — reporting rollups (materialized views)

```sql
-- 100: refreshed CONCURRENTLY every 5 min by a backend scheduler (M18/M19 read-only consumers)
CREATE MATERIALIZED VIEW mv_sales_daily AS      -- FR-DASH-01/02/03: per location per day
  SELECT location_id, (occurred_at AT TIME ZONE 'Asia/Makassar')::date AS sales_date,
         COUNT(*) FILTER (WHERE status='completed') AS tx_count,
         SUM(total) FILTER (WHERE status='completed') AS gross,
         SUM(discount) AS discounts,
         SUM(total) FILTER (WHERE status IN ('voided','refunded')) AS voided_amount
  FROM sales GROUP BY 1,2;
-- + UNION-side rollup of online_orders(net_received, platform) — same grain, column platform NULL for POS.

CREATE MATERIALIZED VIEW mv_item_usage_daily AS -- FR-POS-06 usage estimate + FR-LOG-08/19 patterns
  SELECT location_id, item_id, (occurred_at AT TIME ZONE 'Asia/Makassar')::date AS usage_date,
         SUM(qty) AS qty_used
  FROM stock_movements WHERE movement_type='usage_out' GROUP BY 1,2,3;

CREATE MATERIALIZED VIEW mv_employee_kpi_daily AS -- FR-DASH-03 performa kasir + kehadiran
  -- per employee per day: attendance status, late_minutes, overtime_minutes,
  -- sales_count + sales_amount for kasir (join sales on kasir_id via users/employees)
  SELECT ...;

CREATE MATERIALIZED VIEW mv_delivery_recap_daily AS -- FR-LOG-04 rekap harian tim logistik
  -- per planned_date: SJ count, drops, destination outlets, Σ qty per item, frozen/dry split
  SELECT ...;
```
(Exact SELECT bodies are W1-C's to finalize; the **grains and column names above are contract** for M18/M19.)

### 1.12 Block 110–119 — device registry & branch nodes (D-13)

```sql
-- 110: branch nodes (Tier 2, optional per D-12)
CREATE TABLE branch_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID UNIQUE NOT NULL REFERENCES locations(id),  -- max one node per location
  name VARCHAR(100) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'unpaired' CHECK (status IN
    ('online','stale','offline','unpaired','retired')),
  version VARCHAR(30),                           -- node software version
  node_token_hash VARCHAR(255),                  -- socket auth credential
  ip_address INET, hostname VARCHAR(100),
  os_info JSONB NOT NULL DEFAULT '{}',
  last_seen_at TIMESTAMPTZ,
  paired_at TIMESTAMPTZ, paired_by UUID REFERENCES users(id),
  unpaired_at TIMESTAMPTZ,
  settings JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 111: devices (Tier 1: tablets/laptops running the PWA; plus LAN gear found by discovery)
CREATE TABLE devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id UUID NOT NULL REFERENCES locations(id),
  node_id UUID REFERENCES branch_nodes(id),      -- NULL when no branch node at the location
  category VARCHAR(20) NOT NULL CHECK (category IN
    ('tablet','pos_terminal','printer','laptop','router','branch_node','other')),
  name VARCHAR(100) NOT NULL,
  fingerprint VARCHAR(100) UNIQUE,               -- stable device-generated id (PWA install identity)
  replaces_device_id UUID REFERENCES devices(id),-- SYNC-PROTOCOL §1.5: links successive installations of the
                                                 -- same physical device; a retired id's un-synced queue stays attributable
  status VARCHAR(20) NOT NULL DEFAULT 'unpaired' CHECK (status IN
    ('online','stale','offline','unpaired','retired')),
  app_version VARCHAR(30),                       -- D-13
  queue_depth INTEGER NOT NULL DEFAULT 0,        -- D-13: outbox events pending push (last reported)
  last_seen_at TIMESTAMPTZ,
  last_sync_at TIMESTAMPTZ,
  device_token_hash VARCHAR(255),                -- long-lived device JWT (scope: heartbeat+sync)
  ip_address INET, mac_address VARCHAR(17),
  vendor VARCHAR(100), model VARCHAR(100),
  os_info JSONB NOT NULL DEFAULT '{}',
  metadata JSONB NOT NULL DEFAULT '{}',
  paired_at TIMESTAMPTZ, paired_by UUID REFERENCES users(id),
  unpaired_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Retro-FKs to earlier blocks:
ALTER TABLE sessions        ADD CONSTRAINT fk_sessions_device   FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE audit_log       ADD CONSTRAINT fk_audit_device      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE pos_shifts      ADD CONSTRAINT fk_shift_device      FOREIGN KEY (device_id) REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE attendance      ADD CONSTRAINT fk_att_device        FOREIGN KEY (check_in_device_id) REFERENCES devices(id) ON DELETE SET NULL;

-- 112: heartbeats (high volume; BIGSERIAL, 7-day retention pruned nightly)
CREATE TABLE device_heartbeats (                 -- append-only
  id BIGSERIAL PRIMARY KEY,
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  node_id UUID REFERENCES branch_nodes(id) ON DELETE CASCADE, -- exactly one of device_id/node_id set
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  app_version VARCHAR(30),
  queue_depth INTEGER NOT NULL DEFAULT 0,
  client_time TIMESTAMPTZ,                       -- clock-skew detection
  battery_pct SMALLINT, storage_free_mb INTEGER,
  network_type VARCHAR(20),
  payload JSONB NOT NULL DEFAULT '{}',
  CHECK ((device_id IS NULL) <> (node_id IS NULL))
);
-- INDEX (device_id, at DESC); (node_id, at DESC)

-- 113: device lifecycle events (feeds F12 + alerts)
CREATE TABLE device_events (                     -- append-only
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id UUID REFERENCES devices(id) ON DELETE CASCADE,
  node_id UUID REFERENCES branch_nodes(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id),
  type VARCHAR(30) NOT NULL CHECK (type IN
    ('paired','unpaired','online','offline','stale','version_changed','queue_alert','clock_skew','outlet_offline','outlet_online')),
  detail JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 114: pairing tokens (§7.2 flow)
CREATE TABLE pairing_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash VARCHAR(255) UNIQUE NOT NULL,
  display_code VARCHAR(12) NOT NULL,             -- human-typable, shown next to QR
  target_type VARCHAR(10) NOT NULL CHECK (target_type IN ('device','node')),
  location_id UUID NOT NULL REFERENCES locations(id),
  suggested_category VARCHAR(20),
  created_by UUID NOT NULL REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,               -- mint + 15 min
  used_at TIMESTAMPTZ,
  used_by_ref UUID,                              -- devices.id or branch_nodes.id
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 115: LAN discovery results (only where a node exists; D-13)
CREATE TABLE discovered_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id UUID NOT NULL REFERENCES branch_nodes(id) ON DELETE CASCADE,
  source VARCHAR(20) NOT NULL CHECK (source IN ('mdns','ssdp','onvif','tcp_probe')),
  ip_address INET NOT NULL,
  mac_address VARCHAR(17),
  vendor VARCHAR(100), model VARCHAR(100),
  suggested_category VARCHAR(20),
  suggested_name VARCHAR(100),
  status VARCHAR(20) NOT NULL DEFAULT 'new' CHECK (status IN ('new','confirmed','ignored')),
  confirmed_device_id UUID REFERENCES devices(id),
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  raw JSONB NOT NULL DEFAULT '{}',
  UNIQUE (node_id, ip_address, mac_address)
);
```

### 1.13 Block 120–129 — sync & offline authorization (D-12, D-17)

Row shapes here must match `docs/SYNC-PROTOCOL.md`; that document owns semantics (cursors, ordering, conflict rules). If the two ever disagree, SYNC-PROTOCOL wins for behavior, this file wins for DDL.

```sql
-- 120: the append-only event log (cloud's canonical copy; monthly partitions, kept forever).
-- Field names and semantics are SYNC-PROTOCOL §2.1 verbatim; cloud-only bookkeeping columns marked (cloud).
CREATE TABLE sync_events (
  event_id UUID PRIMARY KEY,                     -- CLIENT-minted UUIDv7 = THE idempotency key (never regenerated)
  server_seq BIGSERIAL UNIQUE,                   -- this tier's gapless arrival order; pull-cursor domain (§4.5)
  origin_tier VARCHAR(10) NOT NULL CHECK (origin_tier IN ('device','node','cloud')),
  origin_device_id UUID NOT NULL,                -- installation id (devices.id | branch_nodes.id | well-known cloud id)
  location_id UUID REFERENCES locations(id),     -- NULL = global master data
  entity TEXT NOT NULL,                          -- EXACT table name from §4.1 = SyncEntity (§2.9)
  entity_id UUID NOT NULL,                       -- business record id (parent id for embedded children)
  op TEXT NOT NULL,                              -- past-tense fact verb; vocabulary per entity in SYNC-PROTOCOL §3.3
  payload JSONB NOT NULL,                        -- versioned envelope {v, data, meta} (§2.3); ≤ 256 KB
  client_seq BIGINT NOT NULL,                    -- gapless monotonic per origin; THE ordering authority
  occurred_at TIMESTAMPTZ NOT NULL,              -- origin wall clock (offset-corrected); ADVISORY only
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),-- stamped by this tier at durable store; cloud's = canonical
  relay_received_at TIMESTAMPTZ,                 -- first non-origin tier's stamp (node when present); defensibility bound (§6.4)
  relayed_via_node_id UUID REFERENCES branch_nodes(id), -- (cloud) which node relayed; NULL = direct/cloud-born
  actor_user_id UUID NOT NULL,                   -- who did it (copied from meta for indexing/audit)
  schema_v SMALLINT NOT NULL DEFAULT 1,          -- copy of payload.v
  batch_id UUID,                                 -- (cloud) FK added below
  apply_status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (apply_status IN
    ('pending','applied','quarantined','superseded','pending_dependency')),  -- (cloud) §4.4/§5.1
  applied_at TIMESTAMPTZ,                        -- (cloud)
  reject_code VARCHAR(40),                       -- (cloud) 'authority_violation'|'malformed'|'seq_conflict'|'payload_version_unsupported'
  reject_detail TEXT,                            -- (cloud)
  UNIQUE (origin_device_id, client_seq)          -- outbox-corruption detector (§2.2 rule 4)
);
-- INDEX (entity, entity_id); (location_id, server_seq); (apply_status) WHERE apply_status <> 'applied'

-- 121: push batches (transport observability; batch_id is NOT an idempotency key)
CREATE TABLE sync_batches (
  id UUID PRIMARY KEY,                           -- client-generated per transmission (retry mints a new one)
  origin_tier VARCHAR(10) NOT NULL,
  origin_device_id UUID NOT NULL,
  location_id UUID REFERENCES locations(id),
  event_count INTEGER NOT NULL,
  first_seq BIGINT NOT NULL, last_seq BIGINT NOT NULL,
  status VARCHAR(10) NOT NULL DEFAULT 'received' CHECK (status IN ('received','applied','partial','failed')),
  result JSONB NOT NULL DEFAULT '{}',            -- {accepted_through, confirmed_through, rejected[], resend_from}
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);
ALTER TABLE sync_events ADD CONSTRAINT fk_se_batch FOREIGN KEY (batch_id) REFERENCES sync_batches(id);

-- 122: pull cursors per subscriber (positions in THIS tier's server_seq; per-upstream, non-transferable)
CREATE TABLE sync_cursors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscriber_type VARCHAR(10) NOT NULL CHECK (subscriber_type IN ('device','node')),
  subscriber_id UUID NOT NULL,
  stream VARCHAR(40) NOT NULL DEFAULT 'main',    -- single main stream v1; reserved for future split
  cursor BIGINT NOT NULL DEFAULT 0,              -- last server_seq served/acked
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (subscriber_id, stream)
);

-- 123: conflict + exception queue rows (SYNC-PROTOCOL §5.2/§5.4; F12 + F07 surfaces)
CREATE TABLE sync_conflicts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind VARCHAR(30) NOT NULL CHECK (kind IN (
    'double_count',              -- C1 opname line counted twice
    'duplicate_receipt',         -- C2 drop received twice
    'decision_race',             -- C3 offline vs online decision, divergent outcomes
    'attendance_overlap',        -- C4
    'negative_balance',          -- C5 (also mirrored in stock_reconciliations)
    'duplicate_inbound',         -- C6
    'offline_auth',              -- C7 failed/unprovable re-verification
    'duplicate_platform_order',  -- C8
    'poison')),                  -- C9 malformed / authority_violation / seq_conflict
  queue VARCHAR(10) NOT NULL CHECK (queue IN ('conflict','exception','finance','hr')),  -- §5.4 routing
  entity TEXT NOT NULL,
  entity_id UUID,
  location_id UUID REFERENCES locations(id),
  winner_event_id UUID REFERENCES sync_events(event_id),
  loser_event_id UUID REFERENCES sync_events(event_id),
  detail JSONB NOT NULL DEFAULT '{}',            -- both payloads + detection rule + suggested action
  physical_effect_suspected BOOLEAN NOT NULL DEFAULT false,  -- §7.5
  assignee_role VARCHAR(30),
  status VARCHAR(10) NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','dismissed')),
  resolution_event_id UUID REFERENCES sync_events(event_id), -- resolutions are new events, never edits
  resolved_by UUID REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 124: offline credential registry (cloud mint record; the credential token goes to the device over the
-- authenticated login API, NEVER through the event stream — SYNC-PROTOCOL §7.2 v1.4).
-- The token is DELIBERATELY UNSIGNED in v1 (decision, not oversight): the cloud re-verifies every offline
-- authorization against THIS row (§7.4), so a forged token cannot make the cloud accept anything; a signature
-- would not raise the §7.1 skill floor (verifier + key would live in the adversary's own bundle). Preventive
-- fix, if ever needed, is approver-owned-device QR signing — open under RISK-S2. Do not add a signing key
-- or key-distribution mechanism; none exists by design.
CREATE TABLE offline_credentials (
  credential_id UUID PRIMARY KEY,                -- the id inside the token
  user_id UUID NOT NULL REFERENCES users(id),    -- approver (sub)
  device_id UUID REFERENCES devices(id),         -- NULL = minted for all devices of the location(s)
  role_key VARCHAR(30) NOT NULL,
  location_ids UUID[] NOT NULL,
  scopes JSONB NOT NULL,                         -- {"void_refund.approve":{"max_idr":"500000.00"}, …} (§7.2 shape)
  binding_secret_enc BYTEA NOT NULL,             -- per-issuance k, encrypted at rest; verifies §7.3 binding HMAC
  pin_verifier VARCHAR(255) NOT NULL,            -- argon2id of approver PIN (also shipped in token for local check)
  selfie_required_above NUMERIC(18,2) NOT NULL DEFAULT 200000.00,
  volume_cap INTEGER NOT NULL DEFAULT 20,        -- §7.4 check 8
  use_count INTEGER NOT NULL DEFAULT 0,
  minted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,               -- TTL: settings.offline_credential_ttl (default 24 h)
  revoked_at TIMESTAMPTZ                         -- revocation rides the CRL pull
);
ALTER TABLE approval_steps ADD CONSTRAINT fk_as_offline_cred
  FOREIGN KEY (offline_credential_id) REFERENCES offline_credentials(credential_id);

-- 125: one row per offline authorization USE, with credential binding + three-valued re-verification outcome
CREATE TABLE offline_authorizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  credential_id UUID NOT NULL REFERENCES offline_credentials(credential_id),
  approval_event_id UUID REFERENCES sync_events(event_id),   -- the *_offline decision event
  user_id UUID NOT NULL REFERENCES users(id),    -- the approver
  device_id UUID NOT NULL REFERENCES devices(id),
  location_id UUID REFERENCES locations(id),
  document_type VARCHAR(40) NOT NULL,            -- ApprovalDocumentType
  document_id UUID NOT NULL,
  action VARCHAR(50) NOT NULL,                   -- scope key exercised ('void_refund.approve', …)
  amount NUMERIC(18,2),                          -- for scope max_idr + selfie-threshold checks
  binding_hmac VARCHAR(64) NOT NULL,             -- SYNC-PROTOCOL §7.3 (normative, pinned by the shared
                                                 -- known-answer fixture): HMAC_SHA256(k,
                                                 -- event_id‖entity‖entity_id‖op‖amount_idr‖occurred_at) where the
                                                 -- joiner is exactly ONE U+2016 '‖' (never ASCII '|'), and
                                                 -- amount_idr is normalized to '' BY THE CALLER when absent —
                                                 -- the HMAC helper does no coalescing
  pin_attempts_before_success SMALLINT,          -- §7.4 check 7 telemetry
  selfie_attachment_id UUID REFERENCES attachments(id),      -- required iff amount ≥ threshold
  granted_at TIMESTAMPTZ NOT NULL,               -- client time (advisory)
  relay_received_at TIMESTAMPTZ,                 -- first server sighting → expiry provability (§6.4)
  synced_at TIMESTAMPTZ,
  outcome VARCHAR(30) NOT NULL DEFAULT 'pending_verification' CHECK (outcome IN
    ('pending_verification','verified','failed','unprovable')),   -- three-valued + pending (§7.4)
  failure_reason TEXT,                           -- which §7.4 check failed / why unprovable
  verdict VARCHAR(10) CHECK (verdict IN ('upheld','rejected')),   -- finance decision on failed/unprovable (§7.5)
  reviewed_by UUID REFERENCES users(id),
  reviewed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- verdict='rejected' with physical effect ⇒ posting rule OFFLINE_AUTH_REJECTED (§6.3) books the loss
-- to Piutang Klaim Karyawan — the ledger is append-only, the unwind is a claim, never a deletion.
```

### 1.14 RLS matrix (block 009 implements; session vars `app.user_id`, `app.role`, `app.location_ids`)

Predicate classes — `LOC` = `app_has_location(location_id)`; `PARENT` = via parent row's policy; `ROLE(x,y)` = `app.role IN (x,y)`; `SELF` = row belongs to `app.user_id` (directly or via `employees.user_id`); `ALL` = any authenticated user; `NONE` = RLS not enabled (guarded at API layer only). Central roles (`owner`,`manager`,`finance`,`hr_admin`) pass every `LOC` check via `app_is_central()`.

| Tables | RLS | Predicate |
|---|---|---|
| `locations` | yes | `ALL` read; writes `ROLE(owner,manager)` |
| `storage_areas`, `min_stock_rules`, `stock_balances`, `stock_movements`, `stock_opname`, `stock_adjustments`, `stock_reconciliations`, `replenishment_requests`, `goods_receipts`, `pos_shifts`, `sales`, `void_refunds`, `online_orders`, `cash_variance_proposals`, `waste_records`, `returns` (via `from_location_id`), `petty_cash`, `assets`, `devices`, `branch_nodes` | yes | `LOC` |
| `stock_opname_lines`, `replenishment_request_lines`, `goods_receipt_lines`, `sale_lines`, `sale_payments`, `return_lines`, `petty_cash_lines`, `po_lines`, `po_receipt_lines`, `sj_lines` | yes | `PARENT` |
| `surat_jalan`, `sj_drops`, `sj_temperature_logs`, `sj_seals` | yes | origin `LOC` OR any drop `LOC` OR `app.role='driver'` and SJ assigned to the driver's `drivers.user_id` |
| `purchase_requests`, `purchase_orders`, `po_receipts` | yes | `LOC` AND `ROLE(owner,manager,finance,kepala_gudang,supervisor)` |
| `suppliers` | yes | `ROLE(owner,manager,finance,kepala_gudang)` OR (`ROLE(supervisor,leader_outlet)` AND `outlet_visible = true`) — **Amendment 3**: outlet roles see the row but the API serves them only the directory projection (name/contact); `payment_terms_days`, bank fields, and all pricing are stripped at the API layer (column-level lock, FR-SUP-06) |
| `supplier_items`, `supplier_price_history` | yes | `ROLE(owner,manager,finance,kepala_gudang)` — price rows stay fully hidden from outlet roles (FR-SUP-06) |
| `employees`, `employments`, `attendance`, `leave_requests`, `shift_assignments` | yes | `ROLE(owner,manager,finance,hr_admin)` OR (`supervisor` AND `LOC`) OR `SELF` |
| `salary_components`, `employee_salary_components`, `employee_loans`, `payroll_periods`, `payroll_runs`, `payroll_lines` | yes | `ROLE(owner,manager,finance,hr_admin)` OR `SELF` (read own lines/loans/slips) |
| `chart_of_accounts`, `fiscal_periods`, `journal_entries`, `journal_lines`, `posting_rules`, `payment_verifications` | yes | `ROLE(owner,manager,finance)` |
| `audit_log` | yes | read `ROLE(owner,manager,finance)`; INSERT via app role only; no UPDATE/DELETE grants |
| `notifications` | yes | `SELF` |
| `sessions`, `offline_credentials` | yes | `SELF` |
| `users`, `user_locations` | yes | `ROLE(owner,manager,hr_admin,finance)` read; self-read own row; writes `ROLE(owner,manager)` |
| `items`, `item_categories`, `units`, `unit_conversions`, `products`, `recipes`, `recipe_lines`, `shipment_types`, `roles`, `permissions`, `role_permissions`, `settings`, `document_counters`, `drivers`, `vehicles`, `work_shifts`, `maintenance_schedules`, `maintenance_jobs`, `service_history`, `attachments`, `notification_outbox`, `approval_*`, `device_*`, `pairing_tokens`, `discovered_devices`, `sync_*`, `offline_authorizations` | no (`NONE`) | master/kernel data; enforced by PermissionsGuard. `recipes`/`recipe_lines` reads additionally API-gated (`recipe.read`) because recipe = cost structure |

---

## 2. Enums (→ `packages/shared/src/enums.ts` verbatim)

W1-B transcribes these exactly: `export enum <Name> { KEY = 'value', … }`. DB CHECK constraints in §1 use the same string values. Adding a value later = architect amendment + `2xx` migration.

### 2.1 Core / location

```ts
export enum LocationType { WAREHOUSE = 'warehouse', OUTLET = 'outlet' }
export enum StorageAreaType {                    // D-15
  FREEZER = 'freezer', CHILLER = 'chiller', DRY_STORE = 'dry_store',
  DISPLAY = 'display', KITCHEN_LINE = 'kitchen_line',
}
export enum RoleKey {                            // §3 columns
  OWNER = 'owner', MANAGER = 'manager', FINANCE = 'finance', KEPALA_GUDANG = 'kepala_gudang',
  SUPERVISOR = 'supervisor', LEADER_OUTLET = 'leader_outlet', KASIR = 'kasir',
  HR_ADMIN = 'hr_admin', DRIVER = 'driver',      // driver added by D-14 (Appendix A-2)
}
```

### 2.2 Stock & logistics

```ts
export enum MovementType {                       // stock_movements.movement_type; sign encoded in suffix
  OPENING_BALANCE = 'opening_balance', PURCHASE_IN = 'purchase_in',
  TRANSFER_IN = 'transfer_in', TRANSFER_OUT = 'transfer_out',
  USAGE_OUT = 'usage_out', WASTE_OUT = 'waste_out',
  RETURN_IN = 'return_in', RETURN_OUT = 'return_out',
  ADJUSTMENT_IN = 'adjustment_in', ADJUSTMENT_OUT = 'adjustment_out',
}
export enum ReplenishmentStatus {                // FR-LOG-11 — exactly these 9
  DRAFT = 'draft',                               // Draft
  SUBMITTED = 'submitted',                       // Diajukan (menunggu supervisor)
  AWAITING_APPROVAL = 'awaiting_approval',       // Menunggu Approval (gudang/pusat)
  APPROVED = 'approved',                         // Disetujui
  REJECTED = 'rejected',                         // Ditolak
  PROCESSING = 'processing',                     // Diproses (picking di gudang)
  SHIPPED = 'shipped',                           // Dikirim (SJ in transit)
  RECEIVED = 'received',                         // Diterima (drop received)
  COMPLETED = 'completed',                       // Selesai
}
export enum ReplenishmentSource { MANUAL = 'manual', AUTO_SUGGESTION = 'auto_suggestion' }
export enum SuratJalanStatus {
  DRAFT = 'draft', READY = 'ready', LOADING = 'loading',
  IN_TRANSIT = 'in_transit', COMPLETED = 'completed', CANCELLED = 'cancelled',
}
export enum DropStatus {
  PENDING = 'pending', EN_ROUTE = 'en_route', ARRIVED = 'arrived',
  COMPLETED = 'completed', COMPLETED_DISCREPANCY = 'completed_discrepancy', FAILED = 'failed',
}
export enum ShipmentType { FROZEN = 'frozen', DRY = 'dry' }          // FR-LOG-02 (rows in shipment_types)
export enum TempLogStage { LOAD = 'load', DEPART = 'depart', ARRIVE = 'arrive' }
export enum SealStatus { APPLIED = 'applied', VERIFIED_INTACT = 'verified_intact', BROKEN = 'broken', REPLACED = 'replaced' }
export enum GoodsReceiptType { SJ_DROP = 'sj_drop', RETURN_IN = 'return_in' }
export enum OpnameStatus {
  DRAFT = 'draft', COUNTING = 'counting', SUBMITTED = 'submitted',
  APPROVED = 'approved', REJECTED = 'rejected', ADJUSTED = 'adjusted', CANCELLED = 'cancelled',
}
export enum AdjustmentSource { OPNAME = 'opname', MANUAL = 'manual', RECONCILIATION = 'reconciliation' }
export enum WasteReason {
  EXPIRED = 'expired', DAMAGED = 'damaged', LOST = 'lost', CONTAMINATED = 'contaminated',
  COLD_CHAIN_BREACH = 'cold_chain_breach', PRODUCTION_ERROR = 'production_error', OTHER = 'other',
}
export enum WasteStatus { PENDING = 'pending', APPROVED = 'approved', REJECTED = 'rejected' }
export enum ReturnDirection { OUTLET_TO_WAREHOUSE = 'outlet_to_warehouse', WAREHOUSE_TO_SUPPLIER = 'warehouse_to_supplier' }
export enum ReturnStatus {
  DRAFT = 'draft', SUBMITTED = 'submitted', APPROVED = 'approved', REJECTED = 'rejected',
  IN_TRANSIT = 'in_transit', RECEIVED = 'received', COMPLETED = 'completed', CANCELLED = 'cancelled',
}
export enum ReturnCondition { DAMAGED = 'damaged', EXPIRED = 'expired', WRONG_ITEM = 'wrong_item', QUALITY = 'quality', OTHER = 'other' }
export enum ItemStorageType { FROZEN = 'frozen', CHILLED = 'chilled', DRY = 'dry' }
```

### 2.3 Purchasing

```ts
export enum PurchaseRequestStatus {
  DRAFT = 'draft', SUBMITTED = 'submitted', APPROVED = 'approved',
  REJECTED = 'rejected', CONVERTED = 'converted', CANCELLED = 'cancelled',
}
export enum PurchaseOrderStatus {
  DRAFT = 'draft', PENDING_APPROVAL = 'pending_approval', APPROVED = 'approved', ISSUED = 'issued',
  PARTIALLY_RECEIVED = 'partially_received', RECEIVED = 'received', CLOSED = 'closed', CANCELLED = 'cancelled',
}
export enum PettyCashStatus { PENDING = 'pending', VERIFIED = 'verified', REJECTED = 'rejected' }
```

### 2.4 POS & payments

```ts
export enum ShiftStatus { OPEN = 'open', CLOSED = 'closed' }
export enum SaleStatus { COMPLETED = 'completed', VOIDED = 'voided', REFUNDED = 'refunded' }
export enum PaymentMethod { CASH = 'cash', QRIS = 'qris', BANK_TRANSFER = 'bank_transfer' }   // FR-POS-04
export enum PaymentStatus { PENDING = 'pending', VERIFIED = 'verified', PAID = 'paid' }        // FR-ACCT-03
export enum VoidRefundType { VOID = 'void', REFUND = 'refund' }
export enum VoidRefundStatus { PENDING = 'pending', APPROVED = 'approved', REJECTED = 'rejected' }
export enum OnlinePlatform { GOFOOD = 'gofood', SHOPEEFOOD = 'shopeefood' }                    // FR-POS-05/07
export enum OnlineOrderStatus { COMPLETED = 'completed', CANCELLED = 'cancelled' }
export enum SettlementStatus { PENDING = 'pending', SETTLED = 'settled' }
export enum CashVarianceProposalStatus {          // Amendment 2 (auto-propose, human-approve)
  PENDING = 'pending', APPROVED = 'approved', REJECTED = 'rejected', CANCELLED = 'cancelled',
}
```

### 2.5 Approvals (D-08)

```ts
export enum ApprovalState { PENDING = 'pending', APPROVED = 'approved', REJECTED = 'rejected', CANCELLED = 'cancelled' }
export enum ApprovalStepState { PENDING = 'pending', APPROVED = 'approved', REJECTED = 'rejected', SKIPPED = 'skipped' }
export enum ApprovalAction { SUBMIT = 'submit', APPROVE = 'approve', REJECT = 'reject', AMEND = 'amend', CANCEL = 'cancel' }
export enum ApprovalDocumentType {
  REPLENISHMENT_REQUEST = 'replenishment_request', VOID_REFUND = 'void_refund',
  PURCHASE_REQUEST = 'purchase_request', PURCHASE_ORDER = 'purchase_order',
  STOCK_OPNAME = 'stock_opname', RETURN = 'return',
  WASTE = 'waste',                               // §5.10 waste chain (outlet step offline-eligible per §7.6)
  PAYROLL_RUN = 'payroll_run', PAYMENT_VERIFICATION = 'payment_verification',
  LEAVE_REQUEST = 'leave_request', EMPLOYEE_LOAN = 'employee_loan',
  CASH_VARIANCE_PROPOSAL = 'cash_variance_proposal',  // Amendment 2
}
export enum ReverificationStatus { VERIFIED = 'verified', FAILED = 'failed', UNPROVABLE = 'unprovable' } // D-17, SYNC-PROTOCOL §7.4
```

### 2.6 HR & payroll

```ts
export enum EmploymentStatus { ACTIVE = 'active', PROBATION = 'probation', RESIGNED = 'resigned', TERMINATED = 'terminated' }
export enum AttendanceStatus {
  PRESENT = 'present', LATE = 'late', ABSENT = 'absent',            // absent = alpha (POUT-03)
  SICK = 'sick', PERMISSION = 'permission', LEAVE = 'leave', HOLIDAY = 'holiday', OFF = 'off',
}
export enum LeaveType {
  ANNUAL = 'annual',           // cuti tahunan 12 hari (POUT-04)
  MARRIAGE = 'marriage',       // cuti nikah 3 hari (POUT-04)
  SICK = 'sick',               // POUT-01
  PERMISSION = 'permission',   // izin (POUT-02)
  UNPAID = 'unpaid',
}
export enum LeaveStatus { PENDING = 'pending', APPROVED = 'approved', REJECTED = 'rejected', CANCELLED = 'cancelled' }
export enum PayrollComponentType {
  EARNING = 'earning', DEDUCTION = 'deduction',
  EMPLOYER_COST = 'employer_cost',               // Amendment 1: BPJS employer shares — company cost, not net-pay
}
export enum PayrollComponentCode {
  // ── PRD BASE components (the 7 PIN + 9 POUT, plus the Amendment-2 cash-variance deduction; always active) ──
  BASE_SALARY = 'base_salary',                             // PIN-01
  OVERTIME = 'overtime',                                   // PIN-02 (formula: attendance overtime_minutes)
  ATTENDANCE_ALLOWANCE = 'attendance_allowance',           // PIN-03
  PERFORMANCE_INCENTIVE = 'performance_incentive',         // PIN-04
  TENURE_ALLOWANCE = 'tenure_allowance',                   // PIN-05 (formula: join_date)
  POSITION_ALLOWANCE = 'position_allowance',               // PIN-06
  OTHER_EARNING = 'other_earning',                         // PIN-07
  DEDUCTION_SICK = 'deduction_sick',                       // POUT-01
  DEDUCTION_PERMISSION = 'deduction_permission',           // POUT-02
  DEDUCTION_ABSENCE = 'deduction_absence',                 // POUT-03 (alpha)
  DEDUCTION_LEAVE_EXCESS = 'deduction_leave_excess',       // POUT-04 (beyond quota)
  DEDUCTION_STOCK_SHORTFALL = 'deduction_stock_shortfall', // POUT-05 (from approved SO diff)
  DEDUCTION_LOAN_INSTALLMENT = 'deduction_loan_installment', // POUT-06 (kasbon amortization)
  DEDUCTION_LATE = 'deduction_late',                       // POUT-07 (+ POUT-08 attendance-data basis, Appendix A-6)
  OTHER_DEDUCTION = 'other_deduction',                     // POUT-09
  DEDUCTION_CASH_VARIANCE = 'deduction_cash_variance',     // Amendment 2: approved shift cash-shortfall proposal (POUT-09 family)
  // ── STATUTORY components (Amendment 1; is_statutory=true — compute ONLY when payroll.statutory enabled) ──
  BPJS_KESEHATAN_EMPLOYEE = 'bpjs_kesehatan_employee',     // deduction (1%)
  BPJS_JHT_EMPLOYEE = 'bpjs_jht_employee',                 // deduction (2%)
  BPJS_JP_EMPLOYEE = 'bpjs_jp_employee',                   // deduction (1%, capped)
  PPH21 = 'pph21',                                         // deduction (TER monthly; Article-17 true-up in December)
  BPJS_KESEHATAN_EMPLOYER = 'bpjs_kesehatan_employer',     // employer_cost (4%)
  BPJS_JHT_EMPLOYER = 'bpjs_jht_employer',                 // employer_cost (3.7%)
  BPJS_JKK_EMPLOYER = 'bpjs_jkk_employer',                 // employer_cost (risk-class rate; employer-only)
  BPJS_JKM_EMPLOYER = 'bpjs_jkm_employer',                 // employer_cost (0.3%; employer-only)
  BPJS_JP_EMPLOYER = 'bpjs_jp_employer',                   // employer_cost (2%, capped)
}
export enum PayrollRunStatus {
  DRAFT = 'draft', CALCULATED = 'calculated', PENDING_APPROVAL = 'pending_approval',
  APPROVED = 'approved', PAID = 'paid', CANCELLED = 'cancelled',
}
export enum LoanStatus { PENDING = 'pending', ACTIVE = 'active', PAID_OFF = 'paid_off', WRITTEN_OFF = 'written_off', REJECTED = 'rejected' }
```

### 2.7 Assets

```ts
export enum AssetCategory { MACHINE = 'machine', VEHICLE = 'vehicle', EQUIPMENT = 'equipment', ELECTRONICS = 'electronics', FURNITURE = 'furniture', OTHER = 'other' }
export enum AssetCondition { GOOD = 'good', FAIR = 'fair', POOR = 'poor', BROKEN = 'broken' }
export enum AssetStatus { ACTIVE = 'active', IN_MAINTENANCE = 'in_maintenance', RETIRED = 'retired', LOST = 'lost' }
export enum MaintenanceJobStatus { SCHEDULED = 'scheduled', DUE = 'due', IN_PROGRESS = 'in_progress', DONE = 'done', VERIFIED = 'verified', SKIPPED = 'skipped' }
export enum MaintenanceJobType { SCHEDULED = 'scheduled', CORRECTIVE = 'corrective' }
```

### 2.8 Accounting

```ts
export enum AccountType { ASSET = 'asset', LIABILITY = 'liability', EQUITY = 'equity', REVENUE = 'revenue', EXPENSE = 'expense' }
export enum NormalBalance { DEBIT = 'debit', CREDIT = 'credit' }
export enum FiscalPeriodStatus { OPEN = 'open', CLOSED = 'closed', LOCKED = 'locked' }
export enum JournalEntryStatus { POSTED = 'posted', REVERSED = 'reversed' }
export enum JournalEventType {                   // the 16 PRD journal event types (§6.2)
  GUDANG_PURCHASE = 'gudang_purchase',                           // FR-ACC-JGUD-01
  GUDANG_GOODS_IN = 'gudang_goods_in',                           // FR-ACC-JGUD-02
  GUDANG_GOODS_OUT_TO_OUTLET = 'gudang_goods_out_to_outlet',     // FR-ACC-JGUD-03
  GUDANG_RETURN_TO_SUPPLIER = 'gudang_return_to_supplier',       // FR-ACC-JGUD-04
  GUDANG_WASTE = 'gudang_waste',                                 // FR-ACC-JGUD-05
  GUDANG_STOCK_ADJUSTMENT = 'gudang_stock_adjustment',           // FR-ACC-JGUD-06
  GUDANG_STOCK_REVALUATION = 'gudang_stock_revaluation',         // FR-ACC-JGUD-07
  OUTLET_GOODS_IN_FROM_WAREHOUSE = 'outlet_goods_in_from_warehouse', // FR-ACC-JOUT-01
  OUTLET_INGREDIENT_USAGE = 'outlet_ingredient_usage',           // FR-ACC-JOUT-02
  OUTLET_SALES = 'outlet_sales',                                 // FR-ACC-JOUT-03
  OUTLET_WASTE = 'outlet_waste',                                 // FR-ACC-JOUT-04
  OUTLET_RETURN_TO_WAREHOUSE = 'outlet_return_to_warehouse',     // FR-ACC-JOUT-05
  OUTLET_STOCK_ADJUSTMENT = 'outlet_stock_adjustment',           // FR-ACC-JOUT-06
  OUTLET_DIRECT_PURCHASE = 'outlet_direct_purchase',             // FR-ACC-JOUT-07
  OUTLET_PETTY_CASH = 'outlet_petty_cash',                       // FR-ACC-JOUT-08
  OUTLET_OPERATING_EXPENSE = 'outlet_operating_expense',         // FR-ACC-JOUT-09
}
export enum JournalSystemEventType {             // D-04 extensions beyond the 16 (§6.3)
  PAYROLL_ACCRUAL = 'payroll_accrual', PAYROLL_PAYMENT = 'payroll_payment',
  QRIS_SETTLEMENT = 'qris_settlement', TRANSFER_VERIFIED = 'transfer_verified',
  PLATFORM_SETTLEMENT = 'platform_settlement', SALE_VOID_REVERSAL = 'sale_void_reversal',
  OFFLINE_AUTH_REJECTED = 'offline_auth_rejected',  // SYNC-PROTOCOL §7.5: failed offline approval w/ physical effect → claim
}
export enum PaymentVerificationRefType {
  PURCHASE_ORDER = 'purchase_order', PAYROLL_RUN = 'payroll_run', PETTY_CASH = 'petty_cash',
  MAINTENANCE_JOB = 'maintenance_job', SALE_PAYMENT = 'sale_payment', ONLINE_ORDER = 'online_order',
  INCENTIVE = 'incentive', THR = 'thr', OTHER = 'other',        // FR-ACCT-04 list
}
export enum PayeeType { SUPPLIER = 'supplier', EMPLOYEE = 'employee', PLATFORM = 'platform', OTHER = 'other' }
```

### 2.9 Devices, topology, sync

```ts
export enum DeviceCategory {                     // adapted from AIRE for Mimi (D-13)
  TABLET = 'tablet', POS_TERMINAL = 'pos_terminal', PRINTER = 'printer',
  LAPTOP = 'laptop', ROUTER = 'router', BRANCH_NODE = 'branch_node', OTHER = 'other',
}
export enum DeviceStatus { ONLINE = 'online', STALE = 'stale', OFFLINE = 'offline', UNPAIRED = 'unpaired', RETIRED = 'retired' }
export enum DeviceEventType {
  PAIRED = 'paired', UNPAIRED = 'unpaired', ONLINE = 'online', OFFLINE = 'offline', STALE = 'stale',
  VERSION_CHANGED = 'version_changed', QUEUE_ALERT = 'queue_alert', CLOCK_SKEW = 'clock_skew',
  OUTLET_OFFLINE = 'outlet_offline', OUTLET_ONLINE = 'outlet_online',
}
export enum DiscoverySource { MDNS = 'mdns', SSDP = 'ssdp', ONVIF = 'onvif', TCP_PROBE = 'tcp_probe' }
export enum PairingTargetType { DEVICE = 'device', NODE = 'node' }
export enum SyncOriginType { DEVICE = 'device', NODE = 'node', CLOUD = 'cloud' }               // = origin_tier
export enum SyncApplyStatus {                     // cloud bookkeeping (SYNC-PROTOCOL §4.4/§5.1)
  PENDING = 'pending', APPLIED = 'applied', QUARANTINED = 'quarantined',
  SUPERSEDED = 'superseded', PENDING_DEPENDENCY = 'pending_dependency',
}
export enum SyncRejectCode {                      // permanent reject codes (SYNC-PROTOCOL §4.4)
  AUTHORITY_VIOLATION = 'authority_violation', MALFORMED = 'malformed',
  SEQ_CONFLICT = 'seq_conflict', PAYLOAD_VERSION_UNSUPPORTED = 'payload_version_unsupported',
}
export enum SyncBatchStatus { RECEIVED = 'received', APPLIED = 'applied', PARTIAL = 'partial', FAILED = 'failed' }
export enum SyncConflictKind {                    // SYNC-PROTOCOL §5.2 C1..C9
  DOUBLE_COUNT = 'double_count', DUPLICATE_RECEIPT = 'duplicate_receipt', DECISION_RACE = 'decision_race',
  ATTENDANCE_OVERLAP = 'attendance_overlap', NEGATIVE_BALANCE = 'negative_balance',
  DUPLICATE_INBOUND = 'duplicate_inbound', OFFLINE_AUTH = 'offline_auth',
  DUPLICATE_PLATFORM_ORDER = 'duplicate_platform_order', POISON = 'poison',
}
export enum SyncQueue { CONFLICT = 'conflict', EXCEPTION = 'exception', FINANCE = 'finance', HR = 'hr' }
// SyncEntity: values are the EXACT table names of §4.1 that travel the wire per SYNC-PROTOCOL §3.3
// (classes M/F/B + special cases; D/X/T and embedded child tables are NOT entities).
// The op vocabulary per entity lives in SYNC-PROTOCOL §3.3 and ships as executable data in packages/sync-protocol.
export enum SyncEntity {
  // block 001–009
  LOCATIONS = 'locations', STORAGE_AREAS = 'storage_areas', USERS = 'users', ROLES = 'roles',
  PERMISSIONS = 'permissions', ROLE_PERMISSIONS = 'role_permissions', USER_LOCATIONS = 'user_locations',
  NOTIFICATIONS = 'notifications', SETTINGS = 'settings',
  // block 010–019
  ITEM_CATEGORIES = 'item_categories', UNITS = 'units', UNIT_CONVERSIONS = 'unit_conversions',
  ITEMS = 'items', PRODUCTS = 'products', RECIPES = 'recipes',
  // block 020–029
  MIN_STOCK_RULES = 'min_stock_rules', STOCK_OPNAME = 'stock_opname', STOCK_ADJUSTMENTS = 'stock_adjustments',
  // block 030–039
  REPLENISHMENT_REQUESTS = 'replenishment_requests', SURAT_JALAN = 'surat_jalan', SJ_DROPS = 'sj_drops',
  SJ_TEMPERATURE_LOGS = 'sj_temperature_logs', SJ_SEALS = 'sj_seals', DRIVERS = 'drivers',
  VEHICLES = 'vehicles', GOODS_RECEIPTS = 'goods_receipts', SHIPMENT_TYPES = 'shipment_types',
  // block 040–049
  PETTY_CASH = 'petty_cash',
  // block 050–059
  POS_SHIFTS = 'pos_shifts', SALES = 'sales', VOID_REFUNDS = 'void_refunds', ONLINE_ORDERS = 'online_orders',
  // block 060–069
  EMPLOYEES = 'employees', WORK_SHIFTS = 'work_shifts', SHIFT_ASSIGNMENTS = 'shift_assignments',
  ATTENDANCE = 'attendance', LEAVE_REQUESTS = 'leave_requests',
  // block 070–079
  ASSETS = 'assets', MAINTENANCE_SCHEDULES = 'maintenance_schedules', MAINTENANCE_JOBS = 'maintenance_jobs',
  SERVICE_HISTORY = 'service_history',
  // block 080–089
  WASTE_RECORDS = 'waste_records', RETURNS = 'returns',
  // block 090–099
  PAYMENT_VERIFICATIONS = 'payment_verifications',
  // block 110–119
  DEVICES = 'devices', BRANCH_NODES = 'branch_nodes', DEVICE_EVENTS = 'device_events',
  DISCOVERED_DEVICES = 'discovered_devices',
  // block 120–129
  OFFLINE_AUTHORIZATIONS = 'offline_authorizations',
}
// NOT SyncEntity (deliberately): stock_balances/stock_movements/journal_* (class D — derived, never on the wire),
// suppliers/supplier_*/purchase_*/po_*/payroll_*/employments/employee_loans/salary_components/sessions/audit_log/
// chart_of_accounts/fiscal_periods/posting_rules/stock_reconciliations/pairing_tokens/sync_* (class X — cloud-only),
// bpjs_configs/pph21_*/employee_tax_profiles (Amendment 1 — class X statutory config, online surfaces only),
// cash_variance_proposals (Amendment 2 — class X: cloud-born at shift-close apply, decided online only),
// device_heartbeats (class T — lossy telemetry channel, not events), and all embedded child tables
// (recipe_lines, *_lines, sale_payments — they ride inside their parent's payload).
export enum NotificationChannel { IN_APP = 'in_app', EMAIL = 'email', WHATSAPP = 'whatsapp' }  // D-03
export enum OutboxStatus { PENDING = 'pending', SENT = 'sent', FAILED = 'failed' }
export enum ReconciliationTier { DEVICE = 'device', NODE = 'node', CLOUD = 'cloud' }
export enum OfflineAuthOutcome {                  // three-valued + pending (SYNC-PROTOCOL §7.4)
  PENDING_VERIFICATION = 'pending_verification', VERIFIED = 'verified',
  FAILED = 'failed', UNPROVABLE = 'unprovable',
}
export enum OfflineAuthVerdict { UPHELD = 'upheld', REJECTED = 'rejected' }                    // finance decision (§7.5)
```

---

## 3. RBAC matrix (→ `packages/shared/src/rbac.ts` verbatim)

Roles (PRD §6.2) + `driver` (added by D-14 — see Appendix A-2). Column keys: **OWN**=`owner`, **MGR**=`manager`, **FIN**=`finance`, **KGD**=`kepala_gudang`, **SPV**=`supervisor` (Supervisor Cabang), **LDR**=`leader_outlet` (Leader/Staff Outlet), **KSR**=`kasir`, **HRA**=`hr_admin`, **DRV**=`driver`.

Rules of use:
- `PermissionsGuard` checks the key; **RLS additionally scopes rows by location** — a ✓ never grants cross-location access for scoped roles (KGD/SPV/LDR/KSR/DRV act only within their `user_locations`).
- Approval keys authorize *acting on the step whose `approver_role` matches*; the engine enforces step order (§5).
- Device-token endpoints (register/heartbeat/sync push/pull) authenticate with the device JWT, not user permission keys.
- ✓ = allowed, `·` = denied (403).

| Permission key | OWN | MGR | FIN | KGD | SPV | LDR | KSR | HRA | DRV |
|---|---|---|---|---|---|---|---|---|---|
| **auth / users / admin** | | | | | | | | | |
| `auth.pin.set` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `auth.offline_credential.mint` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| `user.read` | ✓ | ✓ | ✓ | · | · | · | · | ✓ | · |
| `user.create` | ✓ | ✓ | · | · | · | · | · | · | · |
| `user.update` | ✓ | ✓ | · | · | · | · | · | · | · |
| `user.deactivate` | ✓ | ✓ | · | · | · | · | · | · | · |
| `user.role.assign` | ✓ | ✓ | · | · | · | · | · | · | · |
| `user.location.assign` | ✓ | ✓ | · | · | · | · | · | · | · |
| `user.password.reset` | ✓ | ✓ | · | · | · | · | · | · | · |
| `audit.read` | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| `settings.read` | ✓ | ✓ | ✓ | ✓ | · | · | · | ✓ | · |
| `settings.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `settings.approval_chain.manage` | ✓ | · | · | · | · | · | · | · | · |
| **location / master data** | | | | | | | | | |
| `location.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `location.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `storage_area.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `item.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| `item.manage` | ✓ | ✓ | · | ✓ | · | · | · | · | · |
| `unit.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `product.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| `product.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `recipe.read` | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · |
| `recipe.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| **supplier (FR-SUP-06 role lock)** | | | | | | | | | |
| `supplier.read` | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · |
| `supplier.directory.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| `supplier.manage` | ✓ | ✓ | · | ✓ | · | · | · | · | · |
| `supplier.price.read` | ✓ | ✓ | ✓ | ✓ | · | · | · | · | · |
| `supplier.price.manage` | ✓ | ✓ | · | ✓ | · | · | · | · | · |
| **inventory** | | | | | | | | | |
| `inventory.balance.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · |
| `inventory.movement.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| `inventory.minstock.manage` | ✓ | ✓ | · | ✓ | · | · | · | · | · |
| `inventory.area_transfer.create` | · | · | · | ✓ | ✓ | ✓ | · | · | · |
| `inventory.suggestion.read` | ✓ | ✓ | · | ✓ | ✓ | ✓ | · | · | · |
| **stock opname** | | | | | | | | | |
| `opname.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| `opname.create` | · | · | · | ✓ | ✓ | ✓ | · | · | · |
| `opname.submit` | · | · | · | ✓ | ✓ | ✓ | · | · | · |
| `opname.approve` | ✓ | ✓ | · | ✓ | ✓ | · | · | · | · |
| **replenishment** | | | | | | | | | |
| `replenishment.read` | ✓ | ✓ | · | ✓ | ✓ | ✓ | · | · | · |
| `replenishment.create` | · | · | · | · | ✓ | ✓ | · | · | · |
| `replenishment.submit` | · | · | · | · | ✓ | ✓ | · | · | · |
| `replenishment.approve.supervisor` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| `replenishment.approve.warehouse` | ✓ | ✓ | · | ✓ | · | · | · | · | · |
| `replenishment.amend` | ✓ | ✓ | · | ✓ | ✓ | · | · | · | · |
| **delivery / surat jalan** | | | | | | | | | |
| `delivery.read` | ✓ | ✓ | · | ✓ | ✓ | ✓ | · | · | ✓ |
| `delivery.sj.create` | · | · | · | ✓ | · | · | · | · | · |
| `delivery.sj.dispatch` | · | · | · | ✓ | · | · | · | · | · |
| `delivery.sj.cancel` | · | ✓ | · | ✓ | · | · | · | · | · |
| `delivery.drop.execute` | · | · | · | ✓ | · | · | · | · | ✓ |
| `delivery.receive` | · | · | · | · | ✓ | ✓ | · | · | · |
| `delivery.master.manage` | ✓ | ✓ | · | ✓ | · | · | · | · | · |
| **purchasing / petty cash** | | | | | | | | | |
| `purchasing.read` | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · | · |
| `purchasing.pr.create` | · | · | · | ✓ | ✓ | · | · | · | · |
| `purchasing.pr.approve` | ✓ | ✓ | · | · | · | · | · | · | · |
| `purchasing.po.create` | · | ✓ | · | ✓ | · | · | · | · | · |
| `purchasing.po.approve` | ✓ | ✓ | · | · | · | · | · | · | · |
| `purchasing.po.receive` | · | · | · | ✓ | · | ✓ | · | · | · |
| `purchasing.po.close` | · | · | ✓ | · | · | · | · | · | · |
| `pettycash.read` | ✓ | ✓ | ✓ | · | ✓ | ✓ | · | · | · |
| `pettycash.create` | · | · | · | · | ✓ | ✓ | · | · | · |
| `pettycash.verify` | · | ✓ | ✓ | · | · | · | · | · | · |
| **waste / returns** | | | | | | | | | |
| `waste.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| `waste.create` | · | · | · | ✓ | ✓ | ✓ | · | · | · |
| `waste.approve` | ✓ | ✓ | · | ✓ | ✓ | · | · | · | · |
| `return.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| `return.create` | · | · | · | ✓ | ✓ | ✓ | · | · | · |
| `return.approve` | ✓ | ✓ | · | ✓ | ✓ | · | · | · | · |
| `return.ship` | · | · | · | ✓ | ✓ | ✓ | · | · | · |
| `return.receive` | · | · | · | ✓ | · | · | · | · | · |
| **POS** | | | | | | | | | |
| `pos.catalog.read` | ✓ | ✓ | · | · | ✓ | ✓ | ✓ | · | · |
| `pos.shift.open` | · | · | · | · | ✓ | · | ✓ | · | · |
| `pos.shift.close` | · | · | · | · | ✓ | · | ✓ | · | · |
| `pos.sale.create` | · | · | · | · | ✓ | · | ✓ | · | · |
| `pos.sale.read` | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | · | · |
| `pos.void.request` | · | · | · | · | ✓ | · | ✓ | · | · |
| `pos.void.approve` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| `pos.online_order.record` | · | · | · | · | ✓ | ✓ | ✓ | · | · |
| `pos.online_order.read` | ✓ | ✓ | ✓ | · | ✓ | ✓ | ✓ | · | · |
| `pos.daily_stock.read` | ✓ | ✓ | · | ✓ | ✓ | ✓ | ✓ | · | · |
| `pos.cash_variance.read` | ✓ | ✓ | ✓ | · | ✓ | · | · | ✓ | · |
| `pos.cash_variance.approve` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| **HR** | | | | | | | | | |
| `hr.attendance.check` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `hr.attendance.read` | ✓ | ✓ | · | · | ✓ | · | · | ✓ | · |
| `hr.attendance.correct` | · | · | · | · | · | · | · | ✓ | · |
| `hr.shift.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `hr.shift.manage` | · | ✓ | · | · | ✓ | · | · | ✓ | · |
| `hr.employee.read` | ✓ | ✓ | ✓ | · | ✓ | · | · | ✓ | · |
| `hr.employee.manage` | ✓ | ✓ | · | · | · | · | · | ✓ | · |
| `hr.leave.request` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `hr.leave.approve` | ✓ | ✓ | · | · | ✓ | · | · | ✓ | · |
| `hr.leave.read` | ✓ | ✓ | · | · | ✓ | · | · | ✓ | · |
| **payroll** | | | | | | | | | |
| `payroll.read` | ✓ | ✓ | ✓ | · | · | · | · | ✓ | · |
| `payroll.component.manage` | ✓ | · | ✓ | · | · | · | · | ✓ | · |
| `payroll.run.calculate` | · | · | · | · | · | · | · | ✓ | · |
| `payroll.run.submit` | · | · | · | · | · | · | · | ✓ | · |
| `payroll.run.approve` | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| `payroll.run.pay` | ✓ | · | ✓ | · | · | · | · | · | · |
| `payroll.slip.send` | · | · | · | · | · | · | · | ✓ | · |
| `payroll.slip.read.own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `payroll.loan.manage` | · | · | ✓ | · | · | · | · | ✓ | · |
| `payroll.loan.approve` | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| `payroll.statutory.read` | ✓ | ✓ | ✓ | · | · | · | · | ✓ | · |
| `payroll.statutory.config` | · | · | ✓ | · | · | · | · | ✓ | · |
| `payroll.statutory.enable` | ✓ | ✓ | · | · | · | · | · | · | · |
| **assets (PMS)** | | | | | | | | | |
| `asset.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · | · | · |
| `asset.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `asset.schedule.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `asset.job.execute` | · | ✓ | · | ✓ | ✓ | ✓ | · | · | · |
| `asset.job.verify` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| **accounting / payments** | | | | | | | | | |
| `accounting.coa.read` | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| `accounting.coa.manage` | ✓ | · | ✓ | · | · | · | · | · | · |
| `accounting.journal.read` | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| `accounting.journal.post` | · | · | ✓ | · | · | · | · | · | · |
| `accounting.journal.reverse` | · | · | ✓ | · | · | · | · | · | · |
| `accounting.period.close` | ✓ | · | ✓ | · | · | · | · | · | · |
| `accounting.report.read` | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| `payment.read` | ✓ | ✓ | ✓ | · | · | · | · | · | · |
| `payment.proof.upload` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | · |
| `payment.verify` | · | · | ✓ | · | · | · | · | · | · |
| `payment.pay` | ✓ | · | ✓ | · | · | · | · | · | · |
| `payment.reject` | · | · | ✓ | · | · | · | · | · | · |
| **dashboard / reports** | | | | | | | | | |
| `dashboard.view` | ✓ | ✓ | · | · | · | · | · | · | · |
| `dashboard.outlet.view` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| `report.sales.read` | ✓ | ✓ | ✓ | · | ✓ | · | · | · | · |
| `report.logistics.read` | ✓ | ✓ | · | ✓ | · | · | · | · | · |
| `report.hr.read` | ✓ | ✓ | · | · | · | · | · | ✓ | · |
| `report.export` | ✓ | ✓ | ✓ | ✓ | · | · | · | ✓ | · |
| **devices / topology / sync** | | | | | | | | | |
| `device.read` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| `device.pair` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| `device.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `node.read` | ✓ | ✓ | · | · | · | · | · | · | · |
| `node.manage` | ✓ | ✓ | · | · | · | · | · | · | · |
| `topology.read` | ✓ | ✓ | · | · | · | · | · | · | · |
| `sync.status.read` | ✓ | ✓ | · | · | ✓ | · | · | · | · |
| `sync.conflict.resolve` | ✓ | ✓ | · | · | · | · | · | · | · |
| `sync.exception.review` | ✓ | · | ✓ | · | · | · | · | · | · |
| **kernel** | | | | | | | | | |
| `notification.read.own` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `attachment.upload` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

**137 permission keys** (131 base + 6 from Amendments 1–3). APR mapping: APR-01→`pos.sale.create`(KSR); APR-02→`pos.void.approve`+`replenishment.approve.supervisor`(SPV); APR-03→`replenishment.create`(LDR); APR-04→`delivery.sj.*`(KGD); APR-05→`payment.verify`/`payment.pay`(FIN); APR-06→`opname.approve`/`waste.approve`/`replenishment.approve.warehouse`(KGD); APR-07→Manager ✓s bounded by approval thresholds (§5 amounts); APR-08→Owner report access + top approval steps.

---

## 4. API endpoint tables (all 23 modules + kernel)

### 4.0 Conventions & kernel endpoints

- Base types (§0): `Money`, `Qty`, `Temp` are decimal strings; `UUID`, `ISODate` (`YYYY-MM-DD`), `ISODateTime` (ISO-8601 UTC).
- Auth: every endpoint requires a Bearer user JWT unless marked **(public)** or **(device-token)**. Location-scoped queries default to the caller's allowed locations; explicit `locationId` outside scope → 403.
- List endpoints: `Paginated<T>` + common filters shown per row. Mutations return the full updated resource unless noted.
- **Offline-first surfaces (F02/F04/F11/F13) do not call these REST endpoints to mutate** — they enqueue sync events (SYNC-PROTOCOL §2.2); the cloud applier invokes the same module services. The REST mutation endpoints below are the online path (laptop surfaces), the test surface, and they emit the equivalent sync event themselves (collision rule 6). Read endpoints serve all surfaces when online.
- **Stock writes**: modules never touch `stock_balances`/`stock_movements` — they call `StockLedgerService.post(tx, movements, mode)` with `mode='strict'` (interactive: reject on negative) or `mode='fact'` (sync apply: post + reconciliation exception on negative) per SYNC-PROTOCOL §5.2-C5.

Kernel endpoints (owned by W2-C, not a numbered module):

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/notifications` | `notification.read.own` | `?unreadOnly=&page=` | `Paginated<{id:UUID; type:string; title:string; body:string; payload:object; readAt:ISODateTime\|null; createdAt:ISODateTime}>` | D-03 |
| POST | `/api/notifications/:id/read` | `notification.read.own` | – | `{id:UUID; readAt:ISODateTime}` | D-03 |
| POST | `/api/notifications/read-all` | `notification.read.own` | – | `{updated:number}` | D-03 |
| POST | `/api/attachments/presign` | `attachment.upload` | `{fileName:string; mimeType:string; sizeBytes:number; kind:string; entityType?:string; entityId?:UUID}` | `{attachmentId:UUID; uploadUrl:string; objectKey:string; expiresAt:ISODateTime}` | NFR-09 |
| POST | `/api/attachments/:id/confirm` | `attachment.upload` | `{sha256:string}` | `Attachment` (`{id, fileName, mimeType, sizeBytes, kind, entityType, entityId, url}`) | NFR-09 |
| GET | `/api/attachments/:id/url` | (any authenticated; entity-scope checked) | – | `{url:string; expiresAt:ISODateTime}` (presigned GET) | NFR-09 |
| GET | `/api/audit` | `audit.read` | `?entityType=&entityId=&userId=&module=&locationId=&from=&to=&page=` | `Paginated<AuditRow>` where `AuditRow = {id:UUID; userId:UUID; userName:string; roleKey:string; module:string; action:string; entityType:string; entityId:UUID; beforeValue:object\|null; afterValue:object\|null; reason:string\|null; offlineAuthorized:boolean; occurredAt:ISODateTime}` | FR-AUDIT-01/02 |
| GET | `/api/approvals/pending` | (any; filtered to caller's role+locations) | `?documentType=&page=` | `Paginated<{approvalId:UUID; documentType:string; documentId:UUID; documentNumber:string; amount:Money\|null; locationId:UUID; locationName:string; requestedBy:string; requestedAt:ISODateTime; stepNo:number; summary:object}>` | SCOPE-IN-10 |
| GET | `/api/approvals/:documentType/:documentId` | (any; RLS-scoped) | – | `ApprovalDetail = {approvalId:UUID; state:ApprovalState; amount:Money\|null; steps:{stepNo:number; approverRole:string; state:ApprovalStepState; actedBy:string\|null; actedAt:ISODateTime\|null; reason:string\|null; offlineAuthorized:boolean; reverificationStatus:ReverificationStatus\|null}[]}` | FR-LOG-05 |

Approve/reject/amend actions are exposed **per document type** on the owning module (`/api/replenishment/:id/approve` etc.) so permissions and side effects stay module-local; all of them delegate to the kernel `ApprovalService` (D-08).

### 4.1 M01 `auth`

```ts
interface LoginRes { accessToken: string; refreshToken: string; user: Me }
interface Me { id: UUID; username: string; name: string; roleKey: string; permissions: string[];
               locations: {id: UUID; code: string; name: string; type: 'warehouse'|'outlet'; city: string}[];
               employeeId: UUID | null; mustSetPin: boolean }
interface OfflineCredentialRes {                 // SYNC-PROTOCOL §7.2 (v1.4) — credential token + registry row
  credentialId: UUID;
  token: string;  // unsigned compact token, base64url(JSON.stringify(claims)) — opaque to FE;
                  // see SYNC-PROTOCOL §7.2 (v1.4)
  scopes: Record<string, {maxIdr?: Money}>; expiresAt: ISODateTime }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| POST | `/api/auth/login` | (public) | `{username:string; password:string; deviceId?:UUID}` | `LoginRes` — response additionally includes `offlineCredentials: OfflineCredentialRes[]` when the user holds offline-eligible scopes (§7.6) | FR-POS-02, NFR-03 |
| POST | `/api/auth/refresh` | (public) | `{refreshToken:string}` | `{accessToken:string; refreshToken:string}` | NFR-03 |
| POST | `/api/auth/logout` | (any) | `{refreshToken:string}` | `{ok:true}` | NFR-03 |
| GET | `/api/auth/me` | (any) | – | `Me` | NFR-03 |
| POST | `/api/auth/pin` | `auth.pin.set` | `{currentPassword:string; pin:string}` (6 digits) | `{ok:true}` | FR-POS-03, D-17 |
| POST | `/api/auth/pin/verify` | (any) | `{userId:UUID; pin:string; context:'pos_override'\|'approval'}` | `{ok:true; verifierToken:string; expiresAt:ISODateTime}` (5-min single-purpose token) | FR-POS-03 |
| POST | `/api/auth/offline-credential/refresh` | `auth.offline_credential.mint` | `{deviceId:UUID}` | `OfflineCredentialRes` | D-17 |
| POST | `/api/auth/offline-credential/:credentialId/revoke` | `auth.offline_credential.mint` (own) or `user.update` | `{reason:string}` | `{ok:true}` (CRL event emitted) | D-17 |

### 4.2 M02 `users`

```ts
interface UserRow { id: UUID; username: string; name: string; email: string|null; phone: string|null;
                    roleKey: string; roleName: string; locations: {id: UUID; name: string}[];
                    isActive: boolean; lastLoginAt: ISODateTime|null; createdAt: ISODateTime }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/users` | `user.read` | `?q=&roleKey=&locationId=&active=&page=` | `Paginated<UserRow>` | RBAC-01..08 |
| GET | `/api/users/:id` | `user.read` | – | `UserRow` | RBAC |
| POST | `/api/users` | `user.create` | `{username; name; email?; phone?; password; roleKey; locationIds:UUID[]}` | `UserRow` | RBAC, FR-POS-02 |
| PATCH | `/api/users/:id` | `user.update` | `{name?; email?; phone?}` | `UserRow` | RBAC |
| PUT | `/api/users/:id/role` | `user.role.assign` | `{roleKey:string}` — cannot assign a role ranked ≥ caller's | `UserRow` | RBAC, APR-07/08 |
| PUT | `/api/users/:id/locations` | `user.location.assign` | `{locationIds:UUID[]}` | `UserRow` | D-05 |
| POST | `/api/users/:id/reset-password` | `user.password.reset` | `{newPassword:string}` | `{ok:true}` (revokes sessions) | NFR-03 |
| DELETE | `/api/users/:id` | `user.deactivate` | – | `{id:UUID; deactivated:true}` (revokes sessions + offline credentials) | NFR-03 |
| GET | `/api/roles` | `user.read` | – | `{key:string; name:string; permissions:string[]}[]` | RBAC |

### 4.3 M03 `location` (incl. storage areas, D-15)

```ts
interface Location { id: UUID; code: string; name: string; type: 'warehouse'|'outlet'; city: string;
                     address: string|null; phone: string|null; latitude: string|null; longitude: string|null;
                     geofenceRadiusM: number; isActive: boolean; storageAreaCount: number }
interface StorageArea { id: UUID; locationId: UUID; code: string; name: string; type: StorageAreaType;
                        tempMin: Temp|null; tempMax: Temp|null; sortOrder: number; isActive: boolean }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/locations` | `location.read` | `?type=&city=&active=&page=` | `Paginated<Location>` | D-05 |
| GET | `/api/locations/cities` | `location.read` | – | `string[]` (the 4 cities) | FR-LOG-01 |
| GET | `/api/locations/:id` | `location.read` | – | `Location` | D-05 |
| POST | `/api/locations` | `location.manage` | `{code; name; type; city; address?; phone?; latitude?; longitude?; geofenceRadiusM?}` | `Location` | NFR-05 |
| PATCH | `/api/locations/:id` | `location.manage` | partial of POST body | `Location` | NFR-05 |
| DELETE | `/api/locations/:id` | `location.manage` | – | `{id; deactivated:true}` | NFR-05 |
| GET | `/api/locations/:id/storage-areas` | `location.read` | `?active=` | `StorageArea[]` | D-15 |
| POST | `/api/locations/:id/storage-areas` | `storage_area.manage` | `{code; name; type:StorageAreaType; tempMin?:Temp; tempMax?:Temp; sortOrder?}` | `StorageArea` | D-15 |
| PATCH | `/api/locations/:id/storage-areas/:areaId` | `storage_area.manage` | partial | `StorageArea` | D-15 |
| DELETE | `/api/locations/:id/storage-areas/:areaId` | `storage_area.manage` | – | `{id; deactivated:true}` — rejected `ERR_AREA_HAS_STOCK` if balance ≠ 0 | D-15 |

### 4.4 M04 `item`

```ts
interface Item { id: UUID; sku: string; name: string; categoryId: UUID|null; categoryName: string|null;
                 baseUnit: {id: UUID; code: string}; storageType: 'frozen'|'chilled'|'dry';
                 isSellable: boolean; shelfLifeDays: number|null; tempMin: Temp|null; tempMax: Temp|null;
                 avgCost?: Money; lastPurchaseCost?: Money;   // present only when caller has supplier.price.read
                 barcode: string|null; isActive: boolean }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/items` | `item.read` | `?q=&categoryId=&storageType=&active=&page=` | `Paginated<Item>` (cost fields filtered by `supplier.price.read`) | FR-LOG-06 |
| GET | `/api/items/:id` | `item.read` | – | `Item` | – |
| POST | `/api/items` | `item.manage` | `{sku; name; categoryId?; baseUnitId; storageType; isSellable?; shelfLifeDays?; tempMin?; tempMax?; barcode?}` | `Item` | – |
| PATCH | `/api/items/:id` | `item.manage` | partial | `Item` | – |
| DELETE | `/api/items/:id` | `item.manage` | – | `{id; deactivated:true}` | – |
| GET | `/api/items/categories` | `item.read` | – | `{id:UUID; name:string; parentId:UUID\|null; sortOrder:number}[]` | – |
| POST | `/api/items/categories` | `item.manage` | `{name; parentId?; sortOrder?}` | category | – |
| PATCH | `/api/items/categories/:id` | `item.manage` | partial | category | – |
| GET | `/api/units` | `item.read` | – | `{id:UUID; code:string; name:string}[]` | – |
| POST | `/api/units` | `unit.manage` | `{code; name}` | unit | – |
| GET | `/api/items/:id/conversions` | `item.read` | – | `{id:UUID; fromUnit:string; toUnit:string; factor:string}[]` | – |
| PUT | `/api/items/:id/conversions` | `item.manage` | `{conversions:{fromUnitId:UUID; toUnitId:UUID; factor:string}[]}` | conversions list | – |

### 4.5 M05 `product` (menu + recipes/BOM)

```ts
interface Product { id: UUID; code: string; name: string; category: string; price: Money;
                    photoUrl: string|null; sortOrder: number; isActive: boolean; hasRecipe: boolean;
                    // present (non-empty) only when hasRecipe — the device's offline FR-POS-06 projection seam:
                    // consumed qty per line = line.qty × (qtySold / recipeYieldQty), same ratio-then-multiply
                    // RecipeService.explodeForSale uses server-side. Minimal projection (id+qty+unit only,
                    // no item name/unit code) to keep the precached catalog payload small.
                    recipeYieldQty?: Qty; recipeLines?: CatalogRecipeLine[] }
interface CatalogRecipeLine { itemId: UUID; qty: Qty; unitId: UUID }
interface RecipeLine { itemId: UUID; itemName: string; qty: Qty; unitId: UUID; unitCode: string }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/products` | `product.read` | `?q=&category=&active=&page=` | `Paginated<Product>` | FR-POS-01 |
| GET | `/api/products/:id` | `product.read` | – | `Product` | – |
| POST | `/api/products` | `product.manage` | `{code; name; category; price:Money; photoAttachmentId?; sortOrder?}` | `Product` | – |
| PATCH | `/api/products/:id` | `product.manage` | partial (price change emits `products.price_changed` master event) | `Product` | – |
| DELETE | `/api/products/:id` | `product.manage` | – | `{id; deactivated:true}` | – |
| GET | `/api/products/:id/recipe` | `recipe.read` | – | `{productId:UUID; yieldQty:Qty; lines:RecipeLine[]}` | FR-POS-06 |
| PUT | `/api/products/:id/recipe` | `recipe.manage` | `{yieldQty:Qty; lines:{itemId:UUID; qty:Qty; unitId:UUID}[]}` | recipe | FR-POS-06 |
| GET | `/api/products/categories` | `product.read` | – | `string[]` | – |

### 4.6 M06 `supplier` (FR-SUP-01..06; price data role-locked)

```ts
interface Supplier { id: UUID; code: string; name: string; contactName: string|null; phone: string|null;
                     email: string|null; address: string|null; paymentTermsDays: number;
                     bankName: string|null; bankAccount: string|null; outletVisible: boolean; isActive: boolean }
// Amendment 3: the projected shape outlet roles (SPV/LDR) receive — name/contact ONLY.
// harga beli, termin (paymentTermsDays), bank fields, and purchase history NEVER appear in this shape.
interface SupplierDirectoryEntry { id: UUID; code: string; name: string; contactName: string|null;
                                   phone: string|null; address: string|null }
interface SupplierItem { id: UUID; itemId: UUID; itemName: string; supplierSku: string|null;
                         currentPrice: Money; leadTimeDays: number; isPreferred: boolean }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/suppliers` | `supplier.read` | `?q=&active=&page=` | `Paginated<Supplier>` (full shape; outlet roles get 403 here — their path is `/directory`) | FR-SUP-01/06 |
| GET | `/api/suppliers/directory` | `supplier.directory.read` | `?q=&page=` | `Paginated<SupplierDirectoryEntry>` — only rows with `outlet_visible=true` for SPV/LDR (RLS §1.14); full-permission roles see all rows in the same reduced shape. Powers the petty-cash `storeName` picker (PRD 8.6.1) — `petty_cash.store_name` stays free text (a warung need not be a registered supplier), the directory assists. **Online-only**: suppliers are sync class X (never cached on devices); offline petty cash falls back to free text | FR-SUP-06, 8.6.1, Amendment 3 |
| GET | `/api/suppliers/:id` | `supplier.read` | – | `Supplier` | FR-SUP-01 |
| POST | `/api/suppliers` | `supplier.manage` | `{code; name; contactName?; phone?; email?; address?; paymentTermsDays?; bankName?; bankAccount?; bankAccountName?; outletVisible?:boolean}` | `Supplier` | FR-SUP-01, Amendment 3 |
| PATCH | `/api/suppliers/:id` | `supplier.manage` | partial | `Supplier` | FR-SUP-01 |
| DELETE | `/api/suppliers/:id` | `supplier.manage` | – | `{id; deactivated:true}` | FR-SUP-01 |
| GET | `/api/suppliers/:id/items` | `supplier.price.read` | – | `SupplierItem[]` | FR-SUP-03 |
| PUT | `/api/suppliers/:id/items/:itemId` | `supplier.price.manage` | `{supplierSku?; currentPrice:Money; leadTimeDays?; isPreferred?}` — price change appends `supplier_price_history` | `SupplierItem` | FR-SUP-03/04 |
| DELETE | `/api/suppliers/:id/items/:itemId` | `supplier.price.manage` | – | `{ok:true}` | FR-SUP-03 |
| GET | `/api/suppliers/:id/price-history` | `supplier.price.read` | `?itemId=&page=` | `Paginated<{itemId:UUID; itemName:string; price:Money; effectiveDate:ISODate; source:'manual'\|'po'; recordedBy:string}>` | FR-SUP-04 |
| GET | `/api/suppliers/:id/transactions` | `supplier.read` | `?from=&to=&page=` | `Paginated<{poId:UUID; poNumber:string; orderDate:ISODate; status:string; total:Money; paymentStatus:PaymentStatus\|null}>` | FR-SUP-02/05 |

### 4.7 M07 `inventory` (balances per storage area, movements, min-stock, low stock — FR-LOG-06/07/17..21)

```ts
interface Balance { locationId: UUID; storageAreaId: UUID; storageAreaName: string; storageAreaType: StorageAreaType;
                    itemId: UUID; sku: string; itemName: string; unitCode: string; qtyOnHand: Qty;
                    minQty: Qty|null; belowMin: boolean; value?: Money /* qty × avgCost; needs supplier.price.read */ }
interface Movement { id: UUID; movementType: MovementType; qty: Qty; unitCost?: Money; refType: string; refId: UUID|null;
                     storageAreaName: string; counterpartyLocationName: string|null; actorName: string|null;
                     reason: string|null; occurredAt: ISODateTime }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/inventory/balances` | `inventory.balance.read` | `?locationId=&storageAreaId=&itemId=&belowMin=&q=&page=` | `Paginated<Balance>` | FR-LOG-20, FR-POS-06, D-15 |
| GET | `/api/inventory/summary` | `inventory.balance.read` | `?locationId=` | `{totalItems:number; belowMin:number; stockValue?:Money; byArea:{storageAreaId:UUID; name:string; items:number}[]}` | FR-LOG-20 |
| GET | `/api/inventory/movements` | `inventory.movement.read` | `?locationId=&itemId=&storageAreaId=&movementType=&from=&to=&page=` | `Paginated<Movement>` | FR-LOG-21, FR-SO-04 |
| GET | `/api/inventory/low-stock` | `inventory.balance.read` | `?locationId=` | `{locationId:UUID; itemId:UUID; itemName:string; qtyOnHand:Qty; minQty:Qty; suggestedQty:Qty\|null}[]` | FR-LOG-07/18/20 |
| GET | `/api/inventory/min-stock` | `inventory.balance.read` | `?locationId=&page=` | `Paginated<{id:UUID; locationId:UUID; itemId:UUID; itemName:string; minQty:Qty; reorderQty:Qty\|null; isActive:boolean}>` | FR-LOG-06/17 |
| PUT | `/api/inventory/min-stock` | `inventory.minstock.manage` | `{locationId:UUID; rules:{itemId:UUID; minQty:Qty; reorderQty?:Qty}[]}` (bulk upsert) | updated rules list | FR-LOG-06/17 |
| GET | `/api/inventory/suggestions` | `inventory.suggestion.read` | `?locationId=` | `{itemId:UUID; itemName:string; qtyOnHand:Qty; minQty:Qty; avgDailyUsage:Qty; suggestedQty:Qty; basis:'usage_pattern'\|'reorder_qty'}[]` — usage from `mv_item_usage_daily` (14-day window) | FR-LOG-08/19 |
| POST | `/api/inventory/area-transfer` | `inventory.area_transfer.create` | `{locationId:UUID; itemId:UUID; fromAreaId:UUID; toAreaId:UUID; qty:Qty; reason?:string}` — posts `transfer_out`+`transfer_in` via ledger (strict) | `{ok:true; movements:Movement[]}` | D-15 |
| GET | `/api/inventory/history/:itemId` | `inventory.movement.read` | `?locationId=&days=30` | `{date:ISODate; qtyIn:Qty; qtyOut:Qty; closing:Qty}[]` | FR-LOG-21 |

Low-stock crossing (balance falls below `min_qty` after any ledger post) emits `NotificationService` `low_stock` to LDR/SPV of the location (+KGD for warehouse) — FR-LOG-07/18.

### 4.8 M08 `stock-opname` (FR-SO-01..04; per storage area D-15)

```ts
interface Opname { id: UUID; opnameNumber: string; locationId: UUID; locationName: string;
                   storageAreaId: UUID|null; status: OpnameStatus; countedBy: string; startedAt: ISODateTime;
                   submittedAt: ISODateTime|null; approvedBy: string|null; approvedAt: ISODateTime|null;
                   totalVarianceValue?: Money; lineCount: number; disputedCount: number }
interface OpnameLine { id: UUID; storageAreaId: UUID; storageAreaName: string; itemId: UUID; itemName: string;
                       unitCode: string; systemQty: Qty; countedQty: Qty; diffQty: Qty; varianceReason: string|null;
                       disputed: boolean /* C1 double-count flag */ }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/stock-opname` | `opname.read` | `?locationId=&status=&from=&to=&page=` | `Paginated<Opname>` | FR-SO-01 |
| GET | `/api/stock-opname/:id` | `opname.read` | – | `Opname & {lines: OpnameLine[]}` | FR-SO-02 |
| POST | `/api/stock-opname` | `opname.create` | `{locationId:UUID; storageAreaId?:UUID}` → status `counting`, snapshots `systemQty` per line lazily at count | `Opname` | FR-SO-01 |
| PUT | `/api/stock-opname/:id/lines` | `opname.create` | `{lines:{storageAreaId:UUID; itemId:UUID; countedQty:Qty; varianceReason?:string}[]}` (upsert batch = one storage area) | `OpnameLine[]` | FR-SO-02 |
| POST | `/api/stock-opname/:id/lines/:lineId/resolve` | `opname.approve` | `{chosenEventId:UUID; reason:string}` — resolves a C1 dispute (new event, SYNC-PROTOCOL §5.2) | `OpnameLine` | FR-SO-02 |
| POST | `/api/stock-opname/:id/submit` | `opname.submit` | – → status `submitted`; rejects `ERR_VARIANCE_REASON_REQUIRED` if any `diffQty≠0` lacks a reason; `ERR_DISPUTES_OPEN` if C1 disputes open | `Opname` | FR-SO-02 |
| POST | `/api/stock-opname/:id/approve` | `opname.approve` | `{note?:string}` — **online-only** (never offline, §7.6); creates `stock_adjustments` + posts via ledger + `GUDANG/OUTLET_STOCK_ADJUSTMENT` journal; shortfall attributable → payroll POUT-05 source | `Opname` (status `adjusted`) | FR-SO-03/04 |
| POST | `/api/stock-opname/:id/reject` | `opname.approve` | `{reason:string}` (required) | `Opname` | FR-SO-02/03 |
| DELETE | `/api/stock-opname/:id` | `opname.create` | – (draft/counting only) | `{id; status:'cancelled'}` | – |

### 4.9 M09 `replenishment` (FR-LOG-06..13)

```ts
interface Replenishment { id: UUID; requestNumber: string; locationId: UUID; locationName: string;
                          status: ReplenishmentStatus; source: 'manual'|'auto_suggestion'; requestedBy: string;
                          submittedAt: ISODateTime|null; neededBy: ISODate|null; sjId: UUID|null; sjNumber: string|null;
                          approval: ApprovalDetail|null; lines: ReplenishmentLine[] }
interface ReplenishmentLine { id: UUID; itemId: UUID; itemName: string; unitCode: string;
                              qtyRequested: Qty; qtyApproved: Qty|null; qtyShipped: Qty|null; qtyReceived: Qty|null;
                              amendReason: string|null }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/replenishment` | `replenishment.read` | `?locationId=&status=&from=&to=&page=` | `Paginated<Replenishment>` (without lines) | FR-LOG-11 |
| GET | `/api/replenishment/:id` | `replenishment.read` | – | `Replenishment` | FR-LOG-11/12 |
| GET | `/api/replenishment/:id/history` | `replenishment.read` | – | `AuditRow[]` (all status + qty changes) | FR-LOG-12 |
| POST | `/api/replenishment` | `replenishment.create` | `{locationId:UUID; neededBy?:ISODate; source?:'manual'\|'auto_suggestion'; lines:{itemId:UUID; qtyRequested:Qty; unitId:UUID}[]}` | `Replenishment` (draft) | FR-LOG-09, APR-03 |
| PATCH | `/api/replenishment/:id` | `replenishment.create` | `{lines?; neededBy?}` (draft only) | `Replenishment` | FR-LOG-09 |
| POST | `/api/replenishment/:id/submit` | `replenishment.submit` | – → `submitted`, approval chain starts (§5.1) | `Replenishment` | FR-LOG-10 |
| POST | `/api/replenishment/:id/approve` | step 1: `replenishment.approve.supervisor` · step 2: `replenishment.approve.warehouse` | `{note?:string; amendments?:{lineId:UUID; qtyApproved:Qty; reason:string}[]}` — amendments require `replenishment.amend`; reason REQUIRED per amended line | `Replenishment` | FR-LOG-05/10/13 |
| POST | `/api/replenishment/:id/reject` | same keys as approve (current step) | `{reason:string}` (required) | `Replenishment` (`rejected`) | FR-LOG-13 |
| POST | `/api/replenishment/:id/process` | `replenishment.approve.warehouse` | – → `processing` (picking starts) | `Replenishment` | FR-LOG-10 |
| DELETE | `/api/replenishment/:id` | `replenishment.create` | – (draft only) | `{id; deleted:true}` | – |
| GET | `/api/replenishment/queue/warehouse` | `replenishment.approve.warehouse` | `?status=awaiting_approval\|approved\|processing` | `Paginated<Replenishment>` — the warehouse work queue; `approved`+`processing` feed SJ building (M10) | FR-LOG-04/10 |

Status walk (enforced by engine): `draft→submitted→awaiting_approval→approved→processing→shipped→received→completed`, `rejected` from either approval step (§5.1). `shipped/received/completed` are driven by M10 events, never set directly.

### 4.10 M10 `delivery` — Surat Jalan, drops, cold chain, receiving (D-14; FR-LOG-01..05, 08, 14..16)

```ts
interface SuratJalan { id: UUID; sjNumber: string; originLocationId: UUID; shipmentType: 'frozen'|'dry';
                       driver: {id: UUID; name: string; phone: string|null}; vehicle: {id: UUID; plateNumber: string; hasFreezer: boolean};
                       status: SuratJalanStatus; plannedDate: ISODate; dispatchedAt: ISODateTime|null; completedAt: ISODateTime|null;
                       drops: Drop[]; seals: Seal[]; tempLogs: TempLog[]; createdBy: string }
interface Drop { id: UUID; dropSeq: number; locationId: UUID; locationName: string; city: string;
                 replenishmentRequestId: UUID|null; status: DropStatus; departedAt: ISODateTime|null; arrivedAt: ISODateTime|null;
                 receivedBy: string|null; receivedAt: ISODateTime|null; signatureUrl: string|null; photoUrls: string[];
                 discrepancyNotes: string|null; lines: DropLine[] }
interface DropLine { id: UUID; itemId: UUID; itemName: string; unitCode: string; storageType: 'frozen'|'chilled'|'dry';
                     qty: Qty; qtyReceived: Qty|null; receivedStorageAreaId: UUID|null; discrepancyReason: string|null }
interface TempLog { id: UUID; dropId: UUID|null; stage: 'load'|'depart'|'arrive'; tempC: Temp; isBreach: boolean;
                    loggedBy: string; loggedAt: ISODateTime }
interface Seal { id: UUID; dropId: UUID|null; sealNumber: string; status: SealStatus; checkedBy: string|null; checkedAt: ISODateTime|null }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/delivery/surat-jalan` | `delivery.read` | `?status=&date=&locationId=&driverId=&page=` | `Paginated<SuratJalan>` (without lines) | FR-LOG-01/03 |
| GET | `/api/delivery/surat-jalan/:id` | `delivery.read` | – | `SuratJalan` | FR-LOG-01 |
| POST | `/api/delivery/surat-jalan` | `delivery.sj.create` | `{shipmentType:'frozen'\|'dry'; driverId:UUID; vehicleId:UUID; plannedDate:ISODate; drops:{locationId:UUID; replenishmentRequestId?:UUID; lines:{itemId:UUID; qty:Qty; unitId:UUID; requestLineId?:UUID}[]}[]; notes?}` — frozen SJ requires `vehicle.hasFreezer`; frozen+dry items may not mix (FR-LOG-02, `ERR_SHIPMENT_TYPE_MIX`) | `SuratJalan` (draft; SJ number issued) | FR-LOG-01/02/03, APR-04 |
| PATCH | `/api/delivery/surat-jalan/:id` | `delivery.sj.create` | drops/lines/driver/vehicle edits (draft/ready only) | `SuratJalan` | FR-LOG-05 |
| POST | `/api/delivery/surat-jalan/:id/ready` | `delivery.sj.create` | – → `ready` (picking done; linked requests → `processing`) | `SuratJalan` | FR-LOG-10 |
| POST | `/api/delivery/surat-jalan/:id/load` | `delivery.sj.dispatch` | `{seals:{sealNumber:string}[]; tempC?:Temp}` — temp REQUIRED for frozen (`load` stage log) | `SuratJalan` (`loading`) | D-14 |
| POST | `/api/delivery/surat-jalan/:id/dispatch` | `delivery.sj.dispatch` | – → `in_transit`; posts `transfer_out` per line via ledger (strict); journal `GUDANG_GOODS_OUT_TO_OUTLET`; linked requests → `shipped` | `SuratJalan` | FR-LOG-16, JGUD-03 |
| POST | `/api/delivery/surat-jalan/:id/cancel` | `delivery.sj.cancel` | `{reason:string}` (draft/ready/loading only) | `SuratJalan` | FR-LOG-05 |
| POST | `/api/delivery/drops/:dropId/depart` | `delivery.drop.execute` | `{at?:ISODateTime; tempC?:Temp}` (frozen: temp required, `depart` stage) | `Drop` | D-14 |
| POST | `/api/delivery/drops/:dropId/arrive` | `delivery.drop.execute` | `{at?:ISODateTime; tempC:Temp /* frozen */; sealCheck?:{sealId:UUID; status:'verified_intact'\|'broken'; notes?}}` | `Drop` | D-14, FR-LOG-14 |
| POST | `/api/delivery/drops/:dropId/receive` | `delivery.receive` | `{lines:{lineId:UUID; qtyReceived:Qty; receivedStorageAreaId:UUID; discrepancyReason?:string}[]; photoAttachmentIds:UUID[] /* ≥1 wajib */; signatureAttachmentId:UUID; tempC?:Temp; discrepancyNotes?}` — posts `transfer_in` per area (fact mode), journal `OUTLET_GOODS_IN_FROM_WAREHOUSE`, request → `received`; discrepancy is data (C2 handles duplicates) | `Drop` (`completed` or `completed_discrepancy`) | FR-LOG-14/15/16, JOUT-01 |
| POST | `/api/delivery/drops/:dropId/fail` | `delivery.drop.execute` | `{reason:string}` (outlet closed etc.; stock returns to warehouse on SJ completion) | `Drop` | D-14 |
| POST | `/api/delivery/temperature-logs` | `delivery.drop.execute` | `{sjId:UUID; dropId?:UUID; stage:'load'\|'depart'\|'arrive'; tempC:Temp}` — breach ⇒ `cold_chain_breach` notification to KGD/MGR/OWN | `TempLog` | D-14, OBJ-03 |
| GET | `/api/delivery/my-jobs` | `delivery.drop.execute` | `?date=` | `SuratJalan[]` (driver's assigned SJs, full detail — F13 pre-departure cache) | D-14 |
| GET | `/api/delivery/recap/daily` | `report.logistics.read` | `?date=` | `{date:ISODate; sjCount:number; dropCount:number; byCity:{city:string; outlets:number; items:{itemId:UUID; itemName:string; qty:Qty}[]}[]; frozenSjCount:number; drySjCount:number}` | FR-LOG-04/08 |
| GET | `/api/delivery/drivers` | `delivery.read` | `?active=` | `{id:UUID; name:string; phone:string\|null; licenseNumber:string\|null; userId:UUID\|null; isActive:boolean}[]` | D-14 |
| POST | `/api/delivery/drivers` | `delivery.master.manage` | `{name; phone?; licenseNumber?; employeeId?; userId?}` | driver | D-14 |
| PATCH | `/api/delivery/drivers/:id` | `delivery.master.manage` | partial | driver | D-14 |
| GET | `/api/delivery/vehicles` | `delivery.read` | `?active=` | `{id:UUID; plateNumber:string; type:string; hasFreezer:boolean; isActive:boolean}[]` | D-14 |
| POST | `/api/delivery/vehicles` | `delivery.master.manage` | `{plateNumber; type; brand?; model?; hasFreezer?}` | vehicle | D-14 |
| PATCH | `/api/delivery/vehicles/:id` | `delivery.master.manage` | partial | vehicle | D-14 |

SJ auto-completes (`completed`) when every drop is terminal; linked requests flip `received→completed` when all lines reconciled.

### 4.11 M11 `purchasing` (FR-PO-01..04, F-PUR-01..05, petty cash 8.6.1)

```ts
interface PurchaseOrder { id: UUID; poNumber: string; supplierId: UUID; supplierName: string; locationId: UUID;
                          status: PurchaseOrderStatus; orderDate: ISODate; expectedDate: ISODate|null;
                          paymentTermsDays: number; subtotal: Money; tax: Money; total: Money;
                          approval: ApprovalDetail|null; paymentStatus: PaymentStatus|null;
                          lines: {id: UUID; itemId: UUID; itemName: string; unitCode: string; qtyOrdered: Qty;
                                  unitPrice: Money; lineTotal: Money; qtyReceived: Qty}[] }
interface PettyCash { id: UUID; pcNumber: string; locationId: UUID; purchasedBy: string; purchaseDate: ISODate;
                      storeName: string; totalAmount: Money; status: PettyCashStatus; verifiedBy: string|null;
                      photoUrls: string[]; lines: {description: string; itemId: UUID|null; qty: Qty|null;
                      amount: Money; expenseCategory: string}[] }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/purchasing/requests` | `purchasing.read` | `?locationId=&status=&page=` | `Paginated<{id; prNumber; locationName; status; requestedBy; neededBy; lineCount}>` | F-PUR-01 |
| GET | `/api/purchasing/requests/:id` | `purchasing.read` | – | PR with lines + `ApprovalDetail` | F-PUR-01 |
| POST | `/api/purchasing/requests` | `purchasing.pr.create` | `{locationId:UUID; neededBy?:ISODate; lines:{itemId:UUID; qty:Qty; unitId:UUID; estPrice?:Money; suggestedSupplierId?:UUID}[]}` | PR (draft) | F-PUR-01, FR-LOG-19 |
| POST | `/api/purchasing/requests/:id/submit` | `purchasing.pr.create` | – | PR (`submitted`) | F-PUR-01 |
| POST | `/api/purchasing/requests/:id/approve` | `purchasing.pr.approve` | `{note?}` | PR (`approved`) | APR-07 |
| POST | `/api/purchasing/requests/:id/reject` | `purchasing.pr.approve` | `{reason:string}` | PR (`rejected`) | FR-LOG-13 pattern |
| GET | `/api/purchasing/orders` | `purchasing.read` | `?supplierId=&status=&from=&to=&page=` | `Paginated<PurchaseOrder>` (no lines) | FR-PO-01/02 |
| GET | `/api/purchasing/orders/:id` | `purchasing.read` | – | `PurchaseOrder` | FR-PO-01 |
| POST | `/api/purchasing/orders` | `purchasing.po.create` | `{supplierId:UUID; locationId:UUID; prId?:UUID; orderDate:ISODate; expectedDate?:ISODate; lines:{itemId:UUID; qtyOrdered:Qty; unitId:UUID; unitPrice:Money}[]; notes?}` — prices need `supplier.price.read` | `PurchaseOrder` (draft) | FR-PO-01 |
| PATCH | `/api/purchasing/orders/:id` | `purchasing.po.create` | partial (draft only) | `PurchaseOrder` | FR-PO-01 |
| POST | `/api/purchasing/orders/:id/submit` | `purchasing.po.create` | – → `pending_approval` (chain per §5.3) | `PurchaseOrder` | APR-07 |
| POST | `/api/purchasing/orders/:id/approve` | `purchasing.po.approve` | `{note?}` (threshold steps §5.3) | `PurchaseOrder` (`approved`) | APR-07/08 |
| POST | `/api/purchasing/orders/:id/reject` | `purchasing.po.approve` | `{reason:string}` | `PurchaseOrder` | FR-LOG-13 pattern |
| POST | `/api/purchasing/orders/:id/issue` | `purchasing.po.create` | – → `issued` (sent to supplier; PO PDF W5-05) | `PurchaseOrder` | FR-PO-02 |
| POST | `/api/purchasing/orders/:id/receipts` | `purchasing.po.receive` | `{lines:{poLineId:UUID; qtyReceived:Qty; storageAreaId:UUID; conditionNotes?}[]; photoAttachmentIds:UUID[] /* wajib FR-PO-04 */; notes?}` — posts `purchase_in` (strict), updates `qty_received`, avg cost, price history; journal `GUDANG_PURCHASE`; creates `payment_verifications` row (pending) | `PurchaseOrder` (`partially_received`/`received`) | FR-PO-02/03/04, JGUD-01 |
| POST | `/api/purchasing/orders/:id/cancel` | `purchasing.po.approve` | `{reason:string}` | `PurchaseOrder` | – |
| POST | `/api/purchasing/orders/:id/close` | `purchasing.po.close` | – (requires payment `paid`) | `PurchaseOrder` (`closed`) | FR-ACCT-04 |
| GET | `/api/purchasing/petty-cash` | `pettycash.read` | `?locationId=&status=&from=&to=&page=` | `Paginated<PettyCash>` | F-PUR-03 |
| POST | `/api/purchasing/petty-cash` | `pettycash.create` | `{locationId:UUID; purchaseDate:ISODate; storeName:string; lines:{description:string; itemId?:UUID; storageAreaId?:UUID; qty?:Qty; amount:Money; expenseCategory:string}[]; paymentProofAttachmentId:UUID; goodsPhotoAttachmentId:UUID}` (both photos wajib) | `PettyCash` (pending) | F-PUR-03, 8.6.1 |
| POST | `/api/purchasing/petty-cash/:id/verify` | `pettycash.verify` | `{note?}` — stockable lines post `purchase_in`; journal `OUTLET_PETTY_CASH`/`OUTLET_DIRECT_PURCHASE`; `payment_verifications` row created (FR-ACCT-04) | `PettyCash` (verified) | 8.6.1, JOUT-07/08 |
| POST | `/api/purchasing/petty-cash/:id/reject` | `pettycash.verify` | `{reason:string}` | `PettyCash` (rejected) | 8.6.1 |

### 4.12 M12 `waste-return` (FR-WST-01..04, both retur directions)

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/waste` | `waste.read` | `?locationId=&status=&reason=&from=&to=&page=` | `Paginated<{id; wasteNumber; batchId; locationName; storageAreaName; itemName; qty:Qty; unitCost:Money; reason:WasteReason; status:WasteStatus; reportedBy; photoUrls:string[]; occurredAt}>` | FR-WST-01/02 |
| POST | `/api/waste` | `waste.create` | `{locationId:UUID; items:{storageAreaId:UUID; itemId:UUID; qty:Qty; reason:WasteReason; reasonDetail?:string}[]; photoAttachmentIds:UUID[] /* ≥1 wajib */}` → one batch, N records, status pending | waste batch | FR-WST-01 |
| POST | `/api/waste/:batchId/approve` | `waste.approve` | `{note?}` — outlet step offline-eligible (§7.6); posts `waste_out` (fact mode), journal `GUDANG_WASTE`/`OUTLET_WASTE` | batch (approved) | FR-WST-02/04, JGUD-05, JOUT-04 |
| POST | `/api/waste/:batchId/reject` | `waste.approve` | `{reason:string}` | batch (rejected) | FR-WST-02 |
| GET | `/api/returns` | `return.read` | `?direction=&locationId=&status=&page=` | `Paginated<Return>` where `Return = {id; returnNumber; direction:ReturnDirection; fromLocationName; toLocationName\|supplierName; status:ReturnStatus; requestedBy; approvedBy; shippedAt; receivedAt; lines:{itemId; itemName; qty:Qty; condition:ReturnCondition; reason:string; qtyReceived:Qty\|null}[]}` | FR-WST-02 |
| GET | `/api/returns/:id` | `return.read` | – | `Return & {approval: ApprovalDetail|null; proofUrls: {shipped:string[]; received:string[]}}` | FR-WST-03 |
| POST | `/api/returns` | `return.create` | `{direction:ReturnDirection; fromLocationId:UUID; toLocationId?:UUID; supplierId?:UUID; lines:{itemId:UUID; storageAreaId:UUID; qty:Qty; condition:ReturnCondition; reason:string}[]; photoAttachmentIds:UUID[] /* wajib */}` | `Return` (draft) | FR-WST-01 |
| POST | `/api/returns/:id/submit` | `return.create` | – | `Return` (`submitted`) | FR-WST-02 |
| POST | `/api/returns/:id/approve` | `return.approve` | `{note?}` (outlet→gudang: SPV; gudang→supplier: KGD — §5.5/§5.6) | `Return` (`approved`) | FR-WST-02 |
| POST | `/api/returns/:id/reject` | `return.approve` | `{reason:string}` | `Return` (`rejected`) | FR-WST-02 |
| POST | `/api/returns/:id/ship` | `return.ship` | `{proofAttachmentIds:UUID[] /* wajib FR-WST-03 */}` — posts `return_out` at origin (journal `OUTLET_RETURN_TO_WAREHOUSE` / `GUDANG_RETURN_TO_SUPPLIER`) | `Return` (`in_transit`) | FR-WST-03/04, JOUT-05, JGUD-04 |
| POST | `/api/returns/:id/receive` | `return.receive` | `{lines:{lineId:UUID; qtyReceived:Qty; storageAreaId:UUID}[]; proofAttachmentIds:UUID[] /* wajib */}` — outlet→gudang only: posts `return_in` at warehouse (journal `GUDANG_GOODS_IN`) | `Return` (`received`) | FR-WST-03/04, JGUD-02 |
| POST | `/api/returns/:id/complete` | `return.approve` | supplier leg: `{supplierAcceptedAt:ISODateTime; creditNoteRef?:string}` | `Return` (`completed`) | FR-WST-04 |

### 4.13 M13 `pos` (FR-POS-01..07)

```ts
interface Shift { id: UUID; shiftNumber: string; locationId: UUID; deviceId: UUID|null; openedBy: string;
                  openedAt: ISODateTime; openingCash: Money; status: 'open'|'closed'; closedAt: ISODateTime|null;
                  closingCashCounted: Money|null; expectedCash: Money|null; cashVariance: Money|null;
                  salesCount: number; grossSales: Money }
interface Sale { id: UUID; receiptNumber: string; locationId: UUID; shiftId: UUID; kasirName: string;
                 status: SaleStatus; subtotal: Money; discount: Money; total: Money; paidAmount: Money;
                 changeAmount: Money; offlineCreated: boolean; occurredAt: ISODateTime;
                 lines: {productId: UUID; productName: string; qty: Qty; unitPrice: Money; discount: Money; lineTotal: Money}[];
                 payments: {method: PaymentMethod; amount: Money; reference: string|null; paymentStatus: PaymentStatus}[] }
```

POS devices mutate through the W2-E outbox (events `pos_shifts.opened/closed`, `sales.completed`, `void_refunds.*`, `online_orders.recorded`); the endpoints below are the online/apply/test surface for the same service methods. `clientId` = the offline idempotency key; online calls must send one too (generated the same way).

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/pos/catalog` | `pos.catalog.read` | `?locationId=` | `{products: Product[]; categories: string[]; version: string}` — the device precache payload | FR-POS-01 |
| GET | `/api/pos/shifts/current` | `pos.shift.open` | `?deviceId=&locationId=` | `Shift \| null` | FR-POS-02 |
| POST | `/api/pos/shifts/open` | `pos.shift.open` | `{clientId:UUID; locationId:UUID; deviceId?:UUID; openingCash:Money; openedAt?:ISODateTime}` | `Shift` | FR-POS-02 |
| POST | `/api/pos/shifts/:id/close` | `pos.shift.close` | `{closingCashCounted:Money; notes?; closedAt?:ISODateTime}` — cloud recomputes expected cash (R7); a shortfall > `pos.cash_variance_propose_above` **auto-creates a pending `cash_variance_proposals` row** (Amendment 2); overage stays an R7 finance exception | `Shift & {report: ShiftReport}` (`ShiftReport = {byMethod:{method:PaymentMethod; amount:Money; count:number}[]; voids:number; voidAmount:Money; onlineOrders:{platform:OnlinePlatform; count:number; net:Money}[]; cashVarianceProposalId:UUID\|null}`) | FR-POS-02, F-POS-01, Amendment 2 |
| GET | `/api/pos/shifts` | `pos.sale.read` | `?locationId=&date=&status=&page=` | `Paginated<Shift>` | FR-POS-02 |
| GET | `/api/pos/shifts/:id/report` | `pos.sale.read` | – | `ShiftReport` (laporan shift) | F-POS-01 |
| POST | `/api/pos/sales` | `pos.sale.create` | `{clientId:UUID; shiftId:UUID; locationId:UUID; occurredAt:ISODateTime; lines:{productId:UUID; qty:Qty; unitPrice:Money; discount?:Money}[]; payments:{method:PaymentMethod; amount:Money; reference?:string; proofAttachmentId?:UUID}[]; discount?:Money}` — duplicate `clientId` returns the existing sale (200, idempotent); posts recipe `usage_out` (fact mode); payment statuses: cash→`paid`, qris→`verified`, transfer→`pending` | `Sale` | FR-POS-04/06, JOUT-02/03 |
| GET | `/api/pos/sales` | `pos.sale.read` | `?locationId=&shiftId=&date=&status=&page=` | `Paginated<Sale>` | FR-POS-06 |
| GET | `/api/pos/sales/:id` | `pos.sale.read` | – | `Sale` | – |
| POST | `/api/pos/sales/:id/void-request` | `pos.void.request` | `{clientId:UUID; type:'void'\|'refund'; reason:string /* required */; amount?:Money}` | `{voidRefundId:UUID; status:'pending'}` | FR-POS-03 |
| POST | `/api/pos/void-refunds/:id/approve` | `pos.void.approve` | `{pin:string}` online; offline path = `void_refunds.approved_offline` event (§7.3) | `{id; status:'approved'; offlineAuthorized:boolean}` — reverses payments/usage, journal `SALE_VOID_REVERSAL` | FR-POS-03, APR-02, D-17 |
| POST | `/api/pos/void-refunds/:id/reject` | `pos.void.approve` | `{reason:string}` | `{id; status:'rejected'}` | FR-POS-03 |
| GET | `/api/pos/void-refunds` | `pos.sale.read` | `?locationId=&status=&date=&page=` | `Paginated<{id; saleId; receiptNumber; type; amount:Money; reason; status; requestedBy; approvedBy; offlineAuthorized:boolean; reverificationStatus:ReverificationStatus\|null}>` | FR-POS-03 |
| POST | `/api/pos/online-orders` | `pos.online_order.record` | `{clientId:UUID; locationId:UUID; platform:OnlinePlatform; orderRef:string; orderDate:ISODate; grossAmount:Money; discountAmount:Money; platformFee:Money; otherFee:Money; netReceived:Money; status:OnlineOrderStatus; items?:{productId:UUID; qty:Qty}[]; shiftId?:UUID}` — `netReceived` must equal `gross−discount−fees` (`ERR_NET_MISMATCH`) | online order | FR-POS-05/07 |
| GET | `/api/pos/online-orders` | `pos.online_order.read` | `?locationId=&platform=&from=&to=&settlement=&page=` | `Paginated<OnlineOrder>` | FR-POS-07 |
| GET | `/api/pos/daily-stock` | `pos.daily_stock.read` | `?locationId=&date=` | `{itemId:UUID; itemName:string; unitCode:string; opening:Qty; received:Qty; estimatedUsage:Qty; waste:Qty; closing:Qty}[]` — from movements + `mv_item_usage_daily` | FR-POS-06 |
| GET | `/api/pos/cash-variances` | `pos.cash_variance.read` | `?locationId=&status=&from=&to=&page=` | `Paginated<CashVarianceProposal>` where `CashVarianceProposal = {id:UUID; shiftId:UUID; shiftNumber:string; locationName:string; kasirName:string; employeeId:UUID\|null; amount:Money; status:CashVarianceProposalStatus; decidedBy:string\|null; decidedAt:ISODateTime\|null; decisionReason:string\|null; payrollRunNumber:string\|null; createdAt:ISODateTime}` | Amendment 2 |
| POST | `/api/pos/cash-variances/:id/approve` | `pos.cash_variance.approve` | `{reason:string /* REQUIRED */}` — **online-only, never offline-authorizable** (§5.9); approved proposal becomes a `deduction_cash_variance` line in the next payroll run | `CashVarianceProposal` (approved) | Amendment 2 |
| POST | `/api/pos/cash-variances/:id/reject` | `pos.cash_variance.approve` | `{reason:string /* REQUIRED */}` | `CashVarianceProposal` (rejected) | Amendment 2 |

### 4.14 M14 `hr` (FR-HR-01/02, attendance GPS + selfie, shifts, cuti/izin)

```ts
interface Employee { id: UUID; employeeNumber: string; userId: UUID|null; name: string; position: string;
                     locationId: UUID; locationName: string; employmentStatus: EmploymentStatus; joinDate: ISODate;
                     phone: string|null; /* bank + NIK fields visible only with hr.employee.manage */ }
interface AttendanceRow { id: UUID; employeeId: UUID; employeeName: string; locationName: string; date: ISODate;
                          status: AttendanceStatus; checkInAt: ISODateTime|null; checkOutAt: ISODateTime|null;
                          lateMinutes: number; overtimeMinutes: number; geofenceOk: boolean;
                          selfieUrls: {in: string|null; out: string|null}; timeSuspect: boolean }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| POST | `/api/hr/attendance/check-in` | `hr.attendance.check` | `{clientId:UUID; locationId:UUID; lat:string; lng:string; accuracyM:number; selfieAttachmentId:UUID /* wajib */; deviceId?:UUID; at?:ISODateTime}` — server computes distance vs geofence (radius from location, default 100 m); outside ⇒ `ERR_GEOFENCE_OUT_OF_RANGE` (no silent accept) | `AttendanceRow` | FR-HR-01 |
| POST | `/api/hr/attendance/check-out` | `hr.attendance.check` | same shape | `AttendanceRow` (work/late/overtime minutes computed vs shift assignment) | FR-HR-01/03 |
| GET | `/api/hr/attendance/me` | `hr.attendance.check` | `?month=YYYY-MM` | `AttendanceRow[]` (own) | FR-HR-01 |
| GET | `/api/hr/attendance` | `hr.attendance.read` | `?locationId=&date=&employeeId=&status=&page=` | `Paginated<AttendanceRow>` | FR-HR-03 |
| PATCH | `/api/hr/attendance/:id` | `hr.attendance.correct` | `{status?; checkInAt?; checkOutAt?; correctionReason:string /* required */}` | `AttendanceRow` | FR-AUDIT-02 |
| GET | `/api/hr/attendance/summary` | `hr.attendance.read` | `?periodCode=&locationId=&employeeId=` | `{employeeId:UUID; presentDays:number; lateCount:number; lateMinutes:number; overtimeMinutes:number; sickDays:number; permissionDays:number; absentDays:number; leaveDays:number; disputedRows:number}[]` — the payroll input (POUT-01/02/03/07/08) | FR-HR-03/04 |
| GET | `/api/hr/employees` | `hr.employee.read` | `?locationId=&status=&q=&page=` | `Paginated<Employee>` | SCOPE-IN-03 |
| GET | `/api/hr/employees/:id` | `hr.employee.read` | – | `Employee & {employments: {position; locationName; baseSalary?:Money; startDate; endDate}[]}` (salary needs `hr.employee.manage`) | – |
| POST | `/api/hr/employees` | `hr.employee.manage` | `{employeeNumber; name; nik?; phone?; email?; joinDate; position; locationId; baseSalary:Money; bankName?; bankAccountNumber?; bankAccountName?; userId?}` | `Employee` | ASM-01 |
| PATCH | `/api/hr/employees/:id` | `hr.employee.manage` | partial + `{employmentChange?:{position; locationId; baseSalary:Money; startDate}}` (appends `employments`) | `Employee` | – |
| GET | `/api/hr/shifts` | `hr.shift.read` | `?locationId=` | `{id:UUID; name:string; startTime:string; endTime:string; breakMinutes:number}[]` | FR-HR-02 |
| POST | `/api/hr/shifts` | `hr.shift.manage` | `{locationId?:UUID; name; startTime:'HH:mm'; endTime:'HH:mm'; breakMinutes?}` | shift | FR-HR-02 |
| PATCH | `/api/hr/shifts/:id` | `hr.shift.manage` | partial | shift | FR-HR-02 |
| GET | `/api/hr/roster` | `hr.shift.read` | `?locationId=&from=&to=&employeeId=` | `{employeeId:UUID; employeeName:string; days:{date:ISODate; workShiftId:UUID\|null; shiftName:string\|null}[]}[]` | FR-HR-02 |
| PUT | `/api/hr/roster` | `hr.shift.manage` | `{locationId:UUID; assignments:{employeeId:UUID; date:ISODate; workShiftId:UUID\|null /* null = libur */}[]}` (bulk upsert) | updated roster | FR-HR-02 |
| GET | `/api/hr/leaves` | `hr.leave.read` | `?locationId=&status=&type=&employeeId=&page=` | `Paginated<Leave>` where `Leave = {id; employeeName; type:LeaveType; startDate; endDate; days:string; reason; status:LeaveStatus; attachmentUrl:string\|null; decidedBy}` | F-HR-06 |
| GET | `/api/hr/leaves/me` | `hr.leave.request` | `?year=` | `Leave[] & quota: {annual:{total:12; used:number}; marriage:{total:3; used:number}}` | POUT-04 |
| POST | `/api/hr/leaves` | `hr.leave.request` | `{clientId:UUID; type:LeaveType; startDate:ISODate; endDate:ISODate; reason?:string; attachmentId?:UUID}` — quota checked for annual/marriage | `Leave` (pending) | F-HR-06 |
| POST | `/api/hr/leaves/:id/approve` | `hr.leave.approve` | `{note?}` (online-only) | `Leave` — approved days write `attendance.status` for the range | POUT-01/02/04 |
| POST | `/api/hr/leaves/:id/reject` | `hr.leave.approve` | `{reason:string}` | `Leave` | F-HR-06 |
| POST | `/api/hr/leaves/:id/cancel` | `hr.leave.request` | – (own, pending only) | `Leave` (cancelled) | – |

### 4.15 M15 `payroll` (FR-HR-03/04, PIN-01..07, POUT-01..09, slip gaji 8.3.3)

```ts
interface PayrollRun { id: UUID; runNumber: string; periodCode: string; status: PayrollRunStatus;
                       statutoryMode: boolean;   // Amendment 1: mode the run executed in (immutable after calculate)
                       employeeCount: number; totalGross: Money; totalDeductions: Money; totalNet: Money;
                       totalEmployerCost: Money; // Amendment 1: Σ employer_cost lines (0 when statutoryMode=false)
                       calculatedAt: ISODateTime|null; approval: ApprovalDetail|null; paidAt: ISODateTime|null }
interface PayslipLine { componentCode: PayrollComponentCode; componentName: string;
                        type: 'earning'|'deduction'|'employer_cost'; isStatutory: boolean;
                        qty: Qty|null; rate: Money|null; amount: Money; sourceRefType: string|null; manualOverride: boolean }
interface Payslip { runId: UUID; periodCode: string; employee: {id: UUID; name: string; position: string; locationName: string};
                    lines: PayslipLine[];        // statutory lines present ONLY on statutoryMode runs;
                                                 // employer_cost lines render as an info section, excluded from net
                    gross: Money; deductions: Money; net: Money; employerCost: Money; slipPdfUrl: string|null }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/payroll/periods` | `payroll.read` | `?page=` | `Paginated<{id; periodCode; startDate; endDate; status; runs:{id; runNumber; status}[]}>` | FR-HR-04 |
| POST | `/api/payroll/periods` | `payroll.run.calculate` | `{periodCode:'YYYY-MM'}` (dates derived) | period | FR-HR-04 |
| POST | `/api/payroll/periods/:id/calculate` | `payroll.run.calculate` | `{employeeIds?:UUID[] /* default all active */}` — pulls attendance summary (PIN-02, POUT-01/02/03/07/08), leave quota excess (POUT-04), approved SO shortfalls (POUT-05), active loans (POUT-06), approved cash-variance proposals (Amendment 2), component assignments (PIN-03..07); pure calculators in `packages/shared`. Snapshots `statutoryMode` from `settings payroll.statutory.enabled` — OFF ⇒ exactly the PRD base components, zero statutory lines; ON ⇒ statutory lines computed from the effective-dated `bpjs_configs`/`pph21_*` tables + `employee_tax_profiles` (rejects `ERR_STATUTORY_NOT_READY` if the readiness check fails) | `PayrollRun` (calculated, with lines) | FR-HR-03/04, PIN-*, POUT-*, Amendment 1/2 |
| GET | `/api/payroll/runs/:id` | `payroll.read` | – | `PayrollRun & {employees: Payslip[]}` | FR-HR-04 |
| PATCH | `/api/payroll/runs/:id/lines/:lineId` | `payroll.run.calculate` | `{amount:Money; overrideReason:string /* required */}` | `PayslipLine` | FR-AUDIT-02 |
| POST | `/api/payroll/runs/:id/recalculate` | `payroll.run.calculate` | – (drops non-overridden lines, recomputes) | `PayrollRun` | FR-HR-03 |
| POST | `/api/payroll/runs/:id/submit` | `payroll.run.submit` | – → `pending_approval` (chain §5.7: Finance → Owner) | `PayrollRun` | FR-HR-04 |
| POST | `/api/payroll/runs/:id/approve` | `payroll.run.approve` | `{note?}` — final approval posts journal `PAYROLL_ACCRUAL`, creates `payment_verifications` (pending), decrements loan `outstanding` via `employee_loan_payments` | `PayrollRun` (approved) | FR-HR-04, APR-05/08, POUT-06 |
| POST | `/api/payroll/runs/:id/reject` | `payroll.run.approve` | `{reason:string}` → back to `calculated` | `PayrollRun` | FR-AUDIT-02 |
| POST | `/api/payroll/runs/:id/mark-paid` | `payroll.run.pay` | `{paymentVerificationId:UUID}` (must be `paid`) → journal `PAYROLL_PAYMENT` | `PayrollRun` (paid) | FR-ACCT-04 |
| POST | `/api/payroll/runs/:id/send-slips` | `payroll.slip.send` | `{channels:('email'\|'whatsapp')[]}` — renders slip PDFs (W5-05), queues `notification_outbox` per employee | `{queued:number; skippedNoContact:number}` | 8.3.3, D-03 |
| GET | `/api/payroll/my-slips` | `payroll.slip.read.own` | `?year=` | `Payslip[]` (own, approved runs only) | 8.3.3 |
| GET | `/api/payroll/components` | `payroll.read` | – | `{id; code:PayrollComponentCode; name; type; calcMethod; formulaKey; defaultAmount:Money\|null; isSystem:boolean}[]` | PIN-07, POUT-09 |
| POST | `/api/payroll/components` | `payroll.component.manage` | `{code; name; type:'earning'\|'deduction'; calcMethod; defaultAmount?:Money}` (custom components) | component | PIN-07, POUT-09 |
| PATCH | `/api/payroll/components/:id` | `payroll.component.manage` | partial (system rows: only `defaultAmount`/`isActive`) | component | – |
| GET | `/api/payroll/employees/:employeeId/components` | `payroll.read` | – | `{componentId:UUID; code:string; amount:Money\|null; effectiveFrom:ISODate; effectiveTo:ISODate\|null}[]` | PIN-03..06 |
| PUT | `/api/payroll/employees/:employeeId/components` | `payroll.component.manage` | `{assignments:{componentId:UUID; amount:Money\|null; effectiveFrom:ISODate}[]}` | assignments | PIN-03..06 |
| GET | `/api/payroll/loans` | `payroll.read` | `?employeeId=&status=&page=` | `Paginated<{id; loanNumber; employeeName; principal:Money; monthlyInstallment:Money; outstanding:Money; status:LoanStatus}>` | POUT-06 |
| POST | `/api/payroll/loans` | `payroll.loan.manage` | `{employeeId:UUID; principal:Money; monthlyInstallment:Money; reason?}` | loan (pending) | POUT-06 |
| POST | `/api/payroll/loans/:id/approve` | `payroll.loan.approve` | `{note?}` → active, `disbursed_at` set, `payment_verifications` row for disbursement | loan | POUT-06, FR-ACCT-04 |
| POST | `/api/payroll/loans/:id/reject` | `payroll.loan.approve` | `{reason:string}` | loan | – |
| GET | `/api/payroll/loans/:id/schedule` | `payroll.read` | – | `{paidAt:ISODateTime; amount:Money; method:string; payrollRunNumber:string\|null}[] & {outstanding:Money}` | POUT-06 |
| GET | `/api/payroll/statutory/status` | `payroll.statutory.read` | – | `{enabled:boolean; ready:boolean; enabledAt:ISODateTime\|null; enabledBy:string\|null; missing:('bpjs_configs'\|'pph21_ter_rates'\|'pph21_ptkp'\|'pph21_article17_brackets'\|'employee_tax_profiles')[]; profileCoverage:{withProfile:number; total:number}}` — the wizard's completeness check ("is statutory payroll ready to enable?") | Amendment 1 |
| GET | `/api/payroll/statutory/bpjs` | `payroll.statutory.read` | `?program=&asOf=` | `{id:UUID; program:string; employerPct:string; employeePct:string; salaryFloor:Money\|null; salaryCap:Money\|null; effectiveFrom:ISODate; effectiveTo:ISODate\|null}[]` | Amendment 1 |
| PUT | `/api/payroll/statutory/bpjs` | `payroll.statutory.config` | `{rows:{program:'kesehatan'\|'jht'\|'jkk'\|'jkm'\|'jp'; employerPct:string; employeePct:string; salaryFloor?:Money; salaryCap?:Money; effectiveFrom:ISODate}[]}` — inserting a new effective window auto-closes (`effective_to`) the previous row per programme; windows may never overlap (`ERR_EFFECTIVE_OVERLAP`) | updated rows | Amendment 1 |
| GET | `/api/payroll/statutory/pph21/ter` | `payroll.statutory.read` | `?category=&asOf=` | `{id:UUID; category:'A'\|'B'\|'C'; bracketMin:Money; bracketMax:Money\|null; ratePct:string; effectiveFrom:ISODate; effectiveTo:ISODate\|null}[]` | Amendment 1 |
| PUT | `/api/payroll/statutory/pph21/ter` | `payroll.statutory.config` | `{effectiveFrom:ISODate; rows:{category:'A'\|'B'\|'C'; bracketMin:Money; bracketMax?:Money; ratePct:string}[]}` — replaces the full bracket set per effective date; brackets must be contiguous from 0 per category (`ERR_BRACKET_GAP`) | updated rows | Amendment 1 |
| GET | `/api/payroll/statutory/pph21/ptkp` | `payroll.statutory.read` | `?asOf=` | `{id:UUID; ptkpCode:string; annualAmount:Money; terCategory:'A'\|'B'\|'C'; effectiveFrom:ISODate; effectiveTo:ISODate\|null}[]` | Amendment 1 |
| PUT | `/api/payroll/statutory/pph21/ptkp` | `payroll.statutory.config` | `{effectiveFrom:ISODate; rows:{ptkpCode:string; annualAmount:Money; terCategory:'A'\|'B'\|'C'}[]}` (full-set replace per effective date) | updated rows | Amendment 1 |
| GET | `/api/payroll/statutory/pph21/article17` | `payroll.statutory.read` | `?asOf=` | `{id:UUID; bracketMin:Money; bracketMax:Money\|null; ratePct:string; effectiveFrom:ISODate; effectiveTo:ISODate\|null}[]` — the annual Art-17 true-up schedule | Amendment 1 |
| PUT | `/api/payroll/statutory/pph21/article17` | `payroll.statutory.config` | `{effectiveFrom:ISODate; rows:{bracketMin:Money; bracketMax?:Money; ratePct:string}[]}` — full-set replace per effective date; brackets contiguous from 0, top bracket open-ended (`ERR_BRACKET_GAP`), windows never overlap (`ERR_EFFECTIVE_OVERLAP`) | updated rows | Amendment 1 |
| GET | `/api/payroll/employees/:employeeId/tax-profile` | `payroll.statutory.read` | – | `TaxProfile = {employeeId:UUID; npwp:string\|null; ptkpCode:string; dependantsCount:number; bpjsEnrollments:Record<'kesehatan'\|'jht'\|'jkk'\|'jkm'\|'jp',{enrolledSince:ISODate; endedAt:ISODate\|null}>; bpjsSalaryBase:Money\|null}` | Amendment 1 |
| PUT | `/api/payroll/employees/:employeeId/tax-profile` | `payroll.statutory.config` | `TaxProfile` minus `employeeId` (upsert; `ptkpCode` validated against `pph21_ptkp`) | `TaxProfile` | Amendment 1 |
| POST | `/api/payroll/statutory/enable` | `payroll.statutory.enable` | `{confirm:true}` — the wizard's final step: rejects `ERR_STATUTORY_NOT_READY` unless `/status.ready`; flips `settings payroll.statutory.enabled=true` (audited; emits `settings.updated` master event) | statutory status | Amendment 1 |
| POST | `/api/payroll/statutory/disable` | `payroll.statutory.enable` | `{reason:string}` — future runs revert to base mode; historical `statutory_mode=true` runs are untouched | statutory status | Amendment 1 |

**Statutory payroll (Amendment 1) is OFF by default.** The wizard (F08, Owner/Manager) walks: (1) BPJS programme rates → (2) PPh21 TER + PTKP tables → (3) employee tax profiles → (4) enable. When OFF, runs compute exactly the PRD's base components and slips show no statutory section. December runs in statutory mode perform the annual PPh21 true-up (§1.7 calculation notes); **maintaining the annual rates/PTKP values is the client's operational responsibility** — the system only enforces effective-dating.

### 4.16 M16 `asset` (FR-PMS-01..04)

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/assets` | `asset.read` | `?locationId=&category=&status=&condition=&q=&page=` | `Paginated<Asset>` where `Asset = {id; assetNumber; name; category:AssetCategory; locationName; serialNumber; brand; model; purchaseDate; purchasePrice?:Money; condition:AssetCondition; status:AssetStatus; assignedToName:string\|null; photoUrl:string\|null}` | FR-PMS-01 |
| GET | `/api/assets/:id` | `asset.read` | – | `Asset & {schedules: Schedule[]; openJobs: Job[]}` | FR-PMS-01 |
| POST | `/api/assets` | `asset.manage` | `{assetNumber?; name; category; locationId; serialNumber?; brand?; model?; purchaseDate?; purchasePrice?:Money; vehicleId?; assignedToEmployeeId?; photoAttachmentId?}` | `Asset` | FR-PMS-01 |
| PATCH | `/api/assets/:id` | `asset.manage` | partial (incl. `condition`, `status`, `assignedToEmployeeId`) | `Asset` | FR-PMS-01/04 |
| GET | `/api/assets/:id/schedules` | `asset.read` | – | `Schedule[] = {id; name; intervalType:'days'\|'months'; intervalValue:number; lastDoneAt:ISODate\|null; nextDueAt:ISODate; reminderDaysBefore:number; isActive:boolean}[]` | FR-PMS-02 |
| POST | `/api/assets/:id/schedules` | `asset.schedule.manage` | `{name; intervalType; intervalValue; nextDueAt:ISODate; reminderDaysBefore?}` | `Schedule` | FR-PMS-02 |
| PATCH | `/api/assets/schedules/:scheduleId` | `asset.schedule.manage` | partial | `Schedule` | FR-PMS-02 |
| GET | `/api/assets/maintenance/due` | `asset.read` | `?windowDays=30&locationId=` | `{jobId:UUID\|null; scheduleId:UUID; assetId:UUID; assetName:string; locationName:string; name:string; dueDate:ISODate; overdue:boolean}[]` — daily scheduler creates `due` jobs + `maintenance_due` notifications (FR-PMS-03) | FR-PMS-02/03 |
| GET | `/api/assets/jobs` | `asset.read` | `?locationId=&status=&assetId=&page=` | `Paginated<Job>` where `Job = {id; jobNumber; assetName; type; status:MaintenanceJobStatus; dueDate; assignedToName; completedAt; cost:Money\|null; proofUrls:string[]}` | FR-PMS-02 |
| POST | `/api/assets/:id/jobs` | `asset.job.execute` | `{type:'corrective'; description:string; assignedToEmployeeId?}` (scheduled jobs are scheduler-born) | `Job` | FR-PMS-02 |
| POST | `/api/assets/jobs/:jobId/start` | `asset.job.execute` | – → `in_progress` | `Job` | FR-PMS-02 |
| POST | `/api/assets/jobs/:jobId/complete` | `asset.job.execute` | `{proofAttachmentIds:UUID[] /* ≥1 wajib FR-PMS-04 */; cost?:Money; vendor?; conditionAfter:AssetCondition; odometerKm?; notes?}` — appends `service_history`, rolls schedule `next_due_at`; cost>0 creates `payment_verifications` (pending) | `Job` (done) | FR-PMS-04, FR-ACCT-04 |
| POST | `/api/assets/jobs/:jobId/verify` | `asset.job.verify` | `{note?}` (Supervisor/Manager verifikasi, PRD 14.5) | `Job` (verified) | FR-PMS-04 |
| GET | `/api/assets/:id/history` | `asset.read` | `?page=` | `Paginated<{serviceDate:ISODate; description:string; vendor:string\|null; cost:Money; conditionAfter:AssetCondition; odometerKm:number\|null; recordedBy:string; proofUrls:string[]}>` | FR-PMS-04 |

### 4.17 M17 `accounting` (D-04 GL; FR-ACCT-01..04; JGUD/JOUT via posting engine §6)

```ts
interface Account { id: UUID; code: string; name: string; type: AccountType; normalBalance: 'debit'|'credit';
                    parentId: UUID|null; isPostable: boolean; isSystem: boolean; isActive: boolean }
interface JournalEntry { id: UUID; entryNumber: string; entryDate: ISODate; eventType: string|null;
                         source: 'system'|'manual'; refType: string|null; refId: UUID|null; locationName: string|null;
                         description: string; status: 'posted'|'reversed';
                         lines: {lineNo: number; accountCode: string; accountName: string; debit: Money; credit: Money; memo: string|null}[] }
interface PaymentVerification { id: UUID; pvNumber: string; refType: PaymentVerificationRefType; refId: UUID|null;
                                refNumber: string|null; payeeType: PayeeType; payeeName: string|null; amount: Money;
                                status: PaymentStatus|'rejected'; proofUrl: string|null; referenceNumber: string|null;
                                submittedBy: string; verifiedBy: string|null; verifiedAt: ISODateTime|null;
                                paidBy: string|null; paidAt: ISODateTime|null; paidVia: string|null; locationName: string|null }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/accounting/accounts` | `accounting.coa.read` | `?type=&active=&q=` | `Account[]` (tree-ordered) | D-04 |
| POST | `/api/accounting/accounts` | `accounting.coa.manage` | `{code; name; type; normalBalance; parentId?; isPostable?}` | `Account` | D-04 |
| PATCH | `/api/accounting/accounts/:id` | `accounting.coa.manage` | `{name?; isActive?}` (code/type immutable; system rows undeletable) | `Account` | D-04 |
| GET | `/api/accounting/journal` | `accounting.journal.read` | `?from=&to=&accountCode=&eventType=&locationId=&source=&page=` | `Paginated<JournalEntry>` | JGUD-01..07, JOUT-01..09 |
| GET | `/api/accounting/journal/:id` | `accounting.journal.read` | – | `JournalEntry` | FR-ACC-* |
| POST | `/api/accounting/journal` | `accounting.journal.post` | `{entryDate:ISODate; description:string; locationId?:UUID; lines:{accountCode:string; debit?:Money; credit?:Money; memo?}[]}` — must balance (`ERR_UNBALANCED_ENTRY`); period must be open | `JournalEntry` (source `manual`) | D-04 |
| POST | `/api/accounting/journal/:id/reverse` | `accounting.journal.reverse` | `{reason:string}` | new reversing `JournalEntry` | D-04 |
| GET | `/api/accounting/posting-rules` | `accounting.coa.read` | `?eventType=` | `{eventType:string; ruleSeq:number; condition:object\|null; debitAccountCode:string; creditAccountCode:string; amountSource:string; isActive:boolean}[]` (§6.2 as data) | JGUD-*, JOUT-* |
| GET | `/api/accounting/periods` | `accounting.coa.read` | – | `{id; periodCode; startDate; endDate; status:FiscalPeriodStatus}[]` | D-04 |
| POST | `/api/accounting/periods/:id/close` | `accounting.period.close` | `{note?}` — blocks when unposted applied events exist for the period | period (closed) | D-04 |
| POST | `/api/accounting/periods/:id/reopen` | `accounting.period.close` | `{reason:string}` (closed→open; locked never reopens) | period | D-04 |
| GET | `/api/accounting/trial-balance` | `accounting.report.read` | `?periodCode=` | `{accountCode; accountName; type; debit:Money; credit:Money}[] & {totalDebit:Money; totalCredit:Money; balanced:boolean}` | D-04 |
| GET | `/api/accounting/profit-loss` | `accounting.report.read` | `?from=&to=&locationId=` | `{revenue:{accountCode; name; amount:Money}[]; expenses:{...}[]; totalRevenue:Money; totalExpense:Money; netProfit:Money}` | FR-DASH-01, D-04 |
| GET | `/api/accounting/balance-sheet` | `accounting.report.read` | `?asOf=ISODate` | `{assets:[...]; liabilities:[...]; equity:[...]; balanced:boolean}` | D-04 |
| GET | `/api/accounting/stock-value` | `accounting.report.read` | `?asOf=&locationId=` | `{locationId:UUID; locationName:string; value:Money; byCategory:{categoryName:string; value:Money}[]}[]` (nilai barang/stok) | JGUD-07 |
| GET | `/api/accounting/payments` | `payment.read` | `?status=&refType=&locationId=&from=&to=&page=` | `Paginated<PaymentVerification>` — the verification queue (F07) | FR-ACCT-01..04 |
| GET | `/api/accounting/payments/:id` | `payment.read` | – | `PaymentVerification & {history: AuditRow[]}` | FR-ACCT-02 |
| POST | `/api/accounting/payments` | `payment.proof.upload` | `{refType:PaymentVerificationRefType; refId?:UUID; payeeType:PayeeType; payeeId?:UUID; amount:Money; proofAttachmentId?:UUID; referenceNumber?; locationId?; notes?}` (manual/other payments — THR, insentif, biaya lain) | `PaymentVerification` (pending) | FR-ACCT-04 |
| POST | `/api/accounting/payments/:id/proof` | `payment.proof.upload` | `{proofAttachmentId:UUID; referenceNumber?:string}` | `PaymentVerification` | FR-ACCT-01, NFR-09 |
| POST | `/api/accounting/payments/:id/verify` | `payment.verify` | `{note?}` — requires proof attached (`ERR_PROOF_REQUIRED`); records verifier + time | `PaymentVerification` (verified) | FR-ACCT-02/03, APR-05 |
| POST | `/api/accounting/payments/:id/pay` | `payment.pay` | `{paidVia:'cash'\|'bank_transfer'\|'qris'; paidAt?:ISODateTime}` — amounts ≥ `approval.threshold.payment` need the Owner approval step first (§5.8); posts the §6 payment journal for the ref type | `PaymentVerification` (paid) | FR-ACCT-03/04, APR-08 |
| POST | `/api/accounting/payments/:id/reject` | `payment.reject` | `{reason:string}` | `PaymentVerification` (rejected) | FR-ACCT-02 |
| GET | `/api/accounting/exceptions` | `sync.exception.review` | `?status=&class=&page=` | `Paginated<OfflineAuthCase>` where `OfflineAuthCase = {id; class:'offline_auth_failed'\|'offline_auth_unprovable'; documentType; documentId; amount:Money\|null; approverName; deviceName; outletName; occurredAt; relayReceivedAt; evidence:{selfieUrl:string\|null; pinAttempts:number\|null}; physicalEffectSuspected:boolean; outcome:OfflineAuthOutcome; verdict:'upheld'\|'rejected'\|null}` — the D-17 finance exception queue (SYNC-PROTOCOL §7.5) | D-17, OBJ-03 |
| POST | `/api/accounting/exceptions/:id/verdict` | `sync.exception.review` | `{verdict:'upheld'\|'rejected'; reason:string; routeToPayrollDeduction?:boolean}` — `rejected`+physical effect posts `OFFLINE_AUTH_REJECTED` (§6.3) to Piutang Klaim; optional kasbon-style recovery | `OfflineAuthCase` | D-17, §6.3-X7 |

### 4.18 M18 `dashboard` (FR-DASH-01..04)

All read-only, sourced from `mv_*` views + live counters; realtime tiles push over socket.io channel `dashboard:<scope>`.

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/dashboard/overview` | `dashboard.view` | `?from=&to=` | `{revenue:Money; revenueOnline:Money; profitEstimate:Money; txCount:number; avgTicket:Money; activeOutlets:number; vs:{revenuePct:string; txPct:string} /* vs previous period */}` | FR-DASH-01 |
| GET | `/api/dashboard/outlets` | `dashboard.view` | `?date=` | `{locationId:UUID; name:string; city:string; revenue:Money; txCount:number; onlineNet:Money; openShifts:number; lowStockCount:number; offlineDevices:number; syncQueueDepth:number}[]` — all 15–20 outlets, one view | FR-DASH-02/04 |
| GET | `/api/dashboard/outlet/:locationId` | `dashboard.outlet.view` | `?date=` | outlet drill-down: same tile + hourly trend + top products + staff on shift | FR-DASH-02, 14.4 |
| GET | `/api/dashboard/top-products` | `dashboard.view` | `?from=&to=&locationId=&limit=10` | `{productId:UUID; name:string; qty:Qty; revenue:Money}[]` | FR-DASH-03 |
| GET | `/api/dashboard/staff-kpi` | `dashboard.view` | `?from=&to=&locationId=` | `{employeeId:UUID; name:string; role:string; salesCount:number; salesAmount:Money; attendanceRate:string; lateCount:number}[]` | FR-DASH-03 |
| GET | `/api/dashboard/trend` | `dashboard.view` | `?metric=revenue\|tx\|usage&granularity=daily\|weekly&from=&to=&locationId=` | `{t:ISODate; value:string}[]` | FR-DASH-03 |
| GET | `/api/dashboard/ops-status` | `dashboard.view` | – | `{lowStockOutlets:number; sjInTransit:number; pendingApprovals:number; pendingPayments:number; offlineOutlets:number; openConflicts:number; coldChainBreaches24h:number; maintenanceDue:number}` | FR-DASH-04 |

### 4.19 M19 `report` (exports; rekap pengiriman FR-LOG-04; laporan shift)

All exports honor `?format=json|csv|xlsx` (xlsx via server-side generation; response = file stream or `{url}` to a stored attachment). `format=json` needs only the row's read permission; `format=csv|xlsx` additionally requires `report.export`.

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/reports/sales` | `report.sales.read` | `?from=&to=&locationId=&groupBy=day\|outlet\|product\|method&format=` | grouped sales report incl. online orders (gross, discount, platform fees, net) | FR-POS-07, FR-DASH-03 |
| GET | `/api/reports/shift/:shiftId` | `report.sales.read` | `?format=` | `ShiftReport` (see M13) + sales list — laporan shift | F-POS-01 |
| GET | `/api/reports/delivery-daily` | `report.logistics.read` | `?date=&format=` | the M10 recap shape, printable — rekap harian tim logistik | FR-LOG-04/08 |
| GET | `/api/reports/stock-usage` | `report.logistics.read` | `?locationId=&from=&to=&format=` | `{itemId; itemName; opening:Qty; in:Qty; usage:Qty; waste:Qty; adjustment:Qty; closing:Qty}[]` | FR-POS-06, FR-LOG-21 |
| GET | `/api/reports/stock-movements` | `report.logistics.read` | `?locationId=&from=&to=&movementType=&format=` | movement export | FR-LOG-21, FR-SO-04 |
| GET | `/api/reports/waste` | `report.sales.read` | `?from=&to=&locationId=&format=` | waste by reason/location with values | FR-WST-04 |
| GET | `/api/reports/attendance` | `report.hr.read` | `?periodCode=&locationId=&format=` | attendance matrix per employee per day | FR-HR-03 |
| GET | `/api/reports/payroll/:runId` | `report.hr.read` | `?format=` | payroll register (all employees × components) | FR-HR-04 |
| GET | `/api/reports/opname/:opnameId` | `report.logistics.read` | `?format=` | opname variance report | FR-SO-02 |
| GET | `/api/reports/online-orders` | `report.sales.read` | `?from=&to=&platform=&locationId=&format=` | platform reconciliation report (gross→net walk) | FR-POS-05/07 |

Reporting date rule (shared with SYNC-PROTOCOL §6.4): business date = `occurred_at` in `Asia/Makassar`; a shift spanning midnight belongs to its **opening** date; `time_suspect` rows use `defensible_at`.

### 4.20 M20 `settings`

Settings are namespaced keys (table §1.1). Seed keys + defaults (contract for every module that reads them):

| Key | Default | Used by |
|---|---|---|
| `company.profile` | `{name:'Mimi Chicken', address:…, city:'Balikpapan', logoAttachmentId:null}` | print layer, slips |
| `approval.threshold.void` | `{managerAboveIdr:"200000.00"}` | §5.2 |
| `approval.threshold.po` | `{ownerAboveIdr:"10000000.00"}` | §5.3 |
| `approval.threshold.payment` | `{ownerAboveIdr:"20000000.00"}` | §5.8 |
| `approval.threshold.opname` | `{managerAboveIdr:"2000000.00"}` | §5.4 |
| `hr.geofence_radius_m` | `100` (per-location override on `locations`) | M14 (FR-HR-01) |
| `hr.late_grace_minutes` | `5` | M14/M15 (POUT-07) |
| `hr.overtime` | `{ratePerHour:"15000.00", minMinutes:30}` | M15 (PIN-02) |
| `hr.deduction_rates` | `{perAbsentDay:'daily_rate', perLateMinute:"500.00", sickPaid:true, permissionPaid:false}` | M15 (POUT-01..03/07) |
| `leave.quotas` | `{annual:12, marriage:3}` | M14 (POUT-04) |
| `payroll.so_shortfall` | `{mode:'attributable_only', splitRule:'equal_among_on_shift'}` | M15 (POUT-05) |
| `payroll.statutory` | `{enabled:false, enabledAt:null, enabledBy:null}` — **Amendment 1 gate**; flipped ONLY via the §4.15 enable/disable endpoints (wizard), never by raw settings PUT (`ERR_USE_WIZARD`) | M15/M20 |
| `pos.cash_variance_propose_above` | `"0.00"` — shift-close shortfall beyond this auto-creates a pending deduction proposal (Amendment 2) | M13/M15 |
| `coldchain.frozen` | `{minC:"-25.0", maxC:"-15.0"}` (mirrors `shipment_types`) | M10 (D-14) |
| `auth.offline_credential_ttl_h` | `24` | M01 (D-17) |
| `offline.selfie_required_above` | `"200000.00"` | §7 flows |
| `offline.approval_volume_cap` | `20` | SYNC-PROTOCOL §7.4 |
| `sync.max_offline_window_h` | `24` | SYNC-PROTOCOL §6.4 |
| `sync.price_variance_tolerance` | `{pct:"1.0"}` | R4 |
| `pos.qris` | `{mode:'static'}` | M13 |
| `wa.enabled` | `false` (flips when D-03 credentials arrive; outbox mock until then) | kernel notification |

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/settings` | `settings.read` | `?prefix=` | `{key:string; value:object; description:string; updatedBy:string\|null; updatedAt:ISODateTime}[]` | SCOPE-IN-10 |
| GET | `/api/settings/:key` | `settings.read` | – | one setting | – |
| PUT | `/api/settings/:key` | `settings.manage` | `{value:object}` (schema-validated per key in `packages/shared`) | setting — emits `settings.updated` master event | – |
| GET | `/api/settings/approval-chains` | `settings.read` | – | `{documentType:string; steps:{stepNo:number; approverRole:string; minAmount:Money\|null; maxAmount:Money\|null}[]}[]` (§5 as data) | SCOPE-IN-10 |
| PUT | `/api/settings/approval-chains/:documentType` | `settings.approval_chain.manage` | `{steps:[...]}` — validated against §5 invariants (first step role fixed per doc type) | chain | APR-01..08 |

### 4.21 M21 `device-registry` (D-13)

```ts
interface Device { id: UUID; locationId: UUID; locationName: string; nodeId: UUID|null;
                   category: DeviceCategory; name: string; status: DeviceStatus; appVersion: string|null;
                   queueDepth: number; lastSeenAt: ISODateTime|null; lastSyncAt: ISODateTime|null;
                   replacesDeviceId: UUID|null; ipAddress: string|null; vendor: string|null; model: string|null;
                   pairedAt: ISODateTime|null }
```

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| POST | `/api/devices/pairing-tokens` | `device.pair` | `{locationId:UUID; targetType:'device'; suggestedCategory?:DeviceCategory}` | `{tokenId:UUID; token:string; displayCode:string; qrPayload:string; expiresAt:ISODateTime /* +15 min, single-use */}` | D-13, §7.2 |
| POST | `/api/devices/register` | (public + pairing token in body) | `{token:string; fingerprint:string; name?:string; category:DeviceCategory; appVersion:string; osInfo?:object; replacesDeviceId?:UUID}` | `{deviceId:UUID; deviceToken:string /* long-lived, scope: heartbeat+sync */; location:{id; code; name}; nodeLanUrl:string\|null; syncConfig:{cloudUrl:string; protocolV:number}}` | D-13, SYNC-PROTOCOL §1.5 |
| POST | `/api/devices/heartbeat` | (device-token) | `DeviceHeartbeat` (§7.3 shape) — also accepted over socket per SYNC-PROTOCOL §4.6 | `{ok:true; serverTime:ISODateTime; confirmedThrough?:object}` | D-13 |
| GET | `/api/devices` | `device.read` | `?locationId=&category=&status=&page=` | `Paginated<Device>` | D-13 |
| GET | `/api/devices/:id` | `device.read` | – | `Device & {recentHeartbeats:{at; queueDepth; appVersion; batteryPct}[]; events: {type; detail; createdAt}[]}` | D-13 |
| PATCH | `/api/devices/:id` | `device.manage` | `{name?; category?; locationId?}` | `Device` | D-13 |
| POST | `/api/devices/:id/unpair` | `device.manage` | `{reason?:string}` — revokes device token, status `unpaired`; un-synced queue stays attributable via registry | `Device` | D-13 |
| POST | `/api/devices/:id/retire` | `device.manage` | `{replacedByDeviceId?:UUID}` | `Device` (retired) | SYNC-PROTOCOL §1.5 |
| GET | `/api/topology` | `topology.read` | – | `TopologyTree` (§7.5 shape) | D-13 |
| GET | `/api/topology/summary` | `topology.read` | – | `{totals:TopologyCounts; byCity:{city:string; counts:TopologyCounts; outletsOffline:number}[]}` | D-13, FR-DASH-04 |

Status sweep (M21 owns): every 30 s, recompute device/node status from `last_seen_at` vs §7.4 thresholds; on transition write `device_events` + emit socket `topology:update`; **outlet-offline alert** fires only when ALL of an outlet's devices AND its node (if any) are offline for > 10 min (alert precision, W6-06).

### 4.22 M22 `node-gateway` (D-12/D-13)

Socket namespace `/bridge` (node ↔ cloud; AIRE pattern: node connects outbound, authenticates with its node token). Events: `node:register`, `node:heartbeat` (30 s), `discovery:report`, `command:ack`, `logs:chunk`. The `/sync` namespace (M23) is separate — a node holds both.

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| POST | `/api/nodes/pairing-tokens` | `node.manage` | `{locationId:UUID}` | same shape as device pairing token (`targetType:'node'`) | D-12 |
| POST | `/api/nodes/register` | (public + pairing token) | `{token:string; hostname:string; version:string; osInfo?:object}` | `{nodeId:UUID; nodeToken:string; lanCert:{dnsName:string; pem:string; keyPem:string; expiresAt} /* SYNC-PROTOCOL §1.3 */; config:object}` | D-12 |
| GET | `/api/nodes` | `node.read` | `?locationId=&status=` | `{id; locationId; locationName; name; status:DeviceStatus; version; ipAddress; lastSeenAt; deviceCount:number; relayQueueDepth:number}[]` | D-13 |
| GET | `/api/nodes/:id` | `node.read` | – | node detail + recent heartbeats + discovered device counts | D-13 |
| PATCH | `/api/nodes/:id` | `node.manage` | `{name?}` | node | – |
| POST | `/api/nodes/:id/command` | `node.manage` | `{type:'restart'\|'update'\|'log_pull'\|'discovery_scan'; params?:object}` | `{commandId:UUID; status:'sent'}` (ack via socket → `device_events`) | D-13, W5-07 |
| POST | `/api/nodes/:id/unpair` | `node.manage` | `{reason?}` — revokes token; location devices fall back to cloud-direct | node (unpaired) | D-12 |
| GET | `/api/nodes/:id/discovered-devices` | `node.read` | `?status=new\|confirmed\|ignored` | `{id; source:DiscoverySource; ipAddress; macAddress; vendor; model; suggestedCategory; suggestedName; firstSeenAt; lastSeenAt; status}[]` | D-13 |
| POST | `/api/nodes/discovered/:id/confirm` | `device.pair` | `{category:DeviceCategory; name:string}` — creates a `devices` row (status from node reachability), links `confirmed_device_id` | `Device` | D-13 |
| POST | `/api/nodes/discovered/:id/ignore` | `device.pair` | – | `{ok:true}` | D-13 |

### 4.23 M23 `sync` (D-12; wire contract = SYNC-PROTOCOL §4 — paths verbatim)

Device/node-facing (device-token auth; socket namespace `/sync` primary, HTTP fallback identical bodies):

| Method | Path | Auth | Request / Response | FR |
|---|---|---|---|---|
| GET | `/sync/v1/health` | (public) | → `{ok:boolean; protocol_v:number; server_time:ISODateTime; tier:'cloud'\|'node'}` | D-12 |
| POST | `/sync/v1/hello` | device-token | SYNC-PROTOCOL §4.2 handshake body → `hello:ack` (resume_cursor, confirmed_through, scope) | D-12 |
| POST | `/sync/v1/push` | device-token | §4.3 `{batch_id; sent_at; events[≤200, ≤1MB]}` → `{accepted_through; confirmed_through; rejected[]; resend_from?}` | D-12, D-02 |
| GET | `/sync/v1/pull` | device-token | `?cursor=&limit≤500` → `{events; next_cursor; has_more}` | D-12 |
| POST | `/sync/v1/bootstrap` | device-token | `{scope}` → chunked snapshot pages + `starting_cursor` (§4.6) | D-12 |
| PUT | `/sync/v1/attachments/:sha256` | device-token | binary body (resumable) → `{ok:true; attachmentId:UUID}` (cloud only; §4.7) | NFR-09 |

Admin/monitoring (user JWT):

| Method | Path | Permission | Request | Response | FR |
|---|---|---|---|---|---|
| GET | `/api/sync/status` | `sync.status.read` | `?locationId=` | `{locationId:UUID; locationName:string; devices:{deviceId:UUID; name:string; queueDepth:number; quarantineDepth:number; lastSyncAt:ISODateTime\|null; cursorLag:number; status:DeviceStatus}[]; node:{nodeId:UUID; relayQueueDepth:number; lastSyncAt}\|null; openConflicts:number; openExceptions:number}[]` | D-12/13, F12 |
| GET | `/api/sync/conflicts` | `sync.conflict.resolve` | `?kind=&queue=&status=&locationId=&page=` | `Paginated<{id; kind:SyncConflictKind; queue:SyncQueue; entity:string; entityId:UUID; locationName:string; winnerEventId:UUID\|null; loserEventId:UUID\|null; detail:object; physicalEffectSuspected:boolean; status; createdAt; resolveInUrl:string /* deep link to owning domain UI per §5.4 */}>` | D-12 |
| POST | `/api/sync/conflicts/:id/dismiss` | `sync.conflict.resolve` | `{reason:string}` (visibility-only entries; entries requiring domain resolution reject with `ERR_RESOLVE_IN_DOMAIN`) | conflict | D-12 |
| GET | `/api/sync/reconciliations` | `sync.status.read` | `?status=&locationId=&page=` | `Paginated<{id; locationName; storageAreaName; itemName; tier; expectedQty:Qty; storedQty:Qty; divergence:Qty; status; detectedAt}>` (D-16 exceptions) | D-16 |
| POST | `/api/sync/reconciliations/:id/resolve` | `sync.conflict.resolve` | `{resolution:string; adjustmentId?:UUID}` | row | D-16 |
| POST | `/api/sync/reconcile/:locationId` | `sync.conflict.resolve` | – (trigger R1/R2 recompute now) | `{jobId:UUID; started:true}` | D-16 |
| GET | `/api/sync/events` | `sync.status.read` | `?originDeviceId=&entity=&applyStatus=&from=&page=` | `Paginated<sync_event row (§1.13, payload truncated)>` — debugging/forensics | OBJ-03 |

---

## 5. Approval state machines (kernel engine D-08; chains seeded in `approval_chain_steps`)

Global rules:
- **Reason is MANDATORY** on every `reject` and every `amend` (FR-LOG-13, FR-SO-02, FR-AUDIT-02) — the engine refuses the transition without it (`ERR_REASON_REQUIRED`).
- **Offline-provisional (D-17)** is allowed ONLY where the table says so — the closed list from SYNC-PROTOCOL §7.6: `void_refund.approve`, `replenishment` supervisor step, `waste.approve` outlet step. Everything else attempted offline is UI-blocked and cloud-rejected (`authority_violation`) — explicitly including opname adjudication, payment verification, and **cash-variance proposal decisions (§5.9, Amendment 2)**. Offline approvals write `offline_authorized=true` and re-verify per SYNC-PROTOCOL §7.4 (outcomes `verified/failed/unprovable`); an online decision always supersedes an offline-provisional one (§5.3 precedence there).
- Threshold steps read `settings.approval.threshold.*`; a step whose `[min_amount, max_amount)` window excludes the document amount is auto-`skipped`.
- Every transition audits actor + timestamp + before/after (FR-LOG-05, FR-SO-01, FR-WST-02, FR-ACCT-02).
- MGR/OWN may act on any step at or below their level (role-rank override), recorded as themselves.

### 5.1 Replenishment request (FR-LOG-10/11; chain: SPV → KGD)

| Current | Action | Role | Next | Reason req. | Offline (D-17) |
|---|---|---|---|---|---|
| `draft` | submit | LDR/SPV (`replenishment.submit`) | `submitted` | – | queued as event (capture, not approval) |
| `draft` | delete | creator | *(gone)* | – | yes |
| `submitted` | approve (± amend qty) | SPV (`replenishment.approve.supervisor`) | `awaiting_approval` | amend ⇒ per-line reason | **YES — provisional** (§7.6) |
| `submitted` | reject | SPV | `rejected` | **yes** | no (reject waits for online) |
| `awaiting_approval` | approve (± amend qty) | KGD (`replenishment.approve.warehouse`) | `approved` | amend ⇒ per-line reason | **no** (warehouse = online, §7.6) |
| `awaiting_approval` | reject | KGD | `rejected` | **yes** | no |
| `approved` | process (picking) | KGD | `processing` | – | no |
| `processing` | dispatch (via SJ) | KGD (M10 event) | `shipped` | – | no |
| `shipped` | receive (drop received) | LDR/SPV (M10 event) | `received` | discrepancy ⇒ per-line reason | receiving is a fact — queued offline, yes |
| `received` | auto-complete (lines reconciled) | system | `completed` | – | – |

### 5.2 Void / refund (FR-POS-03, APR-02; chain: SPV → MGR above threshold)

| Current | Action | Role | Next | Reason req. | Offline (D-17) |
|---|---|---|---|---|---|
| *(sale completed)* | request void/refund | KSR (`pos.void.request`) | `pending` | **yes** (alasan void) | yes (fact capture) |
| `pending` | approve | SPV (`pos.void.approve`) + PIN; MGR step if amount ≥ `approval.threshold.void.managerAboveIdr` | `approved` → sale `voided/refunded`, payments + usage reversed, journal `SALE_VOID_REVERSAL` | – | **YES — provisional**, PIN + selfie ≥ `offline.selfie_required_above`; re-verified §7.4; failed+cash-gone ⇒ finance queue + `OFFLINE_AUTH_REJECTED` posting (§6.3) |
| `pending` | reject | SPV/MGR | `rejected` | **yes** | no |

Note: the MGR threshold step cannot be satisfied offline — an offline approval above the supervisor's scope cap (`scopes['void_refund.approve'].max_idr`) is impossible to record (client blocks; cloud would fail §7.4 check 5).

### 5.3 Purchase request → purchase order (FR-PO, F-PUR-01; PR chain: MGR; PO chain: MGR → OWN above threshold)

| Current | Action | Role | Next | Reason req. | Offline |
|---|---|---|---|---|---|
| PR `draft` | submit | KGD/SPV (`purchasing.pr.create`) | PR `submitted` | – | no (class X — online surfaces) |
| PR `submitted` | approve | MGR (`purchasing.pr.approve`) | PR `approved` | – | no |
| PR `submitted` | reject | MGR | PR `rejected` | **yes** | no |
| PR `approved` | convert (create PO) | KGD/MGR (`purchasing.po.create`) | PR `converted`, PO `draft` | – | no |
| PO `draft` | submit | KGD/MGR | PO `pending_approval` | – | no |
| PO `pending_approval` | approve step 1 | MGR (`purchasing.po.approve`), total < `ownerAboveIdr` ⇒ chain ends | PO `approved` | – | no |
| PO `pending_approval` | approve step 2 | OWN, total ≥ `ownerAboveIdr` | PO `approved` | – | no |
| PO `pending_approval` | reject | MGR/OWN | PO `draft` (with reason, editable) | **yes** | no |
| PO `approved` | issue | KGD/MGR | `issued` | – | no |
| `issued`/`partially_received` | receive (po_receipts verify) | KGD/LDR (`purchasing.po.receive`) | `partially_received` → `received` when all lines full | short/over ⇒ condition notes (FR-PO-03) | no |
| `received` | close | FIN (`purchasing.po.close`; requires payment `paid`) | `closed` | – | no |
| any pre-`received` | cancel | MGR/OWN | `cancelled` | **yes** | no |

### 5.4 Stock opname adjustment (FR-SO-02/03/04; chain: SPV [outlet] / KGD [warehouse] → MGR above threshold)

| Current | Action | Role | Next | Reason req. | Offline |
|---|---|---|---|---|---|
| `counting` | record counts | LDR/SPV/KGD (`opname.create`) | `counting` | diff ≠ 0 ⇒ variance reason per line | yes (counting is fact capture, §8 row 8) |
| `counting` | submit | same (`opname.submit`) | `submitted` | blocked while C1 disputes open | yes (queued) |
| `submitted` | approve step 1 | SPV (outlet) / KGD (warehouse) (`opname.approve`) | step 2 if `|variance value|` ≥ `approval.threshold.opname.managerAboveIdr`, else `approved`→`adjusted` | – | **no — adjudication is online-only** (SYNC-PROTOCOL §7.6/§8 row 9) |
| `submitted` (step 2) | approve | MGR | `approved` → `adjusted` (ledger posts `adjustment_in/out`; journal JGUD-06/JOUT-06; attributable shortfall → POUT-05 source) | – | no |
| `submitted` | reject | approver | `rejected` | **yes** | no |
| `draft`/`counting` | cancel | creator | `cancelled` | – | yes |

### 5.5 Retur outlet → gudang (8.8.1; chain: SPV approve, KGD receive-accept)

| Current | Action | Role | Next | Reason req. | Offline |
|---|---|---|---|---|---|
| `draft` | submit (+photos wajib) | LDR/SPV (`return.create`) | `submitted` | line reasons required (FR-WST-01) | yes (fact capture) |
| `submitted` | approve | SPV (`return.approve`) | `approved` | – | no (not in §7.6 — only *waste* has an offline outlet step) |
| `submitted` | reject | SPV | `rejected` | **yes** | no |
| `approved` | ship (+proof wajib) | LDR/SPV (`return.ship`) | `in_transit` (ledger `return_out`; journal JOUT-05) | – | yes (fact) |
| `in_transit` | receive (+proof wajib) | KGD (`return.receive`) | `received` (ledger `return_in` at gudang; journal JGUD-02) | qty mismatch ⇒ per-line reason | no (warehouse online) |
| `received` | complete | KGD/MGR (`return.approve`) | `completed` | – | no |

### 5.6 Retur gudang → supplier (8.8.2; chain: KGD; class X — online only)

| Current | Action | Role | Next | Reason req. | Offline |
|---|---|---|---|---|---|
| `draft` | submit (+photos) | KGD (`return.create`) | `submitted` | line reasons | no |
| `submitted` | approve | KGD…MGR (`return.approve`) | `approved` | – | no |
| `submitted` | reject | KGD/MGR | `rejected` | **yes** | no |
| `approved` | ship to supplier (+proof) | KGD (`return.ship`) | `in_transit` (ledger `return_out`; journal JGUD-04 — AP debit) | – | no |
| `in_transit` | supplier accepted | KGD (`return.approve` via `/complete`) | `completed` (credit note ref recorded) | – | no |

### 5.7 Payroll run (FR-HR-04; chain: FIN → OWN; never offline)

| Current | Action | Role | Next | Reason req. | Offline |
|---|---|---|---|---|---|
| `draft` | calculate | HRA (`payroll.run.calculate`) | `calculated` | – | no |
| `calculated` | edit line | HRA | `calculated` | override reason **required** | no |
| `calculated` | submit | HRA (`payroll.run.submit`) | `pending_approval` | – | no |
| `pending_approval` | approve step 1 | FIN (`payroll.run.approve`) | step 2 | – | no |
| `pending_approval` | approve step 2 | OWN | `approved` (journal `PAYROLL_ACCRUAL`; PV row pending; loans amortized POUT-06) | – | no |
| `pending_approval` | reject | FIN/OWN | `calculated` | **yes** | no |
| `approved` | mark paid | FIN/OWN (`payroll.run.pay`; PV must be `paid`) | `paid` (journal `PAYROLL_PAYMENT`; slips sendable 8.3.3) | – | no |
| `draft`/`calculated` | cancel | HRA | `cancelled` | **yes** | no |

### 5.8 Payment verification (8.9.1 Pending → Verified → Paid; FR-ACCT-01..04; never offline)

| Current | Action | Role | Next | Reason req. | Offline |
|---|---|---|---|---|---|
| *(created by flow: PO receipt, payroll approve, petty cash verify, maintenance complete, transfer sale, manual)* | – | system/`payment.proof.upload` | `pending` | – | proof upload may originate offline (attachment side-channel); status stays `pending` |
| `pending` | attach proof + ref | any `payment.proof.upload` | `pending` (proof recorded, FR-ACCT-01) | – | – |
| `pending` | verify | FIN (`payment.verify`; proof required) | `verified` (verifier + time recorded, FR-ACCT-02) | – | **no — never offline** (§7.6) |
| `pending` | reject | FIN (`payment.reject`) | `rejected` | **yes** | no |
| `verified` | pay | FIN (`payment.pay`); OWN approval step first when amount ≥ `approval.threshold.payment.ownerAboveIdr` | `paid` (journal per ref type §6) | – | no |
| `verified` | reject | FIN | `rejected` | **yes** | no |

### 5.9 Cash variance proposal (Amendment 2 — auto-propose, human-approve; supersedes A-17)

| Current | Action | Role | Next | Reason req. | Offline |
|---|---|---|---|---|---|
| *(shift closed with shortfall > `pos.cash_variance_propose_above`)* | auto-create | system (R7 / shift-close apply) | `pending` — linked to `shift_id` + kasir; notification to SPV of the location | – | proposal creation is cloud-side; the closing itself queues offline as a fact |
| `pending` | approve | SPV (`pos.cash_variance.approve`; MGR/OWN override) | `approved` — becomes a `deduction_cash_variance` payroll line in the employee's next run (`source_ref_type='cash_variance_proposal'`) | **yes — reason REQUIRED on approve too** | **NO — excluded from D-17** (consistent with SYNC-PROTOCOL §7.6: money-finalizing decisions converge on the cloud) |
| `pending` | reject | SPV/MGR/OWN | `rejected` — stays visible as an R7 exception trail | **yes** | no |
| `pending` | cancel | MGR/OWN | `cancelled` (e.g. shift close corrected/recounted) | **yes** | no |

A proposal never reaches payroll while `pending`; M15's calculate consumes only `approved` proposals not yet linked to a run.

### 5.10 Minor chains (same engine)

- **Leave request** (§4.14): `pending → approved/rejected/cancelled`; approve SPV/HRA/MGR; reject reason required; decisions online-only.
- **Employee loan** (POUT-06): `pending → active (approve FIN→MGR/OWN) / rejected`; reason on reject; online-only.
- **Waste** (§4.12; `ApprovalDocumentType.WASTE = 'waste'`): `pending → approved/rejected`; approver SPV (outlet — **offline-provisional YES**, §7.6, scope cap `waste.approve.max_idr`) / KGD (gudang — online only); reject reason required; stock+journal effect only on approval.

---

## 6. Posting rules & chart of accounts (D-04)

The posting engine (M17) subscribes to **applied** domain events (an event in sync quarantine posts nothing — SYNC-PROTOCOL §5.1) and materializes `journal_entries` from the declarative `posting_rules` rows below. Idempotent per `(event_type, ref_type, ref_id)`. High-volume outlet events (`OUTLET_SALES`, `OUTLET_INGREDIENT_USAGE`) are aggregated **per outlet per business date** (`ref_type='sale_day'`, `ref_id=hash(location,date)`) — one balanced entry a day per outlet, with drill-down via the fact tables. Every entry carries `location_id` so "Jurnal Gudang" vs "Jurnal Outlet" (PRD 8.9.2) is a filter, not a second ledger.

### 6.1 Seed chart of accounts (`is_system=true`; W1-C seeds; codes are contract)

| Code | Name (id-ID) | Type | Normal |
|---|---|---|---|
| 1000 | Kas Outlet | asset | debit |
| 1010 | Kas Kecil (Petty Cash) | asset | debit |
| 1020 | Bank | asset | debit |
| 1030 | Piutang Platform Online | asset | debit |
| 1031 | Piutang QRIS | asset | debit |
| 1032 | Piutang Transfer | asset | debit |
| 1100 | Persediaan Gudang | asset | debit |
| 1110 | Persediaan Outlet | asset | debit |
| 1120 | Persediaan Dalam Perjalanan | asset | debit |
| 1210 | Piutang Karyawan (Kasbon) | asset | debit |
| 1220 | Piutang Klaim Karyawan | asset | debit |
| 1500 | Aset Tetap | asset | debit |
| 2000 | Hutang Supplier | liability | credit |
| 2100 | Hutang Gaji | liability | credit |
| 2110 | Hutang BPJS | liability | credit |
| 2120 | Hutang PPh21 | liability | credit |
| 2200 | Hutang Lainnya | liability | credit |
| 3000 | Modal | equity | credit |
| 3100 | Laba Ditahan | equity | credit |
| 4000 | Pendapatan Penjualan | revenue | credit |
| 4100 | Pendapatan Lainnya | revenue | credit |
| 5000 | Beban Pokok Penjualan (HPP) | expense | debit |
| 5090 | Penyesuaian Nilai Persediaan | expense | debit |
| 5100 | Beban Waste/Rusak/Expired | expense | debit |
| 6000 | Beban Gaji | expense | debit |
| 6010 | Beban BPJS (Perusahaan) | expense | debit |
| 6100 | Beban Operasional Outlet | expense | debit |
| 6200 | Beban Maintenance | expense | debit |
| 6300 | Beban Komisi Platform | expense | debit |
| 6400 | Beban Selisih Stok | expense | debit |

### 6.2 The 16 PRD journal event types (FR-ACC-JGUD-01..07, FR-ACC-JOUT-01..09)

| # | JournalEventType | Trigger (domain event, applied) | Debit | Credit | Amount source |
|---|---|---|---|---|---|
| JGUD-01 | `GUDANG_PURCHASE` | `po_receipts` verified (M11) | 1100 Persediaan Gudang | 2000 Hutang Supplier | `Σ receipt_line.qty_received × po_line.unit_price` |
| JGUD-02 | `GUDANG_GOODS_IN` | `returns.received_at_warehouse` (outlet→gudang leg) | 1100 Persediaan Gudang | 1120 Dalam Perjalanan | `Σ line.qty_received × line.unit_cost` |
| JGUD-03 | `GUDANG_GOODS_OUT_TO_OUTLET` | `surat_jalan` dispatched (M10) | 1120 Dalam Perjalanan | 1100 Persediaan Gudang | `Σ sj_line.qty × items.avg_cost` at dispatch |
| JGUD-04 | `GUDANG_RETURN_TO_SUPPLIER` | `returns.shipped` (gudang→supplier leg) | 2000 Hutang Supplier | 1100 Persediaan Gudang | `Σ line.qty × line.unit_cost` |
| JGUD-05 | `GUDANG_WASTE` | `waste_records` approved at warehouse | 5100 Beban Waste | 1100 Persediaan Gudang | `Σ qty × unit_cost` (at approval) |
| JGUD-06 | `GUDANG_STOCK_ADJUSTMENT` | `stock_adjustments` applied at warehouse — condition `{direction:'shortage'}` / `{direction:'overage'}` | shortage: 6400 Beban Selisih · overage: 1100 | shortage: 1100 · overage: 4100 Pendapatan Lainnya | `|qty_delta| × unit_cost` |
| JGUD-07 | `GUDANG_STOCK_REVALUATION` | manual cost revaluation (M17, FIN) — condition `{direction:'up'/'down'}` | up: 1100 · down: 5090 | up: 5090 · down: 1100 | `Σ qty_on_hand × Δcost` (see Appendix A-8: primarily a report; rule exists for the manual event) |
| JOUT-01 | `OUTLET_GOODS_IN_FROM_WAREHOUSE` | `sj_drops.received` — rule 1 (received value) | 1110 Persediaan Outlet | 1120 Dalam Perjalanan | `Σ line.qty_received × cost` |
| JOUT-01b | 〃 — rule 2, condition `{discrepancy:true}` (shortfall in transit) | 6400 Beban Selisih Stok | 1120 Dalam Perjalanan | `Σ (qty − qty_received) × cost` — pending C2/C6 investigation outcome |
| JOUT-02 | `OUTLET_INGREDIENT_USAGE` | daily aggregate of applied `sales.completed` recipe explosions | 5000 HPP | 1110 Persediaan Outlet | `Σ usage_out.qty × unit_cost` for the day |
| JOUT-03 | `OUTLET_SALES` | daily aggregate of applied `sales.completed` — one rule per payment method: `{method:'cash'}`→1000 · `{method:'qris'}`→1031 · `{method:'bank_transfer'}`→1032; plus online orders: `{platform:any}`→ Dr 1030 net + Dr 6300 fees | 1000/1031/1032/1030 (+6300) | 4000 Pendapatan Penjualan | POS: `Σ payments.amount` by method · online: `gross` to 4000, `fees+discount` to 6300, `net` to 1030 |
| JOUT-04 | `OUTLET_WASTE` | `waste_records` approved at outlet | 5100 Beban Waste | 1110 Persediaan Outlet | `Σ qty × unit_cost` |
| JOUT-05 | `OUTLET_RETURN_TO_WAREHOUSE` | `returns.shipped` (outlet→gudang leg) | 1120 Dalam Perjalanan | 1110 Persediaan Outlet | `Σ qty × unit_cost` |
| JOUT-06 | `OUTLET_STOCK_ADJUSTMENT` | `stock_adjustments` applied at outlet — conditions as JGUD-06, plus `{attributable:true}` variant | shortage: 6400 (or 1210 Piutang Karyawan when attributable → POUT-05) · overage: 1110 | shortage: 1110 · overage: 4100 | `|qty_delta| × unit_cost` |
| JOUT-07 | `OUTLET_DIRECT_PURCHASE` | `petty_cash` verified with stockable lines / `po_receipts` at outlet | 1110 Persediaan Outlet | 1010 Kas Kecil (petty) / 2000 (PO) | `Σ stockable line amount` |
| JOUT-08 | `OUTLET_PETTY_CASH` | `petty_cash` verified, non-stockable lines | 6100 Beban Operasional Outlet (per `expense_category` mapping) | 1010 Kas Kecil | `Σ non-stockable line amount` |
| JOUT-09 | `OUTLET_OPERATING_EXPENSE` | `payment_verifications.paid` with `ref_type='other'` + outlet location | 6100 Beban Operasional Outlet | 1020 Bank / 1000 Kas (per `paid_via`) | `pv.amount` |

### 6.3 System extension rules (D-04 beyond the PRD's 16 — each marked with its rationale)

| # | Event | Trigger | Debit | Credit | Amount | Why beyond PRD |
|---|---|---|---|---|---|---|
| X1 | `PAYROLL_ACCRUAL` | payroll run approved | 6000 Beban Gaji (gross) | 2100 Hutang Gaji (net) + 1210 Piutang Karyawan (loan installments) + 1220/6400 (SO shortfall recovery) | run totals | full GL needs the liability leg the PRD's cash-journal wording skips |
| X1s | `PAYROLL_ACCRUAL` — statutory legs, condition `{statutoryMode:true}` (Amendment 1) | same trigger, only on `statutory_mode=true` runs | 6010 Beban BPJS (employer_cost lines); employee deductions reduce the 2100 net leg | 2110 Hutang BPJS (all BPJS shares) + 2120 Hutang PPh21 (PPh21 lines) | Σ statutory lines by component | statutory withholdings are liabilities to BPJS/DJP until remitted |
| X2 | `PAYROLL_PAYMENT` | payroll PV `paid` | 2100 Hutang Gaji | 1020 Bank | `total_net` | 〃 — BPJS/PPh21 remittances post separately as PV `paid` with `ref_type='other'` (Dr 2110/2120, Cr 1020) |
| X3 | `QRIS_SETTLEMENT` | finance records QRIS settlement (PV `paid`, ref `sale_payment`) | 1020 Bank | 1031 Piutang QRIS | settled amount | QRIS settles T+1; receivable must clear |
| X4 | `TRANSFER_VERIFIED` | transfer sale payment verified→paid | 1020 Bank | 1032 Piutang Transfer | payment amount | NFR-09 Pending→Verified→Paid made ledger-real |
| X5 | `PLATFORM_SETTLEMENT` | platform payout recorded (PV `paid`, ref `online_order`) | 1020 Bank | 1030 Piutang Platform | payout amount | FR-POS-07 net-received completion |
| X6 | `SALE_VOID_REVERSAL` | void/refund effectively approved | 4000 Pendapatan (Dr, reversal) + 1110 (Dr, usage back) | 1000/1031/1032 (payment back) + 5000 HPP (Cr) | sale amounts | voids must unwind both revenue and HPP |
| **X7** | **`OFFLINE_AUTH_REJECTED`** | **finance verdict `rejected` on an offline-authorized action whose physical effect already happened (SYNC-PROTOCOL §7.5)** | **1220 Piutang Klaim Karyawan** | refund/void: 4000 Pendapatan (re-recognized) · waste: 5100 Beban Waste (reversal) | document amount | **AMENDMENT beyond the PRD's 16 (coordinator-directed): the ledger is append-only and the cash/goods are already gone — the unwind is a *claim receivable* against the responsible parties (recoverable via payroll deduction or write-off), never a deletion or silent reversal** |

Petty-cash float top-up (`Dr 1010 / Cr 1020`) and loan disbursement (`Dr 1210 / Cr 1020`) post from their PV `paid` events under X-family rules (`ref_type='petty_cash_topup'|'employee_loan'`).

---

## 7. Topology contract (D-13; ported from AIRE `device-registry`/`topology.ts`, adapted to Mimi)

### 7.1 Registration model

- **Devices** (Tier 1) self-register with a single-use pairing token (§4.21): admin/supervisor mints token (QR + 12-char `display_code`, TTL 15 min) → device POSTs `/api/devices/register` with token + `fingerprint` (stable install identity) → receives `deviceId` + long-lived `deviceToken` (scope: `heartbeat`,`sync`) + its location + node LAN URL if one exists. A wiped/reinstalled PWA registers as a **new** device id with `replacesDeviceId` linking the physical predecessor (SYNC-PROTOCOL §1.5).
- **Branch nodes** (Tier 2, optional) pair identically via `targetType:'node'` tokens (§4.22) and additionally receive their LAN TLS certificate. One node max per location (`branch_nodes.location_id UNIQUE`).
- **Passive devices** (printers, routers) enter the registry two ways: manual creation (PATCH-able rows, `device.manage`) or **LAN discovery** where a node exists (mDNS/SSDP/ONVIF/bounded TCP probe → `discovered_devices` → human confirm → `devices` row). Without a node, topology degrades gracefully to app-session devices only — same UI, fewer nodes (D-13).

### 7.2 Heartbeat payloads (wire shapes; SYNC-PROTOCOL §4.6 channel — lossy, not sync events)

```ts
interface DeviceHeartbeat {            // every 60 s while the PWA is awake; also on visibility/connectivity change
  deviceId: UUID;
  at: ISODateTime;                     // client clock (skew measurement input)
  appVersion: string;                  // D-13
  queueDepth: number;                  // D-13: outbox events not yet confirmed
  quarantineDepth: number;             // poison events held locally
  pullLag: number;                     // upstream server_seq − local cursor
  lastSyncAt: ISODateTime | null;
  storage: { usedMb: number; quotaMb: number };
  clockOffsetMs: number;               // last measured vs upstream
  batteryPct?: number;
  networkType?: 'wifi' | 'cellular' | 'ethernet' | 'unknown';
  activeUserId?: UUID | null;          // who is logged in (POS attribution)
  shiftOpen?: boolean;                 // POS devices
}
interface NodeHeartbeat {              // every 30 s (socket /bridge)
  nodeId: UUID;
  at: ISODateTime;
  version: string;
  uptimeSec: number;
  relayQueueDepth: number;             // device events not yet cloud-confirmed
  deviceCount: number;                 // LAN devices currently connected to the node
  deviceSummaries: { deviceId: UUID; lastSeenAt: ISODateTime; queueDepth: number }[];  // aggregated LAN view
  discoveryLastRunAt: ISODateTime | null;
  db: { ok: boolean; sizeMb: number };
  system: { cpuPct: number; memPct: number; diskFreePct: number };
  clockOffsetMs: number;
}
```

Heartbeat ingest updates `devices/branch_nodes` (`last_seen_at`, `app_version`, `queue_depth`, `status`) and appends `device_heartbeats` (7-day retention). Version change ⇒ `device_events.version_changed`. `|clockOffsetMs| > 120000` ⇒ `clock_skew` event + F12 flag (SYNC-PROTOCOL §6.3). `queueDepth > 200` or growing monotonically for > 2 h ⇒ `queue_alert` + notification.

### 7.3 Staleness thresholds & status rules (M21 sweep every 30 s; single source of truth)

| Subject | Beat interval | → `stale` after | → `offline` after | Notes |
|---|---|---|---|---|
| Device (PWA) | 60 s awake | 180 s (3 missed) | 600 s | a closed/slept tablet drifts stale→offline naturally; that is expected outside opening hours |
| Branch node | 30 s | 90 s | 300 s | AIRE liveness constant preserved |
| Outlet (derived) | – | – | ALL its devices offline AND node offline (or absent) for > 10 min | the only condition that fires the **outlet-offline alert** (notification `outlet_offline` to MGR/OWN + `device_events.outlet_offline`) — a single tablet sleeping never pages anyone (W6-06 alert precision) |

Transitions (never repeats, only edges): `online→stale→offline` and any `→online` recovery emit `device_events` + socket `topology:update` + (for offline/online of nodes and outlets) notifications. First sighting is silent (AIRE rule). `unpaired`/`retired` are administrative and excluded from sweeps.

### 7.4 Topology tree JSON (`GET /api/topology`) — Pusat → Kota → Outlet → Node → Device

```ts
interface TopologyTree {
  generatedAt: ISODateTime;
  pusat: TopologyLocation;                       // the warehouse (Balikpapan)
  cities: { city: string; counts: TopologyCounts; outlets: TopologyLocation[] }[];
  totals: TopologyCounts & { outletsOffline: number; openConflicts: number; openExceptions: number };
}
interface TopologyLocation {
  location: { id: UUID; code: string; name: string; type: 'warehouse'|'outlet'; city: string };
  node: TopologyNode | null;                     // null = no branch node installed (default deployment)
  devices: TopologyDevice[];                     // UI groups by category
  counts: TopologyCounts;
  syncHealth: {                                  // D-12/D-13 per-outlet sync visibility
    queueDepth: number;                          // Σ device outboxes + node relay queue
    quarantineDepth: number;
    lastSyncAt: ISODateTime | null;              // max over devices
    conflictsOpen: number;
    exceptionsOpen: number;
    offlineAuthPending: number;                  // D-17 pending re-verification/verdict
  };
  outletStatus: 'online' | 'degraded' | 'offline';   // degraded = some devices offline / queue growing
}
interface TopologyNode { id: UUID; name: string; status: 'online'|'stale'|'offline'; version: string | null;
                         lastSeenAt: ISODateTime | null; relayQueueDepth: number; discoveredNewCount: number }
interface TopologyDevice { id: UUID; name: string; category: DeviceCategory; status: DeviceStatus;
                           appVersion: string | null; queueDepth: number; lastSeenAt: ISODateTime | null;
                           ipAddress: string | null; activeUserName?: string | null; shiftOpen?: boolean }
interface TopologyCounts { online: number; stale: number; offline: number; total: number }
```

Category presentation (F12; lucide icons, port of AIRE `CATEGORY_META`): `tablet`→Tablet, `pos_terminal`→Smartphone, `printer`→Printer, `laptop`→Laptop, `router`→Router, `branch_node`→Waypoints, `other`→HardDrive. Status tokens: `online`→success/animated, `stale`→warning, `offline`→muted, `unpaired`→outline, `retired`→hidden by default.

Realtime: F12 subscribes to socket channel `topology` (`topology:update {locationId, deviceId?, nodeId?, status}` on every transition + `topology:sync {locationId, queueDepth, lastSyncAt}` throttled to 1/10 s per location).

---

## 8. File-ownership map (authoritative; copied from BUILD-PLAN §4.1/§4.2/§4.3 — collision rules §6 apply)

### 8.1 Migration block allocation (one author: W1-C; post-G1 fixes as `2NN_<agent-id>_<slug>.sql`)

| Block | Contents |
|---|---|
| `001–009` | extensions, `locations`, **`storage_areas`**, `users`, `roles`, `permissions`, `role_permissions`, `user_locations`, `sessions`, `audit_log`, `attachments`, `notifications`(+`notification_outbox`), `settings`(+`document_counters`), approval engine (`approval_chain_steps`, `approvals`, `approval_steps`), `updated_at` trigger, RLS policies |
| `010–019` | `item_categories`, `units`, `unit_conversions`, `items`, `products`, `recipes`/`recipe_lines`, `suppliers`, `supplier_items`, `supplier_price_history` |
| `020–029` | `stock_balances` (location + **storage_area** + item), `stock_movements`, `min_stock_rules`, `stock_opname`, `stock_opname_lines`, `stock_adjustments`, `stock_reconciliations` |
| `030–039` | `replenishment_requests`, `replenishment_request_lines`, **`surat_jalan`**, `sj_drops`, `sj_lines`, `sj_temperature_logs`, `sj_seals`, `drivers`, `vehicles`, `goods_receipts`, `goods_receipt_lines`, `shipment_types` |
| `040–049` | `purchase_requests`, `purchase_request_lines`, `purchase_orders`, `po_lines`, `po_receipts`, `po_receipt_lines`, `petty_cash`, `petty_cash_lines` |
| `050–059` | `pos_shifts`, `sales`, `sale_lines`, `sale_payments`, `void_refunds`, `online_orders`, `cash_variance_proposals` (Amendment 2) |
| `060–069` | `employees`, `employments`, `work_shifts`, `shift_assignments`, `attendance`, `leave_requests`, `salary_components`, `employee_salary_components`, `employee_loans`, `employee_loan_payments`, `payroll_periods`, `payroll_runs`, `payroll_lines`, + statutory (Amendment 1): `bpjs_configs`, `pph21_ter_rates`, `pph21_ptkp`, `pph21_article17_brackets`, `employee_tax_profiles` (+ Amendment 2 retro-FKs) |
| `070–079` | `assets`, `maintenance_schedules`, `maintenance_jobs`, `service_history` |
| `080–089` | `waste_records`, `returns`, `return_lines` |
| `090–099` | `chart_of_accounts`, `fiscal_periods`, `journal_entries`, `journal_lines`, `posting_rules`, `payment_verifications` |
| `100–109` | `mv_sales_daily`, `mv_item_usage_daily`, `mv_employee_kpi_daily`, `mv_delivery_recap_daily` |
| `110–119` | **`branch_nodes`, `devices`, `device_heartbeats`, `device_events`, `pairing_tokens`, `discovered_devices`** (+ retro-FKs for `device_id` columns) |
| `120–129` | **`sync_events`, `sync_batches`, `sync_cursors`, `sync_conflicts`, `offline_credentials`, `offline_authorizations`** |
| `2xx` | per-agent fix blocks: `2NN_<agent-id>_<slug>.sql`. Never renumber, never edit an applied migration. |

### 8.2 Backend modules (one agent, one directory, exclusive — BUILD-PLAN §4.2)

| # | `modules/<dir>` | Coverage | Contract section |
|---|---|---|---|
| M01 | `auth` | login, JWT, refresh, PIN, offline credential minting (D-17) | §4.1 |
| M02 | `users` | user CRUD, role + location assignment | §4.2 |
| M03 | `location` | outlets, gudang, cities, storage areas (D-15) | §4.3 |
| M04 | `item` | items, categories, units, conversions | §4.4 |
| M05 | `product` | menu products, recipes/BOM (FR-POS-06) | §4.5 |
| M06 | `supplier` | FR-SUP-01..06, price history, role-locked pricing | §4.6 |
| M07 | `inventory` | balances per area, movements, min-stock, low stock (FR-LOG-06/07/17..21) | §4.7 |
| M08 | `stock-opname` | FR-SO-01..04 per storage area | §4.8 |
| M09 | `replenishment` | FR-LOG-06..13 | §4.9 |
| M10 | `delivery` | D-14 Surat Jalan, drops, cold chain, receiving (FR-LOG-01..05, 08, 14..16) | §4.10 |
| M11 | `purchasing` | FR-PO-01..04, F-PUR-01..05, petty cash | §4.11 |
| M12 | `waste-return` | FR-WST-01..04, both retur directions | §4.12 |
| M13 | `pos` | FR-POS-01..07 | §4.13 |
| M14 | `hr` | FR-HR-01/02, attendance GPS+selfie, shifts, cuti | §4.14 |
| M15 | `payroll` | FR-HR-03/04, PIN-01..07, POUT-01..09, slip gaji | §4.15 |
| M16 | `asset` | FR-PMS-01..04 | §4.16 |
| M17 | `accounting` | D-04 GL, COA, posting engine, FR-ACCT-01..04 | §4.17, §6 |
| M18 | `dashboard` | FR-DASH-01..04 | §4.18 |
| M19 | `report` | exports, rekap pengiriman (FR-LOG-04), laporan shift | §4.19 |
| M20 | `settings` | thresholds, geofence, cold-chain limits, payroll rules | §4.20 |
| M21 | `device-registry` | D-13 devices, pairing, heartbeat, topology, stale sweep | §4.21, §7 |
| M22 | `node-gateway` | D-12/13 node socket gateway, discovery ingest, commands | §4.22 |
| M23 | `sync` | D-12 event ingest, cursors, authority, conflicts, reconciliation | §4.23, SYNC-PROTOCOL |

### 8.3 Frontend surfaces (one agent, one route group, exclusive — BUILD-PLAN §4.3)

| # | `app/<route>` | Roles | Device | Builds against |
|---|---|---|---|---|
| F01 | `(auth)/` | all | any | §4.1 |
| F02 | `pos/` | Kasir | tablet, **offline-first** | §4.13, §4.5, SYNC-PROTOCOL §8 rows 1–3, 16–17 |
| F03 | `dashboard/` | Owner, Manager | laptop | §4.18 |
| F04 | `outlet/` | Leader/Staff, Supervisor | tablet + laptop | §4.7–4.9, §4.11 (petty cash), §4.12, SYNC-PROTOCOL §8 rows 4, 6, 8, 11, 18–19 |
| F05 | `warehouse/` | Kepala Gudang | laptop | §4.7–4.10, §4.12 |
| F06 | `purchasing/` | Purchasing (=KGD/MGR) | laptop | §4.11, §4.6 |
| F07 | `finance/` | Finance, Owner | laptop | §4.17, §6 |
| F08 | `hr/` | HR Admin, Supervisor | laptop | §4.14, §4.15 |
| F09 | `assets/` | Manager, PIC | laptop + mobile | §4.16 |
| F10 | `admin/` | Owner, Manager | laptop | §4.2–4.4, §4.20, audit §4.0 |
| F11 | `me/` | every employee | **mobile** | §4.14 (absen, cuti), §4.15 (slips) |
| F12 | `topology/` | Owner, Manager, IT | laptop + wallboard | §4.21–4.23, §7 |
| F13 | `driver/` | Driver | **mobile, offline-first** | §4.10 (`my-jobs`, drop actions), SYNC-PROTOCOL §8 row 7 |

Kernel ownership (BUILD-PLAN Wave 2): W2-A `kernel/stock-ledger` (dual-mode per SYNC-PROTOCOL §5.2-C5), W2-B `kernel/approvals` (§5), W2-C `kernel/{audit,notification,storage,events}` (§4.0), W2-D `kernel/sync` (§4.23), W2-E `frontend/src/lib/local`, W2-F `apps/branch-node`.

---

## Appendix A — Resolved gaps, conflicts, and assumptions (architect decisions; owner may overrule)

| # | Gap / conflict | Resolution recorded here |
|---|---|---|
| A-1 | **PRD has 8 roles; purchasing/F06 names a "Purchasing" actor (ACT-05)** | No 9th purchasing role: purchasing is performed by `kepala_gudang` (PO create/receive) and `manager` (approve). If the client later hires a dedicated purchaser, add a role via `roles`+matrix amendment. |
| A-2 | **Drivers (D-14/F13) are not one of the PRD's 8 roles** | Added role `driver` (9th column in §3) with the minimal key set (delivery.read/drop.execute, attendance, slips, leave). A driver logging in as leader_outlet would leak outlet permissions — unacceptable for OBJ-03. Flagged as amendment-derived. |
| A-3 | **"PIC Maintenance" (ACT-10) is not a role** | Data-level assignment (`assets.assigned_to`, `maintenance_jobs.assigned_to`); execution permission `asset.job.execute` held by LDR/SPV/KGD/MGR. |
| A-4 | **BUILD-PLAN §4.1 doesn't name approval-engine tables** | `approval_chain_steps`/`approvals`/`approval_steps` allocated to block 001–009 (file 008) — D-08 needs storage before every approvable module. Also added `document_counters` (007) and `notification_outbox` (006, the RISK-P4 WA mock target). |
| A-5 | **`waste_lines` not in §4.1's block 080 list** | Kept the block's exact table set: `waste_records` is one row per wasted item, grouped by `batch_id` — no extra table needed. |
| A-6 | **POUT-08 "Data fingerprint/absensi" is a data source, not a deduction** | Mapped to `DEDUCTION_LATE`/absence family: attendance data is the calculation basis (there is no fingerprint hardware in scope — attendance is GPS+selfie per FR-HR-01). No separate component. |
| A-7 | **FR-POS-07 online orders carry no line items → ingredient usage unknowable** | `online_orders.items JSONB` optional `{productId, qty}[]`: when present, usage posts (JOUT-02 includes it); when absent, revenue-only. Recommend outlets record items; not enforced in v1. |
| A-8 | **JGUD-07 "Nilai barang/stok" is a valuation statement, not an event** | Served two ways: report `GET /api/accounting/stock-value` (primary) + a manual revaluation event/rule for FIN (§6.2 JGUD-07). Moving-average cost updates from PO receipts do NOT auto-post revaluation entries in v1. |
| A-9 | **Payment status of QRIS vs transfer (FR-ACCT-03 vs POS reality)** | cash=`paid` immediately; QRIS (static)=`verified` at sale, `paid` on settlement (X3); transfer=`pending` until Finance verifies proof (X4). Matches NFR-09 without blocking the sale (SYNC-PROTOCOL §8 row 2). |
| A-10 | **Frozen/dry separation semantics (FR-LOG-02)** | Hard rule: one SJ = one shipment type; frozen SJ requires freezer vehicle; item `storage_type` drives which SJ it may join and which storage-area types may hold it (warned, not blocked, at putaway). |
| A-11 | **Single role per user** | `users.role_id` is single-valued in v1 (PRD's role model is exclusive). Multi-role users = create a second account; revisit only if the client demands it. |
| A-12 | **PPh21/BPJS not in PRD** | **SUPERSEDED by Amendment 1 (owner decision, 17 Aug).** Full PPh21 (TER monthly + Article-17 December true-up) and BPJS (Kesehatan/JHT/JKK/JKM/JP) are implemented as an **optional, wizard-gated capability**: settings flag `payroll.statutory` (default OFF), Owner/Manager-run setup wizard, effective-dated rate tables maintained by the client (§1.7 files 067–068, §2.6, §4.15). Runs snapshot `statutory_mode` so history stays reproducible across toggles. When OFF, payroll is exactly the PRD's 7 PIN + 9 POUT. Annual rate/PTKP maintenance is the client's operational responsibility; the December recalculation is in calculator scope. |
| A-13 | **SYNC-PROTOCOL naming nuance** | The credential mint registry is `offline_credentials`; the per-use log is `offline_authorizations` (both block 120–129). SYNC-PROTOCOL §7.4-check-1's "exists in offline_authorizations" resolves against the mint registry (`offline_credentials`) — same semantics, two tables so a credential's N uses each get their own three-valued outcome. |
| A-14 | **Stock ledger dual mode** | Adopted SYNC-PROTOCOL §5.2-C5's amendment: `StockLedgerService.post(tx, movements, mode: 'strict'|'fact')`. W2-A must implement both; BUILD-PLAN §5 W2-A's "non-negative-unless-adjustment" holds for `strict` only. |
| A-15 | **Feature-code aliases** | PRD §14 feature codes map onto FR IDs: F-LOG-*→FR-LOG-*, F-POS-01..08→FR-POS-01..07+FR-SO (POS-08=outlet opname), F-HR-01..06→FR-HR-*/PIN/POUT, F-DASH→FR-DASH, F-PMS→FR-PMS, F-PUR-01..05→FR-PO/FR-SUP/petty cash, F-INV-01..05→FR-SO/FR-WST/FR-AUDIT, F-ACC-01..03→FR-ACCT/JGUD/JOUT. BUILD-PLAN's "FR-PUR-*" ≡ PRD's "F-PUR-*". |
| A-16 | **Employee self-service scope (F11)** | Every employee with a login can check in, view own slips, request leave — regardless of role (§3 all-✓ rows). Employees without users rows are payroll-only (no self-service). |
| A-18 | **Supplier visibility for outlet roles (Amendment 3 — owner decision, 17 Aug; overrules the original §1.14/§3 full-row hide)** | Fully hiding supplier rows from SPV/LDR broke PRD 8.6.1 (outlet staff record *nama supplier/toko* on petty cash). Now: `suppliers.outlet_visible` flag; outlet roles read flagged rows via `GET /api/suppliers/directory` in the `SupplierDirectoryEntry` projection (name + contact only). The FR-SUP-06 lock moves to **column level**: `harga beli` (all of `supplier_items`/`supplier_price_history`), `payment_terms_days`, bank fields, and purchase history remain invisible to outlet roles — row-hidden for the price tables, API-projection-stripped on `suppliers`. Directory is online-only (suppliers stay sync class X); offline petty cash uses free-text store name. |
| A-17 | **Shift-close cash variance → POUT** | **SUPERSEDED by Amendment 2 (owner decision, 17 Aug): auto-propose, human-approve.** A drawer shortfall auto-creates a **pending** `cash_variance_proposals` row linked to the shift + cashier (§1.6-054); it reaches payroll only after supervisor approval with a mandatory reason (§5.9), landing as a `deduction_cash_variance` line. Rejection also requires a reason. Not offline-authorizable. Overage remains an R7 finance exception with no proposal. |

## Appendix B — FR coverage index

Every PRD FR ID appears in §4's "FR" columns, §5, or §6 as follows: FR-LOG-01..05 (§4.10), 06..13 (§4.7/§4.9), 14..16 (§4.10), 17..21 (§4.7); FR-POS-01..07 (§4.13, §4.5); FR-HR-01..04 + PIN-01..07 + POUT-01..09 (§4.14/§4.15, §2.6); FR-DASH-01..04 (§4.18); FR-PMS-01..04 (§4.16); FR-PO-01..04 + F-PUR-01..05 (§4.11); FR-SUP-01..06 (§4.6, §1.14 RLS, §3); FR-SO-01..04 (§4.8); FR-WST-01..04 (§4.12); FR-ACCT-01..04 (§4.17, §5.8); FR-ACC-JGUD-01..07 + JOUT-01..09 (§6.2, §2.8); FR-AUDIT-01..02 (§1.1 audit_log, §4.0); APR-01..08 (§3 footer, §5); NFR-01..10 (conventions §0, RLS §1.14, thresholds §4.20 — evidenced at W6/W7 per BUILD-PLAN §10).

---

*End of CONTRACTS.md v1.0 (Wave 0A). Amendments only via the architect; the integrator broadcasts (BUILD-PLAN §6 rule 7). Where this file and SYNC-PROTOCOL.md describe the same thing: SYNC-PROTOCOL wins on wire/sync behavior, CONTRACTS wins on DDL, RBAC, endpoints, and posting rules.*












