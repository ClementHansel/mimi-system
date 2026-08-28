-- Migration: 253_doc_templates
-- Block: 250-259 (document designers + vouchers)
-- Description: `document_templates` — the owner-authored print layout for each
--              of the four document kinds (invoice / receipt / voucher /
--              surat_jalan).
-- Created at: 2026-08-27
--
-- WHY ONE ROW PER KIND AND NO TENANT COLUMN
-- -----------------------------------------
-- This is a single-tenant deployment (one Mimi Chicken network, many
-- LOCATIONS but one company — `locations` is the scoping dimension, D-05,
-- and there is no `tenants` table anywhere in this schema). A template is
-- company stationery: the invoice layout is the company's invoice layout, the
-- same on every outlet's till and every office printer. So `kind` IS the
-- primary key, and the table can never hold two competing layouts for the
-- same document. Adding a tenant column "for later" would have been a column
-- that is NULL on every row forever, plus a UNIQUE (tenant, kind) that reads
-- as if per-outlet layouts were supported when nothing in the API, the
-- designer or the renderer can express one.
--
-- If per-outlet stationery is ever genuinely wanted, the honest change is a
-- nullable `location_id` plus `UNIQUE (kind, location_id)` and a resolver
-- that falls back kind→location→default. That is a real feature with a real
-- UI, not something to pre-build blind here.
--
-- WHY THERE IS NO RLS ON THIS TABLE
-- ---------------------------------
-- CONTRACTS.md §1.14's "NONE" group — master/kernel configuration that is
-- API-gated by `PermissionsGuard` only, exactly like `settings` and
-- `approval_chain_steps` (migration 007) and `products`/`recipes`/
-- `product_categories` (migrations 012/014/248). RLS exists here to stop one
-- outlet reading another outlet's OPERATIONAL rows; a template contains no
-- operational row at all. It is boxes, coordinates, font sizes and FIELD
-- TOKENS — never a customer, a price, a quantity or a location. The data that
-- fills those tokens comes from a separate, permission-checked resolver
-- (`GET /api/documents/**`), and THAT path runs against RLS-scoped `sales` /
-- `surat_jalan` / `purchase_orders` rows exactly as before.
--
-- That is also why `doc_template.read` is universal in
-- `packages/shared/src/rbac.ts` while `doc_template.manage` stops at
-- owner/manager: a kasir's till must fetch the receipt layout to print, and a
-- driver's tablet must fetch the Surat Jalan layout, but neither may redraw
-- company stationery. Enabling RLS here would have bought nothing and cost a
-- policy every one of those roles would have to be listed in.
--
-- WHY NO SEED ROWS — THE POINT OF AN EMPTY TABLE
-- ----------------------------------------------
-- ABSENCE OF A ROW MEANS "use `defaultDocTemplate(kind)`", the seeded layout
-- in `packages/shared/src/documents/defaults.ts`. That default is ~90 element
-- objects across four kinds, with geometry, brand colour tokens and table
-- column widths. Transcribing it here as four JSONB literals would create a
-- SECOND copy of a layout that is already authored, already unit-tested and
-- already type-checked against `DocElement`, and the two copies would drift
-- the first time anybody nudges a default: a fresh install would print one
-- layout and an existing install another, from the same release.
--
-- Keeping the default in TypeScript also makes "reset to default" trivially
-- correct — `DELETE FROM document_templates WHERE kind = $1` and the fallback
-- takes over — instead of "re-INSERT whatever this migration happened to say
-- in the release you first installed".
--
-- The cost of the choice, recorded so it is findable: you cannot read a
-- default layout with SQL. `SELECT * FROM document_templates` on a healthy
-- fresh install returns zero rows, and that is correct, not a failed seed.
--
-- `layout` IS THE WHOLE `DocTemplate` AS JSONB, including its own redundant
-- `kind` and its `version`. Storing the document exactly as the shared
-- `validateDocTemplate()` accepts it means the service does no reshaping in
-- either direction, so there is no place for a read/write asymmetry to hide.
-- `version` inside the JSON is the LAYOUT schema version
-- (`DOC_TEMPLATE_VERSION`), which is what a future element-shape migration
-- would key off.
--
-- `background_attachment_id` IS DUPLICATED between this column and
-- `layout->>'backgroundAttachmentId'` ON PURPOSE. The JSON copy is what the
-- renderer reads; this column is what gives the database a real FK, so a
-- letterhead cannot be hard-deleted out from under a template that prints it
-- (ON DELETE RESTRICT, below) and so an attachment-GC job can find referrers
-- without parsing JSONB. The service writes both from the same value.

BEGIN;

CREATE TABLE document_templates (
  -- `kind` is the PK, not a surrogate id: see the header. The CHECK list is
  -- `DocKind` from `packages/shared/src/documents/template.ts`, verbatim.
  kind VARCHAR(20) PRIMARY KEY
    CHECK (kind IN ('invoice', 'receipt', 'voucher', 'surat_jalan')),

  -- The complete `DocTemplate` object. Structural validity (element types,
  -- field tokens against the kind's catalog, geometry inside the page, the
  -- 120-element cap) is enforced by `validateDocTemplate()` in
  -- `@mimi/shared`, called by `DocTemplateService.put` before this row is
  -- written. Deliberately NOT re-expressed as CHECK constraints: the rules
  -- are per-kind, reference a catalog that lives in TypeScript, and must
  -- produce the SAME diagnostics for the designer (which validates before
  -- saving) and the server (which never trusts that it did). One
  -- implementation, two callers — the same reasoning `settings.value` uses
  -- against `settings-value-validator.ts` rather than JSON-schema CHECKs.
  layout JSONB NOT NULL,

  -- RESTRICT, not CASCADE or SET NULL: deleting the letterhead an invoice
  -- template prints on must fail loudly at the point of deletion, not
  -- silently produce blank-background invoices that nobody notices until a
  -- customer holds the paper.
  background_attachment_id UUID REFERENCES attachments(id) ON DELETE RESTRICT,

  updated_by UUID REFERENCES users(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- No `set_updated_at` trigger here, unlike most tables with an `updated_at`:
-- there is no UPDATE path that does not already go through the service's
-- `INSERT ... ON CONFLICT DO UPDATE`, which sets `updated_at = NOW()`
-- alongside `updated_by` in the same statement. A trigger would be a second
-- mechanism writing the same column. (`settings`, the closest analogue in
-- this schema, is trigger-less for exactly the same reason — migration 007.)

COMMENT ON TABLE document_templates IS
  'Owner-authored print layouts, one row per DocKind. Absence of a row means "use defaultDocTemplate(kind)" from @mimi/shared — see migration 253''s header.';

GRANT SELECT, INSERT, UPDATE, DELETE ON document_templates TO app_user;

COMMIT;
