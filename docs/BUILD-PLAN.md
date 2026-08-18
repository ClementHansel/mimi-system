# Mimi Chicken Operational System — Build Plan

**Source of truth:** `PRD - Mimi Chicken OS - V1.pdf` (v1.0, 15 Aug 2026, 27 pages) + owner amendments of this session (§1.2)
**Plan version:** 2.0 · **Target:** full Phase-1 scope, built by parallel agents in one campaign
**Reference codebases:** `../aire/aire` (stack, module shape, branch-bridge, device-registry/topology), `../aivory` (VPS/Traefik deploy)

> This document is the orchestration contract. It exists so that ~10 agents can work
> simultaneously without touching the same files. Read §6 (Collision Rules) before
> dispatching anything.

**The business in one line:** one central warehouse in Balikpapan supplies 15–20 fried-chicken
outlets across 4 Kalimantan cities. Goods flow Supplier → Gudang Pusat → Surat Jalan → Outlet
Storage → POS; money and accountability flow back the other way. Every outlet must keep
selling when its internet dies.

---

## 1. Locked decisions

### 1.1 From the PRD review

| #    | Decision                                                                                                                                                                         | Consequence                                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-01 | **Greenfield repo, AIRE conventions only.** New single-tenant codebase; copy the proven stack and patterns, not the code.                                                        | Clean handover per SCOPE-IN-12. No AIRE multi-tenancy, car-wash, or IoT-bay baggage. AIRE's `branch-bridge` and `device-registry` are the exceptions — they get ported (§1.2 D-13). |
| D-02 | **Full offline-first sales.** Cashier completes cash/QRIS sales with zero connectivity; syncs on reconnect with idempotency keys.                                                | Mitigates RISK-02. Now generalised into D-12.                                                                                                                                       |
| D-03 | **Notifications: in-app + email + WhatsApp via n8n.**                                                                                                                            | Satisfies FR 8.3.3 literally. **Blocking:** client must supply WA gateway credentials by end of Week 1 (RISK-P4).                                                                   |
| D-04 | **Full double-entry GL.** COA, balanced entries, fiscal periods, trial balance, P&L, balance sheet; the PRD's 16 journal event types implemented as declarative _posting rules_. | Exceeds PRD wording deliberately; exportable to the client's accountant.                                                                                                            |

### 1.2 From the owner amendments (this session)

| #    | Decision                                                                                                                                                                                                                                                                                                                       | Consequence                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-12 | **Three tiers, one sync protocol.** Tier 1 = device (PWA with a real local store), Tier 2 = **optional** branch node (mini-PC + local Postgres on the outlet LAN), Tier 3 = cloud VPS (canonical). The same append-only event-sync protocol runs between any two adjacent tiers.                                               | Default deployment needs **zero hardware** (respects SCOPE-OUT-01/02). Adding a branch node later is a deployment change, not a rewrite. Sync is written once, not twice.                                                                                                                                       |
| D-13 | **Device registry + topology + heartbeat**, ported from AIRE `device-registry` + `branch-bridge`. Tree: Pusat → Kota → Outlet → Node → Device, with `online/offline/stale`, last-seen, app version, and **offline queue depth** per device.                                                                                    | Owner sees at a glance which outlets and devices are alive. Where a branch node is installed, it adds **full LAN discovery** (mDNS / SSDP / ONVIF / bounded TCP probe) so routers and unpaired printers appear too. Without a node, topology degrades gracefully to app-session devices — same UI, fewer nodes. |
| D-14 | **Surat Jalan as a full logistics document with cold chain.** Numbered SJ, driver + vehicle, multi-drop route, frozen/dry split (FR-LOG-02), per-drop departure & arrival timestamps, receiving signature + photo, discrepancy capture, **seal number and temperature logged at load and at every drop** for frozen shipments. | FR-LOG-01..05, FR-LOG-08, FR-LOG-14..16 satisfied with a real paper-replacing document. Cold-chain breaches become auditable — directly serves OBJ-03.                                                                                                                                                          |
| D-15 | **Outlet storage system: storage areas within a location.** Stock is keyed by `(location_id, storage_area_id, item_id)`. Areas typed `freezer / chiller / dry_store / display / kitchen_line`, each with a temperature range.                                                                                                  | Makes frozen-vs-dry separation real rather than a shipment label, makes opname countable per area, and makes "where is this item" answerable.                                                                                                                                                                   |

### 1.3 Derived architectural decisions

| #     | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D-05  | **Single tenant. The scoping dimension is `location`, not `tenant`.** One `locations` table, `type ∈ (warehouse, outlet)`, with `city`.                                                                                                                                                                                                                                                                                                                                                                                   | Drops a column and an RLS predicate from every table vs AIRE.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| D-06  | **RLS in Postgres + PermissionsGuard in Nest.** Session vars `app.user_id`, `app.role`, `app.location_ids`.                                                                                                                                                                                                                                                                                                                                                                                                               | NFR-03. 8 roles × 23 modules in a fraud-sensitive system — a guard alone is not enough.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D-07  | **One stock writer.** No module writes `stock_balances`. Everything goes through `StockLedgerService.post(tx, movements)`, inside the caller's transaction.                                                                                                                                                                                                                                                                                                                                                               | Prevents 10 parallel agents inventing 10 stock paths.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| D-08  | **Generic approval engine** driving replenishment, void/refund, PO, opname adjustment, retur, payroll, and payment verification.                                                                                                                                                                                                                                                                                                                                                                                          | Eight modules need the identical lifecycle. Build once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| D-09  | **Audit trail is an interceptor** (`@Audited()`), not per-module code.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | FR-AUDIT-01/02 apply everywhere; per-module guarantees gaps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-10  | Money `NUMERIC(18,2)`, quantities `NUMERIC(14,3)`, temperatures `NUMERIC(4,1)`. Never floats. All arithmetic in `packages/shared`.                                                                                                                                                                                                                                                                                                                                                                                        | NFR-09/10, payroll and GL correctness.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D-11  | **Timezone WITA (`Asia/Makassar`)** fixed app-wide, stored `TIMESTAMPTZ`, rendered `id-ID`.                                                                                                                                                                                                                                                                                                                                                                                                                               | NFR-10. Do not copy AIRE's `Asia/Jakarta` default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D-16  | **Stock balances are never synced — they are derived.** Each tier recomputes balance from its movement log; cloud is canonical. Divergence raises a reconciliation exception, never a silent overwrite.                                                                                                                                                                                                                                                                                                                   | The one rule that keeps a three-tier system from corrupting inventory.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| D-16a | **Amended by W0-B: `stock_movements` are not synced either.** Both balances _and_ movements are per-tier projections of the synced _fact_ stream (a sale, a receipt, a count). Syncing movements would double-apply against locally derived ones. The projector lives in `packages/sync-protocol` and is shared by all three tiers.                                                                                                                                                                                       | See `SYNC-PROTOCOL.md` §3 group 3, property T-02. Makes the shared projector a three-tier-critical W1-B deliverable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| D-23  | **Per-approval-type mode: `manual` / `whatsapp` / `auto` / `off`.** Each of the 12 `ApprovalDocumentType`s carries its own mode, Owner-configurable. `manual` = request notified via in-app + email. `whatsapp` = notified via WA. **`auto` = the system auto-_creates_ the request; a human still decides** — it automates the request step, never the decision, so no control is reduced. `off` = no approval step required, **but the document still records the actor who performed it** — nothing becomes anonymous. | Owner decision. The `auto` reading matters: auto-_approval_ would have made the system its own approver and gutted OBJ-03. Auto-creation is pure automation of the low-stock→request path (FR-LOG-08). `off` preserving the actor keeps the audit trail continuous across a mode change.                                                                                                                                                                                                                                                                                                                                                                                                        |
| D-24  | **WhatsApp approval is a notification channel, not an authentication channel.** The WA message carries a **deep link**; tapping it opens the authenticated app where the actual approval happens. A plain WA reply never approves anything.                                                                                                                                                                                                                                                                               | A WhatsApp number is not a proven identity — a borrowed or spoofed phone would approve a void. Keeps every approval attributable to an authenticated session (APR-01..08, SM-02).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| D-25b | **Connectivity and sync are two separate, always-visible states.** _Online/offline_ = whether the cloud is reachable. _Synced/not-synced_ = whether local data matches cloud. Both shown in the app shell, with a **manual button to force a connectivity re-check and a sync attempt**. Queue-and-retry underneath so there is always exactly one correct version.                                                                                                                                                       | Owner requirement. The two states are genuinely independent — a device can be online with a backlog, or offline and fully drained. Conflating them is what makes staff distrust the system.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D-26  | **Branch node is a per-outlet Owner-only setting, and switching it OFF drains the queue first.** ON requires a PC at that outlet and enables the full-local functions; OFF means a tablet alone suffices. Turning ON launches a setup wizard. Turning OFF **refuses to complete until the node's queued events have reached cloud**.                                                                                                                                                                                      | Per-outlet because some outlets will get a PC and others will not — this is exactly the node-optional design of D-12. Draining before shutdown matters because the events still on a node are precisely those recorded during the last outage; stranding them loses real sales and receipts.                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-22  | **D-21 was correctly specified and incorrectly implemented — this is the fix.** Three changes, all required: (a) a dedicated **non-superuser LOGIN role** for the runtime connection, granted membership in `app_user`; (b) `DATABASE_URL` pointed at that role instead of the superuser; (c) the guard issues **`SET LOCAL ROLE app_user`** as phase 0, before any session var. Plus a permanent regression test that connects _the way the app actually connects_ and asserts a Kasir sees only their outlet.           | Found by W2-A at Wave 2, not by Gate G1. W1-C built `app_user` and `FORCE ROW LEVEL SECURITY` correctly; W1-D's guard set the session variables correctly; but nothing ever issued `SET ROLE`, and `DATABASE_URL` pointed at `mimi` — a **superuser with `BYPASSRLS`**, which bypasses RLS regardless of `FORCE`. Proven live: a Kasir context saw all 418 sales instead of 64, and all 324 supplier price-history rows instead of 0. **The G1 check missed it because the coordinator's test issued `SET ROLE app_user` by hand — it verified the policies, not the path the application takes.** The lesson generalises: test the real connection path, not a hand-built approximation of it. |
| D-21  | **The app never connects to Postgres as a table owner, and RLS is `FORCE`d.** Runtime uses a dedicated non-owner `app_user` role; migrations run as owner. Session context is set in two phases: `app.user_id` + `app.role` from the verified JWT (no DB read), then `ScopeService` resolves visible locations _under RLS_ via narrow self-read policies on `user_locations` / `drivers` / `surat_jalan`, then `app.location_ids` is set.                                                                                 | Raised by W1-D. Postgres skips RLS for a table's owner unless `FORCE ROW LEVEL SECURITY` is set — an owner-privileged app connection would silently reduce the entire RLS layer to decoration while appearing to work. In a system whose purpose is fraud control (OBJ-03), that is the worst available failure mode. No RLS exemption is used to solve the bootstrap ordering problem.                                                                                                                                                                                                                                                                                                         |
| D-18  | **Payroll statutory components (PPh21 + BPJS) are built, but optional.** A settings flag gates them, default OFF; switching it ON launches a setup wizard that collects effective-dated BPJS and PPh21 configuration before any run may use it. Every payroll run records which mode it ran in, so historical runs stay reproducible after a toggle.                                                                                                                                                                      | Supersedes CONTRACTS Appendix A-12. Makes the slip legally shaped for clients who want it without forcing statutory complexity on go-live. Annual rate maintenance is the client's operational responsibility.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| D-19  | **Cash variance at shift close auto-proposes, never auto-deducts.** A drawer shortfall creates a _pending_ payroll deduction proposal; a supervisor must approve it before it reaches payroll. Reason required on approve and reject. Not eligible for offline authorization.                                                                                                                                                                                                                                             | Supersedes CONTRACTS Appendix A-17. Deterrent value without the Indonesian labour-law exposure of automatic wage deduction.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| D-20  | **Outlet roles see supplier name and contact, never price or termin.** RLS hides columns, not rows, for Supervisor Cabang and Leader/Staff Outlet.                                                                                                                                                                                                                                                                                                                                                                        | Overrules W0-A's fully-invisible proposal. PRD 8.6.1 requires outlet staff to record _nama supplier/toko_ on every petty-cash purchase; hiding the row breaks a flow the PRD specifies. FR-SUP-06 still satisfied at column level.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| D-17a | **Amended by W0-B: the stock ledger has two modes.** `strict` (interactive writes — reject a movement that would go negative) and `fact` (applying a replayed offline fact — post it even if negative and open a reconciliation exception). Rejecting a replayed fact would invent data: the chicken really was sold.                                                                                                                                                                                                     | Amends the W2-A brief and its property test. See `SYNC-PROTOCOL.md` §5.2 C5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| D-17  | **Offline authorization is provisional and re-verified.** A supervisor approving a void offline uses a cached short-TTL credential; the approval is written with `offline_authorized = true` and re-validated on sync. Anything failing re-validation lands in a finance exception queue.                                                                                                                                                                                                                                 | Offline capability must not become the fraud hole the whole system exists to close (OBJ-03).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

---

## 2. Stack

Lifted from AIRE — proven at this exact shape (POS + ERP + HR, Indonesian, VPS deploy) and the human dev already knows it.

| Layer                 | Choice                                                                                                                                |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo              | pnpm 9 workspaces, Node 22, TypeScript 6                                                                                              |
| Cloud backend         | NestJS 11, **raw `pg` — no ORM** (AIRE convention), Passport-JWT, Vitest                                                              |
| DB                    | Postgres 16 + RLS; custom SQL migration runner (`database/migrate.ts`, ported)                                                        |
| Branch node           | Node 22 service + embedded Postgres 16, one **outbound** socket.io connection to cloud (no inbound port-forwarding, ever)             |
| Device local store    | IndexedDB via `idb`, durable outbox, service worker                                                                                   |
| Cache/locks           | Redis 7                                                                                                                               |
| Object store          | MinIO (S3 API) — bukti foto receiving, waste, petty cash, payment, selfie absensi, servis, surat jalan                                |
| Frontend              | Next 15 App Router, React 19, Tailwind 4, zustand, lucide-react                                                                       |
| Realtime              | socket.io — heartbeat, topology, approval push, dashboard tiles                                                                       |
| Discovery (node only) | `bonjour-service` (mDNS), `node-ssdp`, bounded TCP probe — ported from `apps/branch-bridge`                                           |
| Printing              | Web Bluetooth → ESC/POS (58/80mm)                                                                                                     |
| Automation            | n8n (WA slip gaji, WA alerts)                                                                                                         |
| Deploy                | Docker Compose on VPS + Traefik + Let's Encrypt + `pg_dump` cron offsite; branch node ships as a signed Docker image with self-update |
| Tests                 | Vitest (unit/integration), fast-check (property: payroll, GL, stock, sync merge), Playwright (E2E per role)                           |

---

## 3. Repository layout

```
mimi-chicken/
├─ apps/
│  ├─ backend/                 Cloud API (NestJS) — canonical tier
│  │  └─ src/
│  │     ├─ common/            guards, decorators, interceptors, scope, permissions
│  │     ├─ kernel/            stock-ledger, approvals, audit, notification, storage, events, sync
│  │     └─ modules/           23 domain modules (§4.2)
│  ├─ branch-node/             OPTIONAL on-prem agent: local PG, LAN discovery, heartbeat, sync pipe
│  └─ frontend/                Next 15 PWA
│     └─ src/
│        ├─ app/               13 route surfaces (§4.3)
│        ├─ components/ui/     design system
│        ├─ lib/local/         local store + outbox + reconciler (Tier 1)
│        └─ stores/
├─ packages/
│  ├─ shared/                  enums, types, RBAC matrix, state machines, pure calculators
│  └─ sync-protocol/           event shapes, authority matrix, cursor logic — shared by all 3 tiers
├─ database/
│  ├─ migrate.ts  reset.ts  seed.ts
│  └─ migrations/              numbered blocks, pre-allocated (§4.1)
├─ e2e/                        Playwright, one spec per role journey
├─ infrastructure/             traefik, n8n workflows, backup scripts, branch-node packaging
└─ docs/
   ├─ BUILD-PLAN.md            ← this file
   ├─ CONTRACTS.md             ← Wave 0 output, the fan-out contract
   ├─ SYNC-PROTOCOL.md         ← Wave 0 output, the three-tier contract
   ├─ TECHNICAL.md  DEPLOYMENT.md
   └─ manual/                  DEL-04 user guide (Bahasa Indonesia)
```

---

## 4. Work partition

### 4.1 Migration blocks (hard-reserved — an agent may only create files in its own block)

| Block     | Contents                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `001–009` | extensions, `locations`, **`storage_areas`**, `users`, `roles`, `permissions`, `role_permissions`, `user_locations`, `sessions`, `audit_log`, `attachments`, `notifications`, `settings`, `updated_at` trigger, RLS policies                                                                                                                                                            |
| `010–019` | `item_categories`, `units`, `unit_conversions`, `items`, `products` (menu), `recipes`/`recipe_lines`, `suppliers`, `supplier_items`, `supplier_price_history`                                                                                                                                                                                                                           |
| `020–029` | `stock_balances` (keyed by location + **storage_area** + item), `stock_movements`, `min_stock_rules`, `stock_opname`, `_lines`, `stock_adjustments`, `stock_reconciliations`                                                                                                                                                                                                            |
| `030–039` | `replenishment_requests`, `_lines`, **`surat_jalan`**, `sj_drops`, `sj_lines`, `sj_temperature_logs`, `sj_seals`, `drivers`, `vehicles`, `goods_receipts`, `_lines`, `shipment_types`                                                                                                                                                                                                   |
| `040–049` | `purchase_requests`, `purchase_orders`, `po_lines`, `po_receipts`, `petty_cash`, `_lines`                                                                                                                                                                                                                                                                                               |
| `050–059` | `pos_shifts`, `sales`, `sale_lines`, `sale_payments`, `void_refunds`, `online_orders` (GoFood/ShopeeFood), **`cash_variance_proposals`** (D-19)                                                                                                                                                                                                                                         |
| `060–069` | `employees`, `employments`, `work_shifts`, `shift_assignments`, `attendance`, `leave_requests`, `salary_components`, `employee_salary_components`, `employee_loans`, `employee_loan_payments`, `payroll_periods`, `payroll_runs`, `payroll_lines`; **statutory (D-18, optional): `bpjs_configs`, `pph21_ter_rates`, `pph21_ptkp`, `pph21_article17_brackets`, `employee_tax_profiles`** |
| `070–079` | `assets`, `maintenance_schedules`, `maintenance_jobs`, `service_history`                                                                                                                                                                                                                                                                                                                |
| `080–089` | `waste_records`, `returns`, `return_lines` (outlet→gudang and gudang→supplier)                                                                                                                                                                                                                                                                                                          |
| `090–099` | `chart_of_accounts`, `fiscal_periods`, `journal_entries`, `journal_lines`, `posting_rules`, `payment_verifications`                                                                                                                                                                                                                                                                     |
| `100–109` | reporting rollups / materialized views                                                                                                                                                                                                                                                                                                                                                  |
| `110–119` | **`devices`, `branch_nodes`, `device_heartbeats`, `device_events`, `pairing_tokens`, `discovered_devices`**                                                                                                                                                                                                                                                                             |
| `120–129` | **`sync_events`, `sync_cursors`, `sync_batches`, `sync_conflicts`, `offline_credentials` (mint registry), `offline_authorizations` (per-use)**                                                                                                                                                                                                                                          |

> **§4.1 is a map, not the specification.** `CONTRACTS.md` §1 is authoritative for tables and columns; this table exists to allocate migration-number ranges to owners. If the two disagree, CONTRACTS wins and someone should sync this row.
> | `2xx` | per-agent fix blocks: `2NN_<agent-id>_<slug>.sql`. Never renumber, never edit an applied migration. |

**All of `001–129` are authored by one agent (W1-C) in Wave 1.** Schema coherence beats parallelism.

### 4.2 Backend modules — one agent owns one directory, exclusively

| #   | `modules/<dir>`       | PRD / amendment coverage                                                                                                                               |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M01 | `auth`                | login, JWT, refresh, PIN, offline credential minting (D-17)                                                                                            |
| M02 | `users`               | user CRUD, role + location assignment                                                                                                                  |
| M03 | `location`            | outlets, gudang pusat, cities, **storage areas (D-15)**                                                                                                |
| M04 | `item`                | items, categories, units, conversions                                                                                                                  |
| M05 | `product`             | menu products, recipe/BOM → drives FR-POS-06 usage estimate                                                                                            |
| M06 | `supplier`            | FR-SUP-01..06, price history, role-locked pricing                                                                                                      |
| M07 | `inventory`           | balances per storage area, movements, min-stock, low-stock detection — FR-LOG-06/07/17..21                                                             |
| M08 | `stock-opname`        | FR-SO-01..04, countable per storage area                                                                                                               |
| M09 | `replenishment`       | FR-LOG-06..13 — request → approval chain → fulfilment handoff                                                                                          |
| M10 | `delivery`            | **D-14** — Surat Jalan, drops, driver/vehicle, cold chain, receiving + foto, discrepancy — FR-LOG-01..05, 08, 14..16                                   |
| M11 | `purchasing`          | FR-PO-01..04, FR-PUR-01..05, petty cash                                                                                                                |
| M12 | `waste-return`        | FR-WST-01..04, both retur directions                                                                                                                   |
| M13 | `pos`                 | FR-POS-01..07, shift, sale, payment, void/refund, GoFood/ShopeeFood                                                                                    |
| M14 | `hr`                  | FR-HR-01/02, attendance GPS + selfie, shift schedule, cuti/izin                                                                                        |
| M15 | `payroll`             | FR-HR-03/04, PIN-01..07, POUT-01..09, slip gaji                                                                                                        |
| M16 | `asset`               | FR-PMS-01..04                                                                                                                                          |
| M17 | `accounting`          | D-04 GL, COA, posting engine, FR-ACCT-01..04                                                                                                           |
| M18 | `dashboard`           | FR-DASH-01..04                                                                                                                                         |
| M19 | `report`              | exports, rekap pengiriman harian (FR-LOG-04), laporan shift                                                                                            |
| M20 | `settings`            | company profile, approval thresholds, payroll rules, geofence radius, cold-chain limits                                                                |
| M21 | **`device-registry`** | **D-13** — devices, pairing, heartbeat ingest, topology tree, stale sweep, offline/online transition alerts                                            |
| M22 | **`node-gateway`**    | **D-12/D-13** — branch-node socket gateway, pairing tokens, discovery ingest, node health, remote command channel                                      |
| M23 | **`sync`**            | **D-12** — event batch ingest (idempotent), cursors per subscriber, authority enforcement, conflict log, reconciliation jobs, per-location sync status |

### 4.3 Frontend surfaces — one agent owns one route group, exclusively

| #   | `app/<route>`   | Roles                                                                                                        | Device                    |
| --- | --------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------- |
| F01 | `(auth)/`       | all                                                                                                          | any                       |
| F02 | `pos/`          | Kasir                                                                                                        | **tablet, offline-first** |
| F03 | `dashboard/`    | Owner, Manager                                                                                               | laptop                    |
| F04 | `outlet/`       | Leader/Staff Outlet, Supervisor — request, terima barang, stok per area, SO, waste/retur, petty cash         | tablet + laptop           |
| F05 | `warehouse/`    | Kepala Gudang — stok, approval queue, picking, **buat Surat Jalan**, receiving, retur supplier               | laptop                    |
| F06 | `purchasing/`   | Purchasing, Kepala Gudang                                                                                    | laptop                    |
| F07 | `finance/`      | Finance, Owner — verifikasi pembayaran, jurnal, COA, laporan                                                 | laptop                    |
| F08 | `hr/`           | HR Admin, Supervisor                                                                                         | laptop                    |
| F09 | `assets/`       | Manager, PIC Maintenance                                                                                     | laptop + mobile           |
| F10 | `admin/`        | Owner, Manager — users, roles, master data, storage areas, audit trail viewer                                | laptop                    |
| F11 | `me/`           | every employee — absen GPS + selfie, slip gaji, ajukan cuti                                                  | **mobile**                |
| F12 | **`topology/`** | Owner, Manager, IT — live device tree, heartbeat status, per-outlet sync health, queue depth, conflict queue | laptop + wallboard        |
| F13 | **`driver/`**   | Driver — surat jalan hari ini, multi-drop checklist, suhu + segel, foto serah terima, tanda tangan           | **mobile, offline-first** |

---

## 5. Wave plan

Each wave ends at an **integration gate** run by a single integrator agent:
`pnpm build && pnpm lint && pnpm test && pnpm db:reset && pnpm db:seed` + smoke script green.
A red gate blocks the next dispatch. No exceptions — waving one through compounds across ten agents.

### Wave 0 — Contracts (1 agent, solo, blocking)

**Agent:** `architect` · **Outputs:** `docs/CONTRACTS.md` and `docs/SYNC-PROTOCOL.md`

`CONTRACTS.md` must contain:

1. Full DDL sketch for all ~95 tables (§4.1 blocks), column names and types.
2. Every enum with exact string values — `ReplenishmentStatus`, `SuratJalanStatus`, `DropStatus`, `PaymentStatus`, `ApprovalState`, `MovementType`, `StorageAreaType`, `DeviceCategory`, `DeviceStatus`, `SyncEntity`, `LeaveType`, `PayrollComponentType`, `JournalEventType` ×16, …
3. **RBAC matrix**: 8 roles × every permission key. Becomes `packages/shared/rbac.ts` verbatim.
4. **API endpoint table** per module: method, path, permission key, request/response shapes. FE agents build against this before BE exists.
5. Approval state machines as transition tables.
6. Posting-rule table: PRD journal event → debit account → credit account → amount source.
7. Topology contract: device/node registration, heartbeat payload, staleness thresholds, tree JSON shape.
8. File-ownership map (copy of §4.2/§4.3 + §6).

`SYNC-PROTOCOL.md` must contain:

1. `sync_events` row shape and the client-side idempotency-key derivation.
2. **The authority matrix** — for every entity: which tier owns it, which direction it flows, what happens on conflict:

   | Data class                                                                                                       | Authority                                     | Direction                                    | Conflict rule                                           |
   | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------------------------- |
   | Master data (items, products, recipes, prices, suppliers, users, roles, min-stock, COA, payroll rules, settings) | Cloud                                         | pull only                                    | Offline edit forbidden; local is read-only              |
   | POS sales, payments, shift open/close                                                                            | Origin outlet, append-only                    | push only                                    | None possible — dedupe by event id                      |
   | Attendance, waste, petty cash, opname counts, receiving                                                          | Origin location, append-only                  | push only                                    | Same-line double count → conflict queue                 |
   | Replenishment request                                                                                            | Outlet creates, upstream decides              | push create, pull decision                   | Decision always wins                                    |
   | Surat Jalan                                                                                                      | Warehouse (cloud) creates                     | pull to outlet + driver, receipt pushes back | Discrepancy is data, not conflict                       |
   | **Stock balance**                                                                                                | **Derived, never synced (D-16)**              | —                                            | Divergence → reconciliation exception                   |
   | Approvals                                                                                                        | Cloud when online; provisional offline (D-17) | bidirectional                                | Re-verified on sync; failures → finance exception queue |

3. Push/pull cursor semantics, batch size, ordering (`client_seq` monotonic per origin), retry/backoff.
4. Clock-skew handling: server stamps `received_at`; `occurred_at` is advisory; ordering is by `client_seq`.
5. Reconciliation jobs and the exception surfaces they feed (F12).
6. Tier-degradation matrix: what a device can do (a) online, (b) LAN-only with a node, (c) fully isolated.

**Gate:** human review. This is the one place where a mistake multiplies by 20 agents.

---

### Wave 1 — Foundation (5 parallel)

| Agent         | ID   | Owns (exclusive)                                                                                                                        | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `devops`      | W1-A | `docker-compose*.yml`, `infrastructure/`, `.env*`, root configs, `.github/`                                                             | Compose stack (pg16, redis, minio, n8n, backend, frontend) healthy; eslint/prettier/tsconfig; CI = build+lint+test                                                                                                                                                                                                                                                                                         |
| `senior-be`   | W1-B | `packages/shared/**`, `packages/sync-protocol/**`                                                                                       | Enums, types, RBAC matrix, error codes, state machines, money/qty math, WITA dates, payroll calculators, GL balance validator, sync event shapes + authority matrix as **executable data**, and the **shared stock projector** (fact stream → movements → balances) used identically by all three tiers per D-16a. Pure functions, 100% unit + property tested, zero I/O.                                  |
| `senior-db`   | W1-C | `database/**`                                                                                                                           | Migration runner (ported), migrations `001–129`, RLS, triggers, indexes, and a **realistic seed**: 1 gudang + 20 outlets across 4 cities, storage areas per outlet, ~120 items, ~40 menu products with recipes, 130 employees, 15 suppliers, seeded COA, 30 devices                                                                                                                                        |
| `senior-be`   | W1-D | `apps/backend/src/main.ts`, `app.module.ts`, `src/common/**`, **all 23 empty module stubs**                                             | Bootstrap, `DATABASE_POOL`, `JwtAuthGuard`, `RlsContextGuard`, `PermissionsGuard`, `@CurrentUser`, `@RequirePermission`, `ScopeService`, exception filter, validation pipe. **Pre-creates every module dir with a stub already imported into `app.module.ts`.**                                                                                                                                            |
| `senior-uiux` | W1-E | `frontend/src/app/layout.tsx`, `globals.css`, `components/ui/**`, `lib/api.ts`, `lib/i18n`, **all 13 empty route folders + nav config** | Design system (Button, Input, Select, DataTable, Modal, Drawer, Toast, PhotoCapture, SignaturePad, FileUpload, ApprovalTimeline, StatusBadge, MoneyInput, TempInput, DateRangePicker, EmptyState, ChartCard, **OfflineBanner**, **SyncStatusPill**), typed API client, Bahasa Indonesia i18n, IDR/WITA formatters, role-aware sidebar with **all nav entries pre-registered**, tablet + mobile breakpoints |

> **The pre-creation trick (W1-D, W1-E) is what makes Waves 3–5 collision-free.** Because
> `app.module.ts` and the nav config already list all 23 modules / 13 routes on day one,
> no later agent ever needs to edit a shared registry file.

**Gate G1: CLOSED — verified by the coordinator against a live database, not from agent reports.**

| Check                                                     | Result                                                                              |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Migrations applied from empty                             | 82/82 clean                                                                         |
| Tables / matviews                                         | 104 + 4                                                                             |
| RLS enabled but not `FORCE`d                              | **0** of 67 RLS tables                                                              |
| Stock ledger invariant (balance ≡ fold of movements)      | 0 mismatches across 630 keys                                                        |
| GL entries not balancing                                  | 0                                                                                   |
| RLS enforcement, role-switched as `app_user`              | Kasir sees own outlet's 64 sales, **0** foreign sales, 0 suppliers, 0 price history |
| ~~RLS enforcement on the app's _actual_ connection path~~ | **FAILED — missed by this gate, caught by W2-A. See D-22.**                         |
| Session-var wire format                                   | W1-C's `app_has_location()` splits on `,`; W1-D's guard emits `join(',')` — agree   |
| Backend                                                   | 39 tests, lint+build clean, live boot, `/health` 200                                |
| Shared packages                                           | 256 tests across 22 files, both build clean                                         |
| Frontend                                                  | 47 tests, 17 routes building, nav frozen and permission-gated                       |

**Carried forward from Wave 1 (do not lose these):**

1. `journal_entries` seeds empty — the GL invariant above is vacuously true and finance/dashboard surfaces have no data. Needs seed top-up before G4, else W5-02 and W5-06 build blind. **Owner: W4-03.**
2. Three approval chains (`stock_opname`, `return`, `waste`) and `leave_request` pick their step-1 approver by location type / direction / either-role, which `approval_chain_steps (document_type, step_no) → role` cannot encode. Seeded with a representative role; **runtime branching required in W2-B.**
3. Two posting-rule event types (`petty_cash_topup`, `employee_loan_disbursement`) exist in prose in CONTRACTS §6.3 but not in the `JournalEventType` / `JournalSystemEventType` enums. **Owner: W4-03 to reconcile with the enum owner.**
4. `sync_events` is unpartitioned. Correct at Wave 1 volume; needs a `2xx` monthly-partition migration before production traffic. **Owner: W7-01.**
5. **Payload-schema ambiguities** marked `// AMBIGUOUS:` in `packages/sync-protocol/src/schema/registry.ts` — W1-B inferred these from CONTRACTS and needs the owning module to confirm: `role_permissions.updated` shape; `surat_jalan.updated` field set; the `void_refunds.approved` / `approved_offline` / `executed` payload-vs-envelope-meta split; `unit_conversions.factor` NUMERIC(14,6) scale; and the `devices` / `branch_nodes` / `device_events` / `discovered_devices` group. **Each Wave 3 module owner must confirm or correct the schema for their own entities** — W3-10 owns the device/node group, W3-07 the surat jalan set, W3-08 void/refund.
6. `posting_rules` multi-leg events (payroll accrual, outlet sales, void reversal) are a declarative approximation pending real domain-event shapes. **Owner: W4-03.**

---

### Wave 2 — Kernel (6 parallel)

Everything here is depended on by 15+ modules. It must be stable before module fan-out.

| Agent               | ID   | Owns                                                                                 | Deliverable                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ------------------- | ---- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `senior-be`         | W2-A | `backend/src/kernel/stock-ledger/**`                                                 | The **only** writer of `stock_balances`. Per location **and storage area**; in/out/transfer/adjustment/waste/return; transactional; emits `StockMoved`. **Two modes per D-17a**: `post(tx, movements, 'strict')` rejects a movement that would go negative (interactive writes); `post(tx, movements, 'fact')` applies a replayed offline fact even if it drives the balance negative and opens a reconciliation exception. Uses the shared projector from `packages/sync-protocol` (D-16a) — does not reimplement it. Property-tested: balance ≡ projection of the fact stream, always, in both modes. |
| `senior-be`         | W2-B | `backend/src/kernel/approvals/**`                                                    | Generic engine: `submit / approve / reject / amend`, multi-step chains per document type, actor + timestamp + **reason on reject or amend (FR-LOG-13)**, `offline_authorized` flag + re-verification hook (D-17), "my pending approvals" query.                                                                                                                                                                                                                                                                                                                                                         |
| `medior`            | W2-C | `backend/src/kernel/{audit,notification,storage,events}/**`, `infrastructure/n8n/**` | `@Audited()` before/after diff interceptor; `NotificationService` with in-app + SMTP + **n8n WA webhook** channels + template registry; `StorageService` (MinIO presigned, compression, EXIF strip); in-process `EventBus`.                                                                                                                                                                                                                                                                                                                                                                             |
| `senior-integrator` | W2-D | `backend/src/kernel/sync/**`                                                         | **Cloud sync engine.** Idempotent batch ingest, per-subscriber cursors, authority-matrix enforcement (rejects a push that violates ownership), conflict log, reconciliation jobs, sync-status API. Property-tested: replaying any batch any number of times in any order yields identical state.                                                                                                                                                                                                                                                                                                        |
| `senior-fe`         | W2-E | `frontend/src/lib/local/**`, `public/sw.js`, `public/manifest.json`                  | **Tier-1 local-first runtime.** Service worker (app-shell + catalog precache), IndexedDB schema, durable outbox with retry/backoff, idempotency keys, online/offline/LAN detection, reconciler, conflict surface, cached offline credentials (D-17). Standalone-testable against a fake backend.                                                                                                                                                                                                                                                                                                        |
| `senior-integrator` | W2-F | `apps/branch-node/**`                                                                | **Tier-2 node skeleton.** Outbound socket.io to cloud (no inbound ports), pairing by token, 30s heartbeat, local Postgres bootstrap + migration subset, LAN discovery ported from AIRE `branch-bridge` (mDNS/SSDP/TCP probe), local `/health`, **`SIMULATE=true` hardware-free mode** so every other agent and CI can run it on a laptop.                                                                                                                                                                                                                                                               |

> **Shared-database test interference.** Wave 2's kernel agents run integration tests concurrently against one Postgres instance, and they observe each other's failures. W2-A reported 41/41 green; W2-C, running at the same time, saw some of W2-A's and W2-B's tests failing. Cross-agent reports of _other_ agents' test results are therefore not evidence of a defect. **G2 must be closed on a serial re-run of the full suite against a freshly reset database, by the integrator — not on concurrent per-agent reports.** Later waves should move integration tests to per-agent schemas or transaction-scoped rollback (W2-A's `test-support/live-db.ts` already does the latter and is the pattern to copy).

**Gate G2 (the hard one):**

- Kernel unit + property tests green.
- Scripted scenario moves stock through ledger → approval → audit → notification.
- **Offline harness:** 50 queued sales survive a simulated 24h outage + reconnect with zero duplicates and zero loss.
- **Node harness:** `SIMULATE=true` node pairs, heartbeats, discovers synthetic devices, appears in the topology tree, and its disappearance flips status to offline within the staleness window.
- **Sync fuzz:** randomised interleaved batches from 3 origins converge to one state.

---

### Wave 3 — Domain modules, backend (10 parallel)

All against `docs/CONTRACTS.md`. One agent, one `modules/<dir>`, own tests.

| Agent | Modules                                                                         | Type                |
| ----- | ------------------------------------------------------------------------------- | ------------------- |
| W3-01 | M01 `auth` + M02 `users` + M20 `settings`                                       | `senior-be`         |
| W3-02 | M03 `location` (incl. storage areas) + M04 `item` + M05 `product`               | `medior`            |
| W3-03 | M06 `supplier`                                                                  | `junior`            |
| W3-04 | M07 `inventory`                                                                 | `senior-be`         |
| W3-05 | M08 `stock-opname`                                                              | `medior`            |
| W3-06 | M09 `replenishment`                                                             | `senior-be`         |
| W3-07 | **M10 `delivery`** — Surat Jalan, drops, cold chain, receiving (largest module) | `senior-be`         |
| W3-08 | M13 `pos`                                                                       | `senior-be`         |
| W3-09 | M14 `hr`                                                                        | `medior`            |
| W3-10 | **M21 `device-registry` + M22 `node-gateway`**                                  | `senior-integrator` |

**Gate G3:** every contract endpoint for these modules responds correctly; integration tests green; RBAC negatively tested (a Kasir token gets 403 on supplier pricing); audit rows on every mutation; a simulated node's devices render in the topology API.

---

### Wave 4 — Remaining backend + frontend fan-out (10 parallel)

| Agent | Scope                                                                                                                  | Type        |
| ----- | ---------------------------------------------------------------------------------------------------------------------- | ----------- |
| W4-01 | M15 `payroll` — 7 income + 9 deduction components, SO-shortfall link, kasbon amortization, slip generation             | `senior-be` |
| W4-02 | M11 `purchasing` + M12 `waste-return`                                                                                  | `medior`    |
| W4-03 | M17 `accounting` — COA, journal, **posting-rule engine consuming domain events**, payment verification, fiscal periods | `senior-be` |
| W4-04 | M16 `asset` + M18 `dashboard` + M19 `report`                                                                           | `senior-be` |
| W4-05 | F01 `(auth)` + F10 `admin`                                                                                             | `medior`    |
| W4-06 | **F02 `pos`** — tablet UI, cart, payment, Bluetooth ESC/POS, wired to W2-E offline runtime                             | `senior-fe` |
| W4-07 | F04 `outlet` — request, terima barang + foto, stok per area, SO, waste/retur, petty cash                               | `senior-fe` |
| W4-08 | F05 `warehouse` — stok, approval queue, picking, **Surat Jalan builder**, receiving, retur supplier                    | `medior`    |
| W4-09 | **F13 `driver`** (offline multi-drop, suhu, segel, tanda tangan, foto) + F09 `assets`                                  | `senior-fe` |
| W4-10 | F08 `hr` + F11 `me` (mobile absen GPS + selfie, slip, cuti)                                                            | `medior`    |

**Gate G4:** full backend surface complete; POS completes a sale online _and_ offline; a Surat Jalan is drivable end-to-end from warehouse → driver → outlet receipt; approval chains drivable through the UI.

---

### Wave 5 — Completion & integration (7 parallel)

| Agent | Scope                                                                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W5-01 | F03 `dashboard` — owner KPI tiles, revenue/profit, top produk, KPI pegawai, drill-down, realtime                                                                                              |
| W5-02 | F07 `finance` — verifikasi pembayaran queue, jurnal, COA editor, trial balance, P&L, exports                                                                                                  |
| W5-03 | **F12 `topology`** — live device tree, heartbeat, per-outlet sync health, queue depth, conflict + exception queues, offline-authorization review                                              |
| W5-04 | F06 `purchasing` UI + notification surfaces everywhere (bell, approval inbox, low-stock, maintenance, **cold-chain breach**, **outlet-offline alert**); n8n WA workflow wired and live-tested |
| W5-05 | Print/document layer: nota kasir 58/80mm, **Surat Jalan PDF**, slip gaji PDF, PO PDF, laporan shift, rekap pengiriman harian                                                                  |
| W5-06 | Accounting posting-rule completion: all 16 PRD journal event types verified to emit balanced entries from real domain actions                                                                 |
| W5-07 | **Branch-node hardening**: fleet update channel, remote log pull, node-side migration rollout, pairing/unpairing UX, packaged Docker image + install script                                   |

**Gate G5:** feature-complete. Every FR ID in §10 maps to a working screen or endpoint.

---

### Wave 6 — QA & hardening (6 parallel + lead)

| Agent | Scope                                                                                                                                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W6-00 | QA lead — owns the acceptance matrix, adjudicates, gates merges                                                                                                                                                                     |
| W6-01 | E2E per role journey: 8 roles × primary flow, Playwright                                                                                                                                                                            |
| W6-02 | **Offline/sync adversarial suite** — kill network mid-sale, duplicate submit, clock skew, tab close, storage full, 24h offline bulk sync, two tablets diverging in one outlet, node down while devices up, node up while cloud down |
| W6-03 | RBAC/authz penetration: every endpoint × every role, IDOR on `location_id`, RLS bypass, **pairing-token abuse**, **offline-credential replay (D-17)**                                                                               |
| W6-04 | Financial correctness: payroll golden cases, GL always balances, stock ledger vs opname reconciliation, GoFood/ShopeeFood net-received math, cold-chain breach → waste → journal path                                               |
| W6-05 | Perf (NFR-01: 150 concurrent, <3s) with k6; N+1 hunt; index review; PWA Lighthouse; **sync throughput at 20 outlets × 1 day backlog**                                                                                               |
| W6-06 | Topology/heartbeat soak: 30 simulated devices flapping for 24h; alert precision (no false "outlet offline" on a 20s blip)                                                                                                           |

**Gate G6:** zero critical/major open; NFR-01..10 each evidenced.

---

### Wave 7 — Deploy, docs, handover (5 parallel)

| Agent | Scope                                                                                                                                         |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| W7-01 | VPS provisioning, Traefik + TLS, prod compose, secrets, `pg_dump` cron + offsite + **restore drill**, uptime monitoring (SCOPE-IN-11, NFR-06) |
| W7-02 | `docs/TECHNICAL.md`, `DEPLOYMENT.md`, API reference, **branch-node install runbook** (DEL-02, DEL-03)                                         |
| W7-03 | **DEL-04 user manual, Bahasa Indonesia**, per role, screenshot-driven; training deck (DEL-05)                                                 |
| W7-04 | DEL-06 hardware spec: tablet, Bluetooth thermal printer, network, **and optional branch-node mini-PC spec**                                   |
| W7-05 | Data onboarding importer (CSV/XLSX → menu, staf, cabang, storage areas, supplier, aset) per ASM-01                                            |

---

## 5.5 Dispatch budget policy (revised — fits a 5-hour cycle on a $100 team seat)

Waves 1–3 ran 5–10 concurrent agents at 300–800k subagent tokens each (~5M tokens for Wave 3 alone) and exhausted the session limit **four times**, killing 14 agent-runs mid-edit. The work survived each time — thanks to one-agent-one-directory — but the restarts cost real budget. From Wave 3's tail onward:

### Hard limits

| Rule                        | Value                                                                                                                                                                                                                                                                                                            |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Max concurrent agents**   | **3** (was 10)                                                                                                                                                                                                                                                                                                   |
| **Sub-agent fan-out**       | **Forbidden.** A dispatched agent does its own work; it must not spawn children. W4-04 spawned three, tripling one ticket's budget and putting five agents against a cap of three — then ended its turn with no results, since nothing wakes a parent to collect them. **State this explicitly in every brief.** |
| Target tokens per agent     | ≤ 250k                                                                                                                                                                                                                                                                                                           |
| Target tool calls per agent | ≤ 60 (Wave 3 agents averaged ~130, peaked at 199)                                                                                                                                                                                                                                                                |

### Where the tokens actually went — and the fix

1. **Re-reading whole contracts.** Agents read all 3,448 lines of CONTRACTS.md. → **Brief with exact section numbers only** (`read §4.13, §2.4, §5.9`), never "read CONTRACTS.md".
2. **Running the full repo suite repeatedly.** → **Agents run only their own directory.** The coordinator runs the full suite, once, at the gate.
3. **Exploratory greps across the whole tree.** → Brief states the reference files by path (`copy kernel/approvals/test-support/live-db.ts`), so no search is needed.
4. **Coordinator verification churn.** I re-ran full suites after nearly every agent. → **Gate-check individual modules only; full serial run once per wave.**
5. **N messages to N agents for one cross-cutting fix.** → **Batch into a single cleanup agent** owning the sweep across all affected files (the five `system-context` copies are one ticket, not five).

### Revised wave shapes

- **Wave 4** (10 tickets) → **4 batches of ≤3**, sequential. Batch on dependency order, not convenience.
- **Waves 5–7** → same, ≤3 concurrent.
- Consolidation and cleanup → **one agent, one sweep**, never fan-out.

### What does not change

The gate procedure (§6 of PROGRESS.md) stays in full. It costs coordinator tokens but it has caught six false-green failures including two of my own. Cutting verification to save budget would trade a measurable cost for an unmeasurable one.

## 6. Collision rules — read before dispatching

1. **One agent, one directory.** §4.2/§4.3 are exclusive ownership. Need a change elsewhere? File it with the integrator; do not edit.
2. **Shared registry files are pre-populated in Wave 1 and frozen**: `app.module.ts`, nav config, `packages/*/index.ts`, all `package.json`. No agent runs `pnpm add` — dependency requests go to W1-A.
3. **Migrations only in your allocated block** (§4.1); post-G1 fixes as `2NN_<agent-id>_<slug>.sql`. Never edit an applied migration.
4. **`packages/shared` and `packages/sync-protocol` are read-only after G1** except by their owner. They are the type contract; a concurrent edit breaks ten agents at once.
5. **Never write `stock_balances` directly** (D-07). **Never write `audit_log` directly** (D-09). **Never hand-roll an approval flow** (D-08). **Never sync a balance** (D-16).
6. **Every mutation emits a sync event** via the kernel helper — a module that writes without emitting silently breaks offline outlets.
7. **Contract changes go to the architect, not to the code.** The architect amends `CONTRACTS.md`/`SYNC-PROTOCOL.md` and the integrator broadcasts.
8. **Every agent writes its own tests** and leaves the suite green.
9. **Bahasa Indonesia for all user-facing strings**, via i18n keys, never hardcoded. English for code, comments, docs.

### 6.1 Agent brief template

```
CONTEXT
  Read docs/BUILD-PLAN.md §1 (decisions), §6 (collision rules);
  docs/CONTRACTS.md sections <list>; docs/SYNC-PROTOCOL.md §<n> if you mutate data.
  Reference style: ../aire/aire/apps/backend/src/modules/inventory/ (controller/service/module shape).

YOU OWN (exclusive write access, nothing else)
  <exact paths>

BUILD
  <module/surface>, covering PRD requirements: <FR IDs>

CONSTRAINTS
  - Use kernel services: StockLedgerService / ApprovalService / @Audited /
    NotificationService / StorageService / SyncService.emit().
  - Raw pg via DATABASE_POOL. No ORM. Parameterized queries only.
  - Every mutating endpoint: @RequirePermission(<key>) + @Audited() + a sync event.
  - Money NUMERIC(18,2), qty NUMERIC(14,3), temp NUMERIC(4,1), tz Asia/Makassar, IDR.
  - Stock only via StockLedgerService, keyed by (location_id, storage_area_id, item_id).
  - User-facing strings via i18n keys, Bahasa Indonesia.
  - Migrations: only block <NNN–NNN> or 2NN_<your-id>_*.sql.

DONE WHEN
  - Every endpoint in your contract section responds per spec.
  - Unit + integration tests written and green; pnpm build && pnpm lint clean.
  - RBAC verified: an unauthorized role receives 403.
  - Your writes replay idempotently through the sync engine.
  - You touched zero files outside YOU OWN.

REPORT
  Endpoints delivered, tests added, contract deviations, blockers.
```

---

## 7. Critical path

```
W0 contracts ──┬─> W1-C schema ──┬─> W2-A stock-ledger ─> W3-04..08 ─> W4-03 accounting ─> W5-06 ─┐
               │  W1-B shared ───┤                                                                 │
               │  W1-D be-core ──┼─> W2-B approvals ────> (all approval modules) ──────────────────┼─> W6 ─> W7
               │  W1-E fe-core ──┤                                                                 │
               └─────────────────┼─> W2-D sync engine ──┬─> W2-E device local ─> W4-06 POS ─┐      │
                                 │                      └─> W2-F branch node ──> W5-07 ─────┴──────┘
                                 └─> W3-10 device-registry ─> W5-03 topology
```

Four single-owner deliverables decide whether this lands: **W1-C schema**, **W2-D sync engine**,
**W2-E device local runtime**, **W2-F branch node**. Each gets an extra review pass before its gate closes.

---

## 8. Definition of Done — per module

- [ ] All assigned FR IDs implemented and traceable (§10)
- [ ] Endpoints match `CONTRACTS.md` exactly
- [ ] Unit + integration tests; property tests on any money/qty/sync logic
- [ ] RBAC enforced and negatively tested
- [ ] Audit rows on every mutation
- [ ] Sync events emitted and replay-idempotent
- [ ] Photo evidence enforced where the PRD says _wajib foto_: FR-LOG-15, FR-WST-01, petty cash, FR-HR-01, FR-PMS-04, and every Surat Jalan drop
- [ ] Rejection/amendment reasons captured (FR-LOG-13, FR-SO-02)
- [ ] All strings via i18n, Bahasa Indonesia
- [ ] `pnpm build && pnpm lint && pnpm test` green
- [ ] Zero files touched outside owned paths

---

## 9. Risks

| ID      | Risk                                                                                                                                                                                                                                                                                                                                  | Mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RISK-P1 | Contract drift across 20 agents                                                                                                                                                                                                                                                                                                       | Enums and RBAC live in `packages/shared` and are _imported_, never retyped. Integrator diffs each module's real routes against the contract table at every gate.                                                                                                                                                                                                                                                                                                                                              |
| RISK-P2 | Schema churn after G1 breaks modules mid-flight                                                                                                                                                                                                                                                                                       | Schema frozen at G1; changes need architect-approved `2xx` migration + broadcast. Budget 2–3; refuse a fourth without re-gating.                                                                                                                                                                                                                                                                                                                                                                              |
| RISK-P3 | **Three-tier sync is the single largest technical risk**                                                                                                                                                                                                                                                                              | Protocol is append-only and idempotent by construction — the property tests are the design. W2-E and W2-F both build against fakes so UI work never blocks on them. Fallback ladder: (1) full three-tier, (2) device-local only, no node, (3) read-cache only. **Decide at G2, not later.**                                                                                                                                                                                                                   |
| RISK-P4 | WA gateway credentials (D-03) not supplied in Week 1                                                                                                                                                                                                                                                                                  | Channel ships with a mock writing to `wa_outbox` (AIRE does exactly this). Email + in-app carry go-live; WA flips on by config. Escalate to PM end of Week 1.                                                                                                                                                                                                                                                                                                                                                 |
| RISK-P5 | **Branch node conflicts with SCOPE-OUT-01/02 (no hardware, no on-site install)**                                                                                                                                                                                                                                                      | This is why D-12 makes the node _optional_. Default go-live is hardware-free. Deploying nodes to 15–20 outlets in 4 cities needs a **change order** covering mini-PCs, on-site install, and fleet updates — raise with the PM before Week 3. Full LAN discovery (D-13) is only available where a node exists; topology degrades gracefully everywhere else.                                                                                                                                                   |
| RISK-P6 | Double-entry GL (D-04) is the largest scope expansion over PRD wording                                                                                                                                                                                                                                                                | Posting-rule engine keeps it declarative. If it slips, the event ledger rows still satisfy the PRD literally; GL reports follow.                                                                                                                                                                                                                                                                                                                                                                              |
| RISK-P7 | Client data (ASM-01) arrives late → QA tests fiction                                                                                                                                                                                                                                                                                  | W1-C seeds realistic synthetic Mimi data on day one. W7-05 builds the importer for real data at go-live.                                                                                                                                                                                                                                                                                                                                                                                                      |
| RISK-P8 | **The amendments materially exceed the PRD's 4-week, 1-developer envelope**                                                                                                                                                                                                                                                           | Surat Jalan + cold chain, storage areas, device topology, three-tier sync, and full GL are each beyond PRD wording. Parallel agents compress _coding_, not UAT (ASM-05), client feedback, data onboarding, or on-site rollout. Recommend: PRD scope go-live at Week 4 with device-local-first; branch nodes, LAN discovery, and cold-chain rollout as a Phase 1.5 covered by a change order. **This is a PM/commercial decision, not an engineering one — flag it to Samuel Jason before Wave 1 dispatches.** |
| RISK-P9 | Offline authorization becomes a fraud vector (the opposite of OBJ-03)                                                                                                                                                                                                                                                                 | D-17: provisional offline approvals, short-TTL cached credentials, `offline_authorized` flag, mandatory re-verification on sync, failures to a finance exception queue reviewed in F12. Tested by W6-03. **Partially mitigated only — see RISK-S2.**                                                                                                                                                                                                                                                          |
| RISK-S1 | **LAN HTTPS to a branch node** (per-node DNS + DNS-01 cert) can be silently broken by consumer routers with DNS-rebind protection. A paid-for node would then add nothing at that outlet, degrading to cloud-direct.                                                                                                                  | W2-F runs a spike in its first days; runbook step in W7-02. If flaky, the fallback is a companion shell app instead of browser access — a product decision for the PM, and one more reason nodes are Phase 1.5 (RISK-P5).                                                                                                                                                                                                                                                                                     |
| RISK-S2 | **Residual offline-approval fraud window.** The supervisor approves on the _cashier's_ tablet, which holds the binding secret and PIN verifier. A cracked 6-digit PIN plus stripped telemetry yields an approval that lands as `unprovable` (finance review), not auto-rejected. The control is detection and review, not prevention. | Inherent to approving on the subordinate's device. Prevention needs approver-owned-device signing (QR handshake) — a UX and scope change. **Raise with the PM if SM-02 (>50% fraud reduction) is the binding target.**                                                                                                                                                                                                                                                                                        |
| RISK-S3 | Offline attendance from personal phones depends on prior online login and honest-ish clocks; long-isolated outlets will generate `time_disputed` rows HR must actually work.                                                                                                                                                          | `defensible_at` clamp bounds the damage. Process risk — belongs in the W7-03 manual and HR training, not in code.                                                                                                                                                                                                                                                                                                                                                                                             |
| RISK-S5 | Photo/evidence volume at 20 outlets: the 24h evidence-sync SLA and 200 MB device binary cap are educated guesses.                                                                                                                                                                                                                     | W6-05 validates against real capture rates before go-live tuning.                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

## 10. PRD traceability

| PRD section                             | FR IDs                                   | Owner                |
| --------------------------------------- | ---------------------------------------- | -------------------- |
| 8.1.1 Distribusi                        | FR-LOG-01..05                            | M10 / F05, F13       |
| 8.1.2 Auto-replenishment                | FR-LOG-06..13                            | M07 + M09 / F04, F05 |
| 8.1.3 Serah terima                      | FR-LOG-14..16                            | M10 / F04, F13       |
| 8.1.4 Stok min gudang                   | FR-LOG-17..21                            | M07 / F05            |
| 8.2 POS                                 | FR-POS-01..07                            | M13 / F02            |
| 8.3 HR & Payroll                        | FR-HR-01..04, PIN-01..07, POUT-01..09    | M14, M15 / F08, F11  |
| 8.4 Dashboard                           | FR-DASH-01..04                           | M18 / F03            |
| 8.5 PMS                                 | FR-PMS-01..04                            | M16 / F09            |
| 8.6 Purchasing                          | FR-PO-01..04, FR-SUP-01..06              | M06, M11 / F06       |
| 8.7 Stock opname                        | FR-SO-01..04                             | M08 / F04            |
| 8.8 Waste/Retur                         | FR-WST-01..04                            | M12 / F04, F05       |
| 8.9 Accounting                          | FR-ACCT-01..04, JGUD-01..07, JOUT-01..09 | M17 / F07            |
| 8.10 Audit trail                        | FR-AUDIT-01..02                          | kernel W2-C / F10    |
| 8.11 Approval matrix                    | APR-01..08                               | kernel W2-B + M01    |
| 9 NFR                                   | NFR-01..10                               | W6-05, W7-01, W1-E   |
| **Amendment: topology + heartbeat**     | D-13                                     | M21, M22 / F12       |
| **Amendment: local-first + sync**       | D-12                                     | M23, kernel W2-D/E/F |
| **Amendment: surat jalan + cold chain** | D-14                                     | M10 / F05, F13       |
| **Amendment: outlet storage system**    | D-15                                     | M03, M07 / F04, F10  |

---

## 11. Immediate next step

Dispatch **Wave 0 (architect, solo)** to produce `docs/CONTRACTS.md` + `docs/SYNC-PROTOCOL.md`,
then hold for human review of the RBAC matrix, the schema sketch, and the sync authority matrix.
In parallel, escalate **RISK-P5 and RISK-P8** to the PM — those are commercial decisions that
should be settled before 20 agents start building against them.
