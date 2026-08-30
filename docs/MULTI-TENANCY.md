# Multi-tenancy migration plan

**Status:** proposal, nothing implemented. Owner decision 2026-08-30: one shared
instance serving many client businesses, each with their own Gmail for outbound
mail, entered by the client in Settings.

This document exists because that decision is not an increment on the current
design — it inverts one of its stated premises. Everything below is measured
against the live schema rather than estimated; the queries are given so any
number here can be re-derived rather than trusted.

---

## 1. Where the system actually stands

**It is single-tenant, deliberately, and says so in writing.**

- `002_locations_storage_areas.sql`: _"One row per gudang pusat / outlet. THE
  scoping dimension (D-05). No tenant_id."_
- `253_doc_templates.sql`: _"This is a single-tenant deployment (one Mimi
  Chicken network, many locations) … there is no `tenants` table anywhere in
  this schema."_

`locations` separates **outlets within one business**. It is not a tenant
boundary and was never meant to be one. RLS scopes on `app.location_ids`, which
answers "which outlets may this user see", not "which company is this".

Email confirms the same shape at the application layer:
`EmailChannelService` holds one `readonly transporter`, built once in its
constructor from `SMTP_*` environment variables. There is no per-anything mail
identity — one deployment, one mailbox.

### The cheaper model that was rejected, recorded for the future

One **deployment per client** (own database, own containers, own `.env`) gives
total isolation, needs no schema change at all, and makes "their own Gmail"
nothing more than that stack's `SMTP_*` vars. It was considered and rejected on
2026-08-30 in favour of a shared instance. It is written down here because if
the cost below ever becomes unattractive, this is the alternative that was on
the table, and the reasons it lost were operational (N stacks to deploy,
migrate, back up and monitor), not technical.

---

## 2. What "shared instance" costs here

### 2.1 Tables

|                                          | count  |
| ---------------------------------------- | ------ |
| Tables in `public`                       | 119    |
| …carrying `location_id` (already scoped) | 44     |
| …carrying no scoping column at all       | **75** |

The 75 are the work. They are currently global by construction: one chart of
accounts, one set of items, one `settings` table.

```sql
SELECT c.relname,
       EXISTS (SELECT 1 FROM information_schema.columns col
                WHERE col.table_name = c.relname AND col.column_name = 'location_id') AS has_loc
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'r';
```

### 2.2 Uniqueness collisions — the part that bites first

**66** unique/primary-key constraints sit on tables with no scoping column.
**27** of those are a single business-meaningful key, and every one of them is a
straight collision the moment two clients share an instance:

```
users            UNIQUE (username), UNIQUE (email)
locations        UNIQUE (code)
items            UNIQUE (sku)
products         UNIQUE (code)
suppliers        UNIQUE (code)
chart_of_accounts UNIQUE (code)
settings         PRIMARY KEY (key)
document_counters PRIMARY KEY (doc_type, period)
document_templates PRIMARY KEY (kind)
fiscal_periods   UNIQUE (period_code)
payroll_periods  UNIQUE (period_code)
payroll_runs     UNIQUE (run_number)
sales            UNIQUE (receipt_number)
voucher_batches  UNIQUE (code)
vouchers         UNIQUE (code)
… and 11 more (roles.key, permissions.key, units.code, shipment_types.key,
item_categories.name, product_categories.name, salary_components.code,
employee_loans.loan_number, maintenance_jobs.job_number,
po_receipts.receipt_number, goods_receipts.receipt_number)
```

**Not all 27 should become tenant-scoped**, and deciding which is part of step 2
rather than a mechanical sweep. `permissions.key` and `roles.key` are the
system's own vocabulary — the RBAC matrix in `@mimi/shared` is compiled into the
application, so per-tenant roles would mean per-tenant code. `units.code` and
`shipment_types.key` are reference data of the same kind. These four are
plausibly _shared_ across tenants and should stay global unless someone wants
client-defined roles, which is a much larger feature than this migration.

The other 23 are client data and must be scoped.

Three of these are worth stating plainly because they are not abstract:

- **`users.username`** — two clients cannot both have an `owner`. Both seeds do.
- **`document_counters (doc_type, period)`** — two clients would be issued the
  _same_ `SJ/202608/0001`. A delivery note number is a legal document
  identifier; duplicating it across businesses is not a cosmetic bug.
- **`settings.key`** — `approval.threshold.void` is one global value today.
  There is nowhere to put client A's threshold beside client B's.

Each of the 23 becomes `UNIQUE (tenant_id, <key>)`.

```sql
SELECT c.relname, pg_get_constraintdef(con.oid)
  FROM pg_constraint con
  JOIN pg_class c ON c.oid = con.conrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname='public' AND con.contype IN ('u','p')
   AND NOT EXISTS (SELECT 1 FROM information_schema.columns col
                    WHERE col.table_name=c.relname AND col.column_name='location_id')
   AND pg_get_constraintdef(con.oid) NOT LIKE '%(id)';
```

### 2.3 RLS — much better than it looks

The headline "114 policies" overstates the work. Of the **98** policies live in
the database, **70 reach their decision through an `app_*` helper function** and
only **28** use a raw expression or have no `USING` clause.

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE pg_get_expr(polqual, polrelid) ~ 'app_')  AS via_helper,
       count(*) FILTER (WHERE pg_get_expr(polqual, polrelid) !~ 'app_'
                            OR polqual IS NULL)                          AS raw_or_null
  FROM pg_policy;
```

The helpers are nine `SECURITY DEFINER` functions: `app_has_location`,
`app_is_central`, `app_is_self`, `app_is_fulfilment_role`, `app_sj_locations`,
`app_chat_active_user_ids`, `app_chat_directory`,
`app_chat_is_active_participant`, `app_offline_credential_for_verification`.

A typical policy is exactly one call:

```sql
-- sales_loc
app_has_location(location_id)
```

**This is the single most important fact in this document.** Tenant scoping
belongs _inside_ the helpers, not sprinkled across 98 policies. Adding the
tenant gate to `app_has_location` and its siblings covers 70 policies without
editing any of them, and — more importantly — means there is one place to audit
rather than 98. The 28 that bypass the helpers must be reviewed individually,
and that review is the real security work of this migration.

---

## 3. The scoping model

Two dimensions, nested, with tenant as the outermost and non-negotiable gate:

```
tenant_id   →  which business  (NEW — hard isolation, never user-selectable)
location_id →  which outlet    (existing — what a user's role can reach)
```

`RlsContextGuard` already sets `app.role`, `app.user_id` and `app.location_ids`
per request via `set_config(..., true)`. It gains `app.tenant_id`, resolved from
the authenticated user's own row — **never** from a header, query parameter or
request body, because anything the client can influence is a tenant-escape
vector.

The helper gains the gate:

```sql
CREATE OR REPLACE FUNCTION app_has_location(loc UUID) RETURNS BOOLEAN AS $$
  SELECT
    -- Tenant first, and fail CLOSED: a missing app.tenant_id must deny, not
    -- match everything. `current_setting(..., true)` returns NULL when unset,
    -- and NULL = anything is NULL, which is not TRUE — so an unset context
    -- denies. That is deliberate; the reverse would make a forgotten
    -- set_config a silent cross-tenant read.
    (SELECT tenant_id FROM locations WHERE id = loc)
      = current_setting('app.tenant_id', true)::uuid
    AND ( ... existing location logic unchanged ... );
$$ LANGUAGE sql STABLE SECURITY DEFINER;
```

---

## 4. Sequencing

Each step is independently deployable and leaves the system working. Nothing
here is safe to reorder: step 2 depends on the column existing, step 3 depends
on tenants existing at all.

**Step 1 — foundation.** `tenants` table. `tenant_id` on `locations` and
`users` (the two roots everything else reaches through). Backfill every existing
row to a single "Mimi Chicken" tenant, then set `NOT NULL`. Resolver sets
`app.tenant_id`. Tenant gate added inside the nine helpers. At the end of this
step the existing deployment behaves identically — one tenant, same data — which
is what makes it verifiable.

**Step 2 — close the collisions.** `tenant_id` onto the 75 unscoped tables, and
re-key the 25 colliding constraints to `UNIQUE (tenant_id, …)`. Re-key
`document_counters` so numbering restarts per tenant. Audit the 28 non-helper
policies one at a time.

**Step 3 — per-tenant SMTP.** Only meaningful once tenants exist; see §5.

**Step 4 — onboarding.** Creating a tenant, seeding its chart of accounts,
roles, units and document templates. Today these arrive via a global seed.

### The test that makes this real

A cross-tenant leak is the worst failure this system can have, and it is silent.
Before step 2 is considered done there must be a live-DB test that seeds **two**
tenants and asserts, for every table carrying `tenant_id`, that a session in
tenant A returns zero rows belonging to tenant B — driven from the table list,
not a hand-written list that rots. The existing
`rls-context.guard.live-db.regression.spec.ts` is the established pattern for
this style of proof.

---

## 5. Per-tenant SMTP (the original ask)

### Shape

`EmailChannelService` currently builds its transporter once, in the
constructor, from environment variables. Per-tenant sending means resolving
config **per send** from the tenant's settings, with a small cache keyed by
tenant. `notification_outbox` already records every attempt and needs no change.

Config lives in the tenant-scoped `settings` table under `smtp.*` once step 2
has re-keyed it.

### Gmail specifics, decided rather than discovered

- **App Password required** (Google removed "less secure app" access), which
  requires 2FA on the client's account.
- **~500 recipients/day** on free Gmail, 2,000 on Workspace. This is _per
  account_, so per-tenant accounts scale with clients rather than against them.
- **Gmail rewrites the `From` header** to the authenticated account unless the
  client configures "Send mail as". A `smtp.from` setting will be silently
  overridden, and the client's notifications will appear to come from whatever
  mailbox they handed over. Worth stating in the Settings UI rather than
  letting it surprise them.

### The credential decision — flagged, not settled

Storing App Passwords means this database becomes a credential vault. A Gmail
App Password grants **full send rights on that mailbox**, is not scoped to this
application, and cannot be revoked per-feature — only by revoking the whole
password. For N clients, a database breach lets an attacker send mail _as_ every
one of them.

Encryption at rest is the floor, not the answer: the application must be able to
decrypt to send, so the key lives near the data.

**OAuth2 is the alternative**: the client clicks "Connect Gmail", and the system
stores a refresh token that is scoped to sending, revocable by the client at any
time from their Google account, and useless for reading their mail. It costs an
OAuth flow, token refresh handling and Google verification for the send scope.

The owner chose App Passwords in Settings on 2026-08-30. This paragraph records
the trade-off that choice accepts, so it stays a decision rather than becoming
an assumption.

---

## 6. Risks

**A cross-tenant leak is silent.** Nothing errors, no log line appears; one
client simply sees another's data. This is why the tenant gate goes inside nine
audited helpers rather than across 98 policies, why the helpers fail closed on
an unset `app.tenant_id`, and why the two-tenant isolation test is a gate on
step 2 rather than a follow-up.

**`tenant_id` must never be client-supplied.** It is resolved from the
authenticated user's row. A header or body field would be a tenant-escape
vector wearing a convenience costume.

**Backfill is one-way in practice.** Adding `NOT NULL tenant_id` to 75 tables on
a live database with existing data needs the write path quiet. Plan it as a
maintenance window with a verified restore ready — `infrastructure/backup/` has
`backup.sh verify` and `database/backup-restore-drill.ts` for exactly this.

**Document numbering is legally meaningful.** `document_counters` re-keying must
not renumber anything already issued. Existing rows keep their numbers; only new
allocation becomes tenant-scoped.

**Shared-instance failure is shared.** Today one client's outage is one
deployment. After this, one bad migration or one exhausted connection pool is
every client at once — the pool leak fixed in `62c7427` would have taken down
the whole customer base rather than one demo box.
