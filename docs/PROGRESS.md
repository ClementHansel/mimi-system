# Mimi Chicken OS — Progress Tracker

**Last updated:** 2026-08-23 — **B-11 CLOSED** (all four outlet flows now project server-side), on top of B-15, B-17, B-13, B-08, D-22b, D-27, D-30. Everything verified ON THE SERVER (Linux) before merge and deployed. Backend **899/899**, frontend **515/515**, shared **257**.
**Maintenance rule:** this file is updated by the coordinator **every time a task or wave completes**, and whenever a blocker opens, changes state, or closes.

Legend: `[x]` done & verified by coordinator · `[~]` in flight · `[ ]` not started · `[!]` blocked

---

## 1. At a glance

| Wave                      | Tasks  | Done   | State                                                                                                 |
| ------------------------- | ------ | ------ | ----------------------------------------------------------------------------------------------------- |
| **0 — Contracts**         | 2      | 2      | ✅ complete                                                                                           |
| **1 — Foundation**        | 5      | 5      | ✅ complete · **Gate G1 closed**                                                                      |
| **2 — Kernel**            | 6      | 6      | ✅ complete · **Gate G2 closed**                                                                      |
| **3 — Domain backend**    | 10     | 10     | ✅ complete · gate closed                                                                             |
| **4 — BE finish + FE**    | 10     | 10     | ✅ complete                                                                                           |
| **5 — Completion**        | 8      | 6      | 🔄 print + inbox DONE; node field package DONE, installer/signing owed; WA live test blocked          |
| **5b — Owner UI round**   | 8      | 8      | ✅ complete · QA-ISOLATION closed (803/0 on a fresh DB)                                               |
| **5c — IA rework**        | 6      | 4      | 🔄 F-HUB-2/F-POS-2/F-DOCS/FIX-SECURECTX done; FIX-LOADS unverified; **F-UX in flight now**            |
| **6 — QA**                | 7      | 5      | 🔄 W6-00/01/03/04/06 DONE; W6-02 partial; W6-05 scripts now provably load, 150-VU gate needs a target |
| **7 — Deploy & handover** | 5      | 1      | 🔄 deployed + CI/CD; backups scheduled & restore-drilled; W7-01 open on TLS (B-14)                    |
| **Totals**                | **67** | **57** | **85%**                                                                                               |

**Outside the wave register** — four owner-driven rounds landed 2026-08-20/21 and are tracked in §2, not
here: B-16 general-ledger wiring (closed), supplier management UI (done), the driver interface upgrade
(5 of 6), WhatsApp chat (built, delivery unproven), and the six-interface IA rework (in flight, uncommitted).

**Measured test state** — each row carries the date it was last actually executed. Nothing here is taken from an agent report.

| Workspace          | Result                                                                                                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `@mimi/backend`    | **895 pass / 0 fail**, 97 files — re-run 2026-08-23. The `waste-return` drift that failed twice on 2026-08-22 was root-caused and fixed by the concurrent session (`25ad6fc`), so this is genuinely clean again, not mitigated |
| `@mimi/frontend`   | **499 pass (499)**, 81 files — re-run 2026-08-23, three consecutive clean runs                                                                                                                                                 |
| `@mimi/shared`     | **257 pass** · `@mimi/sync-protocol` 141 pass · `@mimi/branch-node` 42 pass                                                                                                                                                    |
| `@mimi/e2e`        | **41 pass (41)**, 7 files — real browser vs the live box (`pnpm e2e`)                                                                                                                                                          |
| **Campaign total** | **1,651 unit/integration + 41 e2e** (895 backend + 499 frontend + 257 shared/sync-protocol/branch-node)                                                                                                                        |

112 migrations (latest **233**, the B-15 pair — renumbered from 230/231 by a concurrent session) · 111 tables + 4 matviews (counted from the live schema, 2026-08-22) · 10 roles · `tsc`, `lint` (0 errors) and `format:check` all clean, re-verified 2026-08-23.

**CI is GREEN** — first passing run in 11 commits; see 1c-3 for why it had been red and never reached the tests.

**Deployed:** `http://150.109.15.108:8080` — demo box, mock data, auto-deploys from `main`. Own Postgres/Redis/MinIO, one public port, seven neighbouring projects untouched.

---

## 1a. What is left — the whole remaining list (2026-08-21)

Read this first. Everything below is either open, partial, or waiting on someone who is not an
engineer. Ordered by what stops a go-live, not by wave number.

### A. Blocked on the owner / client — no code will unblock these

| #   | Item                                                                                                                                      | What is needed                                                                                                                                          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A-1 | **B-14 — HTTPS.** Testable now: self-signed TLS on `:8443` (secure context, so geolocation/camera/PWA work). A TRUSTED cert still blocked | A decision on `aire-nginx`, which holds `:80`/`:443` while restart-looping. Let's Encrypt needs one of those ports; DNS-01 is not available on sslip.io |
| A-3 | **RISK-P4 — WhatsApp gateway credentials.** `WA_ENABLED=false`                                                                            | Real n8n + gateway credentials. Blocks W5-08's live test and the new chat's delivery proof                                                              |
| A-4 | **Offsite backups.** `OFFSITE_REMOTE_CMD` unset — dumps sit on the database's own disk                                                    | An offsite target (rclone/S3) chosen by the owner. NFR-06                                                                                               |
| A-5 | **W7-04 hardware spec**                                                                                                                   | Budget, vendor, per-outlet device count                                                                                                                 |
| A-6 | **W7-05 data importer**                                                                                                                   | The owner's real master-data files to design against                                                                                                    |
| A-7 | **GL history backfill** (B-16 aftermath)                                                                                                  | Owner's call. `POST /api/accounting/daily-posting` backfills sales per day; the document-side events have **no** backfill written yet                   |
| A-8 | **RISK-P5 — branch node at scale**                                                                                                        | A PM change order — ~20 mini-PCs installed across 4 cities                                                                                              |

### B. Engineering work still owed

| #       | Item                                                                                                                                                                                                                   | Size                                       |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| B-2     | **W6-05 — run the perf harness.** NFR-01 is still evidenced by NOTHING; the k6 suite has never been executed                                                                                                           | small — needs a backend to point at        |
| B-3     | **B-11 — four outlet flows have no offline path** (`stock_opname`, `waste_records`, `returns`, `petty_cash`)                                                                                                           | large — needs the architect decision first |
| B-5     | **W5-07 — branch-node packaging.** `install.sh`, signed images + a CI registry publish, a fleet self-update channel                                                                                                    | medium (gated behind A-8)                  |
| B-6     | **W6-02 — the service-worker half of the offline adversarial suite**                                                                                                                                                   | blocked by A-1                             |
| B-8     | **W7-02 technical docs.** (W7-03, the Bahasa Indonesia manual, is already DONE as `/docs` — see F-DOCS)                                                                                                                | medium                                     |
| ⚠️ B-9  | **DONE 2026-08-23 — needs the `VPS_PUBLIC_URL` repo secret.** Post-deploy `e2e-smoke` job; fails loudly until that secret exists, by design                                                                            | set the secret                             |
| ✅ B-11 | **NOT A GAP (verified 2026-08-23).** `AppShell` renders nothing until hydrated; `/login` is the only public route. Pinned by `AppShell.hydration.test.tsx`                                                             | closed                                     |
| B-12    | **`attachment-store.test.ts` flake** — did NOT reproduce 2026-08-23 (6 isolated + 8 full runs clean). Still open; no fix attempted, because guessing at an unreproducible flake is how a real defect gets papered over | unknown                                    |
| B-13    | **Technical-debt register (§5)** — D-22b, D-27 and D-30 are now CLOSED; the rest of the register remains                                                                                                               | ongoing                                    |

### C. Known-incomplete, deliberately

`gudang_stock_revaluation` is not wired (Appendix A-8: it is a valuation statement, not an event) ·
`/driver` renders empty for owner/superadmin (neither account has a `drivers` row — working as
designed) · D-26 POS v1 scoping (single tender per sale; void only the last sale on this device) ·
owner still lacks 22 permission keys at the segregation-of-duties boundary, and nobody has reported
being blocked by them.

## 1a-2. In flight, uncommitted (2026-08-21) — the six-interface IA rework

The owner's ruling: the system has **six interfaces**, not fourteen destinations — `dashboard`, `pos`,
`outlet`, `warehouse`, `driver`, `docs`. Everything else (`/approvals`, `/delivery`, `/purchasing`,
`/chat`, `/finance`, `/hr`, `/assets`, `/me`, `/admin`, `/topology`) is a **section inside the
dashboard**, not a peer of it. That is what the previous hub got wrong — _"the hub is not supposed to
be shown like that"_ — it had become a second, flatter copy of the sidebar.

Working-tree state: `apps/frontend/src/lib/nav.ts` reworked into two levels (`INTERFACES` →
per-interface `sections`); a new `apps/frontend/src/lib/hub.ts` holding `HUB_ROLES`
(`owner`/`superadmin`, the only two roles the hub belongs to — shared so the Sidebar's "Home" row
cannot drift from the redirect and send everyone else to a page that bounces them straight back);
plus `app/page.tsx`, `Sidebar.tsx`, `lib/i18n/id.ts`, `e2e/tests/hub.spec.ts` and `page.test.tsx`.

**Verified 2026-08-21:** the full frontend suite passes on this working tree — **464/464, 73 files**.
Not yet done: committed, e2e re-run against the live box, or owner-reviewed.

---

## 1a-3. Session close-out — what is done, and what is not (2026-08-19)

Written at the end of the 2026-08-18/19 session so the next one starts from
facts rather than from re-reading the narrative below. Everything marked done
was verified on the live box, not inferred from a passing unit test.

### Done and verified

| Item                                                                | Evidence                                                                      |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Blank-page incident (half-valid session) — fixed                    | 4 poisoned session shapes recover to `/login`, covered by e2e                 |
| Sales consume stock; `mv_item_usage_daily` populated                | 1,093 `usage_out` movements, matview 0 → 496 rows                             |
| 32 empty tables filled; statutory payroll reachable                 | **zero** empty tables on the VPS, ledger invariant clean                      |
| Driver sees address + one-tap navigation                            | e2e asserts the Google/Waze deep links carry real coordinates                 |
| Gudang plans the route (order + per-stop brief, editable mid-route) | e2e round-trips a brief and re-reads it from the server                       |
| Hub = every interface for owner/superadmin; all others redirected   | e2e checks 15 cards for both roles, and the redirect for kepala gudang        |
| `superadmin` role (10th), central in RLS                            | migration 222; test fails and NAMES any permission it ever lacks              |
| Seed dates use the WITA business day                                | demo Surat Jalan lands on WITA today, verified at 00:xx WITA                  |
| CI green                                                            | both jobs pass; had been red for 11 commits, failing before the tests ran     |
| Nightly backups scheduled + restore drill passed                    | cron proven under `env -i`; dump restored into a throwaway DB, counts matched |
| Printable Surat Jalan + slip gaji (W5-05)                           | e2e opens both through their real buttons; `/print` still auth-gated          |
| Role journeys for all 10 roles (W6-01)                              | 39 e2e specs green against the live box; doubles as a nav-level RBAC sweep    |
| In-app notification inbox (W5-08 surfaces)                          | bell was decorative over a live API; now badge + inbox + read, e2e-covered    |
| Endpoint-level RBAC sweep (W6-03)                                   | 100+ routes; fails on any unguarded route. Surfaced B-15                      |
| Acceptance matrix (W6-00)                                           | `docs/ACCEPTANCE.md` — criterion → named evidence, with the gaps ranked       |
| `@mimi/e2e` is a real suite                                         | **24 specs, 24 passing, 0 skipped** against the live box                      |

### Not done — carried into the next session

| Item                                                   | Why it is open                                                                                                                                                               |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-14 — HTTPS** (see ACTIVE BLOCKERS)                 | Self-signed TLS is live on `:8443`, so truck tracking, attendance GPS/selfie and PWA install are testable. A trusted cert needs `:80`/`:443`, i.e. the `aire-nginx` decision |
| **Backups sit on the same disk as the database**       | `OFFSITE_REMOTE_CMD` unset. Protects against a bad `DELETE`, not against losing the host. Needs an offsite target (rclone/S3) chosen by the owner                            |
| **B-15 — PIN verification is an unthrottled oracle**   | Any authenticated caller can guess any user's PIN. Mitigation is a product decision — see the blocker                                                                        |
| **Live truck tracking cannot function**                | UNBLOCKED for testing as of 2026-08-23: reachable over `https://150.109.15.108:8443` (self-signed), which is a secure context, so geolocation is permitted                   |
| **Live-DB suites drain GDG stock**                     | Several `COMMIT` real movements instead of rolling back, so each full run draws the warehouse down. **Mitigated** (GDG stocked 10× deeper), root cause untouched             |
| **`attachment-store.test.ts` is flaky**                | Failed 2 of ~8 full runs, passes every time in isolation, has never failed in CI. No fix attempted — guessing at someone else's package is worse than flagging it            |
| **e2e is not wired into any pipeline**                 | Runs by hand via `pnpm e2e`. A post-deploy smoke job is the obvious next step but would need browser install in CI and a decision on failing a deploy on it                  |
| **`/driver` renders empty for owner/superadmin**       | `my-jobs` is a personal queue keyed on a `drivers` row neither account has. Working as designed; noted so it is not re-reported as a bug                                     |
| **Pre-hydration clicks are silently ignored app-wide** | Only the login form guards it. Elsewhere the first click on a server-rendered control can do nothing, with no feedback                                                       |

---

## 1b. Owner amendments (this session) — D-23…D-26

| Feature                                                                                                                                    | State                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Approval modes** — `manual`/`whatsapp`/`auto`/`off` per document type (D-23), WhatsApp as deep-link notification not auth (D-24)         | 🔄 backend building                                                                                                                                                                                                                                                                                             |
| **Connectivity + sync as two separate always-visible states** with a manual re-probe-and-sync button (D-25b)                               | ✅ **done** — 298 FE tests. Found the old pill _conflated_ both dimensions (`isolated` always won), so "offline but drained" and "online with backlog" were both hidden                                                                                                                                         |
| **Branch node per-outlet toggle, drain-before-off** (D-26)                                                                                 | ✅ **done** — 22 tests. Refuses OFF with a pending queue _and_ refuses when the node is unreachable, since a stale zero is not a current zero. Reuses the real unpair sequence, no parallel path                                                                                                                |
| **Cold chain: chilled + frozen share the truck** (owner: _"chilled and frozen always transported with chiller trucks… 2 types of trucks"_) | ✅ **backend done** — 66 delivery tests. `ShipmentType` stays `frozen`/`dry`, where `frozen` = the cold-chain truck carrying both classes. Range now comes from the **goods** via `storage_areas` (freezer −25…−15, chiller 0…5), evaluated **per class**, naming which class breached. Driver UI fix in flight |

**A worse bug found while fixing it:** `assertLinesMatchShipmentType` required exact `item.storage_type === shipmentType`, so **a chilled item could not be added to a frozen Surat Jalan at all** — chilled goods were structurally unshippable, not merely mis-validated. Also: had the range stayed static, every chilled reading would have flagged a breach, and an alarm that always fires is one drivers learn to ignore — which would have destroyed the cold-chain audit trail D-14 exists to create.

**Open follow-ups:** `@mimi/shared`'s `TempLog` exposes only `isBreach: boolean` and needs a `breachedClasses` field so the UI can name the class; the `coldchain.frozen` settings key is now a stale single range.

**Two real bugs found while building these:**

- `cloudReachable` returned `true` in LAN-only mode (`tier !== 'isolated'` instead of `=== 'online'`), so every plain-REST screen would attempt a cloud call in LAN mode and present the failure as a server error.
- **Worse, found adjacent:** `onUpstreamChange` fires only on a _transition_, so a device booting already-isolated never corrected the store's defaults — **a tablet powered on with no internet displayed "Online / Tersinkron"**. Fixed by reporting upstream state unconditionally from `start()` and the new `recheckConnectivity()`.

**Process failure of mine:** two agents in this batch edited `packages/shared` (frozen post-G1, collision rule 4) — one added a permission key, one added error codes. My briefs said "never write to `database/`" and never extended that to shared packages. All three additions were correct; the only casualty was a stale count assertion, since fixed. **Briefs must name every frozen path, not just the one that bit us last.**

## 1c. Post-Wave-4 work (owner amendments + incident fixes)

### 🔴 The application did not boot — **FIXED**

`SupplierModule` injected `SyncEmitService` without importing its module. Nest threw during graph construction, so **the entire API was dead**. Nothing caught it: **0 of 74 test files compiled `AppModule`**, only 1 used Nest's DI at all, and CI never started the app. Every suite constructs services directly, bypassing the container.
**Fixes:** the import; a boot test at `apps/backend/test/app-boot.spec.ts` that compiles the real graph and runs `init()` (**proven both directions** — fails with the exact original error when reverted); CI now runs it with postgres + redis.

### 🔴 `nest build` silently emitted nothing — **FIXED, and it was three packages**

`incremental: true` kept tsc's cache at the project root while `deleteOutDir: true` wiped `dist/`. tsc read "up to date", emitted zero files, exited 0. A deploy would have shipped an empty image.
**Reproduced in `packages/shared` and `packages/sync-protocol` too** (`rm -rf dist && npx tsc` → exit 0, no dist). All three now co-locate the cache at `dist/.tsbuildinfo`. CI and the Dockerfile both assert `dist/main.js` is non-empty; verified by booting the compiled graph **inside the built image**.

### B-11 offline flows — layers 1 and 2 done

| Layer                               | State                                                                                                                                                                      |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Wire contracts + payload schemas | ✅ **already existed** — audit found all four entities classified class-B with schemas cross-checked against live DTOs. Nothing built; would have been the 8th duplication |
| 2. Device commit helpers            | ✅ 135 tests in `lib/local`, transport-throws proofs                                                                                                                       |
| 3. Cloud projectors                 | ⬜ next                                                                                                                                                                    |
| 4. Outlet UI rewire                 | ⬜ after                                                                                                                                                                   |

**A silent-data-loss bug caught in layer 2.** `commitFact` dedupes on `(entity, entityId, op)`. Following my "use the entity id" instruction literally, a second `stock_opname.area_counted` would have **collided with the first area's queued row and been silently dropped** — an entire storage area's counts gone, no error. Since opname variance feeds POUT-05 wage deductions, that is money. Resolved with a distinct `areaCountId` per (opname, area) and a two-area regression test.

**Line correctly drawn by the contracts:** outlets may _submit_ opname/waste/petty-cash/replenishment offline; Kepala Gudang approving and Finance verifying stay online. Only the outlet-supervisor step is offline-provisional (D-17), re-verified on sync.

### 🔴 Dates shifted a calendar day under WITA — **FIXED**

Found while correcting a naming inconsistency, and the naming was the lesser bug. `FiscalPeriodsService` returned the raw `pg` row (`period_code`, `start_date`) — the only place in `modules/accounting` skipping the `toX()` mapping every sibling uses. Fixing the names exposed what the names were hiding: **`node-pg` parses a `DATE` column into a JS `Date` using the local-timezone constructor**, so the implicit `.toISOString()` in `JSON.stringify` shifts the calendar day by the server's UTC offset. Under `Asia/Makassar` (UTC+8) a period ending **June 30 serialized as `2026-06-29T16:00:00Z`** — a wrong date reaching the finance UI, not merely a wrong field name.

Caught only because the fix added a test asserting the **value**, not the type. A test checking `typeof startDate === 'string'` passes on the wrong day.

**Fixes:** camelCase `FiscalPeriod` matching CONTRACTS §4.17; a documented `formatDateOnly()` that recovers `YYYY-MM-DD` regardless of server timezone; the **same bug found and fixed on `JournalEntry.entryDate`** during the audit-for-other-leaks sweep. Every other endpoint in the module checked — all already map through `toX()`, no `SELECT *`, and their `TIMESTAMPTZ` fields don't suffer this. Regressions now assert exact round-tripped dates, so a reintroduced shift fails loudly.

> **Class of bug worth remembering:** `DATE` (no time, no zone) and `TIMESTAMPTZ` (an instant) behave differently through `pg` + `JSON.stringify`. Only `DATE` shifts. Any new `DATE`-typed column returned to a client needs `formatDateOnly()`.

### 🔴 14 controllers were unreachable at their documented paths — **FIXED**

`main.ts` applies a global `api` prefix, and 14 controllers _also_ declared `@Controller('api/...')`, so their real routes were `/api/api/...`. **Assets (3), suppliers, reports, all four HR controllers and all five payroll controllers** — entire subsystems answering 404 at every path CONTRACTS documents.

Nothing caught it: the app boots fine, the modules look correct in review, and **every suite calls services directly rather than over HTTP**, so no test ever issued a request to a real URL. Found only because the dashboard UI agent hit 404s building against the live API, investigated its own failure, and swept for siblings.

**Fixes:** all 14 corrected to the documented paths; a regression test (`test/no-double-api-prefix.spec.ts`) enumerates the registered route tree from the real `AppModule` **after** the global prefix is applied and asserts no route contains `/api/api/`.
**Coordinator-verified, not taken on report:** rebuilt, restarted, and probed each family with a real owner token — `assets`, `suppliers`, `reports/sales`, `hr/employees`, `payroll/periods`, `accounting/periods` all 200; `api/api/assets` correctly 404.

### 🔴 The UI reported "Offline" while fully online — **FIXED**

The header indicator and the offline banner were pinned to _Offline — Tidak Ada Koneksi_ on a system visibly loading live data. Cause: `/sync/v1/*` is deliberately **outside** the `/api` prefix (main.ts exclude list, CONTRACTS §4.23) so a device's sync transport needs no knowledge of the REST prefix — but `next.config.ts` proxied only `/api/*` and `/socket.io/*`. The health probe therefore hit the **frontend** origin, 404'd, and the upstream selector concluded every candidate was unreachable.

Production is unaffected (the backend owns the whole `api.DOMAIN` host there), so this only bites same-origin deployments — including every dev machine. Fixed by adding the `/sync/v1/:path*` rewrite alongside `/socket.io`, which existed for exactly the same reason.

> This is the feature the owner specifically asked for. It was **built correctly and wired incorrectly** — the kind of defect unit tests structurally cannot see, since the store, the probe and the transport are each individually right.

### 🟡 Two host-dev environment traps — **one fixed, one documented**

- `next.config.ts` fell back to `http://backend:4000` — a Docker service name that cannot resolve on a host — so `next dev` outside compose 500s every proxied call with no hint at DNS. Both compose files set `BACKEND_ORIGIN` explicitly, so the fallback is _only_ reached on a host; **changed to `localhost:4000`**, container runs unaffected.
- `.env` defines `REDIS_PORT=6379`, but the code reads **`REDIS_URL`** and the host mapping is **56379**. Starting the backend from `.env` alone crashes on redis. Not changed (compose-correct); needs `REDIS_URL` exported for host runs.

## 1c-2. Deployed to the shared VPS, and what deploying exposed (2026-08-17)

Live at `http://150.109.15.108:8080` (demo box, mock data). Own directory, own Postgres/Redis/MinIO, own network, **one** public port; the other seven projects on that host are untouched. Auto-deploys from `main` via GitHub Actions — proven green end to end, including a matview refresh step and a real 200 check on `/login`.

**Deploy-order trap worth remembering:** migrations create and refresh the reporting matviews while the database is still EMPTY; the seed loads data afterwards and nothing refreshes them again. A fresh deploy therefore renders **Rp0 and 0 transactions over a full database** — a working system reporting a terrible week, which is far more dangerous than an obviously broken one. The deploy pipeline now refreshes them.

### 🔴 The owner could not open POS or Pembelian — **FIXED**

- **POS** hung on "Memuat…" **forever** for any user without an assigned outlet (owner, manager, finance): `usePosLocation()` returned `user.locations[0]`, the catalog effect early-returned, and **zero API calls were ever made**. Now an outlet picker, persisted and always visible/changeable. A **second** indefinite spinner was found in the same file — `getBrowserLocalRuntime()` had no `.catch`, so an IndexedDB failure hung the page with an unhandled rejection. Both now end in an error + retry.
- **Pembelian** was never built — still the Wave-1 placeholder. The tracker said Wave 5 was complete; it was not. Now a real three-tab surface (PR, PO, price history) with the D-20 price gate.

### 🟠 "Where is delivery?" — the capability existed, the navigation did not

Recorded because the diagnosis was initially **wrong**. There was no `/delivery` route, so both the owner and the coordinator concluded the module was missing. In fact the whole dispatcher workflow — SJ list, multi-drop create, the chiller-vs-dry truck split, driver/vehicle assignment, ready→load→dispatch — already existed as a _tab inside_ `/warehouse`. An information-architecture failure, not a missing module, and the clearest argument in the file for the UX pass.
Resolved by promoting it to `/delivery` (adding status/date filters, a drop-level cold-chain view and a completion rollup), **deleting** the warehouse duplicate, and leaving an outbound summary that links through. Two places to create the same legal shipping document would have been an operational hazard.

### 🔴 A workflow step no UI could reach — **FIXED**

`POST /replenishment/:id/process` (`approved → processing`) existed, was documented, and **was never called from anywhere**. Outlets could request and the warehouse could approve, but nothing could be marked as being fulfilled — the chain dead-ended after approval.

### 🔴 An endpoint that could never have executed — **FIXED**

`GET /api/suppliers/:id/transactions` joined a nonexistent table (`purchase_order_lines`, not `po_lines`) and nonexistent columns. It would throw on every call. Nothing had exercised it over HTTP — the same blind spot that let 14 controllers sit at `/api/api/...`.

### 🔴 The DATE/WITA bug had a WRITE path — **FIXED**

Previously treated as a display defect. It is not: `receive()` stamped `effectiveDate` into `supplier_price_history` — an **append-only** table — using the shifted calculation, writing wrong dates permanently into a price audit trail. Five further sites found (`neededBy`, petty cash `purchaseDate`, PO `expectedDate`, supplier history and transactions). Helper promoted to `common/date-only.util.ts`; `replenishment` and `delivery` were each carrying their own private copy.

### 🟠 CONTRACTS documented fields the backend never sent — **FIXED**

PO/PR detail were specified to carry `approval` and `paymentStatus`; the services never attached either. The frontend had been typed from the contract rather than the response, so `components/warehouse/lib/types.ts` was reading `undefined`. Backend now implements both (list rows keep `approval: null` to avoid an N+1).

### 🟠 Hand-rolled copies of shared types dropped fields

`TempLog` was duplicated locally in **both** the driver and warehouse surfaces, and both copies omitted `breachedClasses`/`ranges` — making cold-chain breach information structurally invisible to any code using them. For a business moving frozen chicken that is a safety-relevant omission, not a typing nicety. Both now re-export from `@mimi/shared`.

### 🔴 An RLS policy hides rows from the role that creates them — IN PROGRESS

`payment_verifications_role` (migration 095) is `FOR ALL USING (owner, manager, finance)` with no SELECT carve-out. `kepala_gudang` performs receiving, receiving creates the row, and that role then cannot read it: `paymentStatus` returns `null` for the user who caused it (`'pending'` when re-read as owner). The fix must **not** simply widen the policy — write access to payment records for warehouse staff would break segregation of duties.

> **The through-line for the whole day:** every one of these is an integration defect. Each component was correct in isolation and wrong at the seam — and none was visible to a unit test. They surfaced only from deploying the thing and clicking through it.

## 1c-3. Session 2026-08-18 — dispatcher/driver routing, the all-access hub, and a green CI

Everything below is live on the VPS and verified in a real browser, not taken from agent reports.

### 🔴 The whole app rendered a blank white page — **FIXED**

Reported as "I opened it and the page is blank". The server was fine: `/` and `/login` both 200, every `_next` asset 200, and a clean browser profile rendered the login page perfectly. The cause was two auth gates checking **different things**. `AppShell` gated on `accessToken`; `app/page.tsx` gated on `user`. A stored session holding a token but no usable `user` passed the first and failed the second, so nothing rendered — **and the redirect never fired either**, because it only triggers when the token is falsy. No content, no console error, no navigation. A stored `Me` that merely _lost_ a field failed the other way: `user.locations.length` threw mid-render.

Anyone logged in before the IA/owner-UI reshape of `Me` hit one of the two. Fixed by making authentication mean token **and** user in both places, plus a persist `version` + `migrate` so an incompatible blob is discarded rather than rehydrated, and shape validation on every hydration for same-version corruption. All four poisoned states were reproduced against the live box and each now recovers to `/login`.

> **Class of bug worth remembering:** two gates on the same condition that read different fields will eventually disagree, and the failure mode is silence — not an error.

### 🔴 Selling never consumed stock — **FIXED**

`stock_movements` held nothing but `opening_balance` rows despite 418 sales, so balances never moved and `mv_item_usage_daily` was permanently empty. The deploy's `REFRESH` dutifully produced zero rows and every consumption report rendered blank **against a database that looked full** — the same "working system reporting nothing" shape as the matview trap in 1c-2.

Backfilled as `usage_out` movements derived from each product's recipe (1,093 on the VPS; the matview went 0 → 496 rows). Written as a **backfill, not an inline hook**: inline would only ever fire for newly inserted sales and would never have repaired an existing deployment. Transactional per sale so a decrement and its movement land together — an earlier draft crashed between them and left the ledger invariant broken, which is exactly the corruption the reconciliation console would later report as a real-world discrepancy.

### 🔴 Statutory payroll was unreachable, and 32 tables were empty — **FIXED**

`pph21_ter_rates` / `pph21_ptkp` / `bpjs_configs` were empty and **no migration fills them**, so `statutory.service.ts` failed closed with `ERR_STATUTORY_NOT_READY` and PPh21/BPJS could not be exercised at all. Purchasing dead-ended at the PO — `purchase_requests`, `goods_receipts`, `po_receipts` all empty — so requisition → receive → stock-in could never be walked end to end.

`database/seed-extended.ts` now fills the remaining **31 tables**; the VPS is at **zero empty tables**, ledger invariant clean, no negative balances. Statutory figures carry a prominent provenance warning: they are demo values, effective-dated so finance supersedes them through the admin UI, **not a compliance source**.

**Three seed defects the work surfaced, all fixed:** the seed could not be re-run on a later calendar day (`pos_shifts.shift_number` came from a loop offset while idempotency keyed on a date-derived `client_id`, so yesterday's `S100` collided with today's); the demo Surat Jalan kept its original `planned_date`, so `/driver` showed "no trip today" every day after seeding; and a seeded opname targeted the chiller, where no core item is chilled, so counting it correctly produced zero lines.

### 🟠 Drivers could not see where to go — **FIXED**

`queries.ts` selected only `l.name` and `l.city`. Every location already had `address`, `latitude`, `longitude` and `geofence_radius_m` populated — the data existed all along and was simply never sent, so a stop card could say "Outlet Loa Janan, Samarinda", which is not something you can navigate to.

Drops now carry address + coordinates + a per-stop delivery brief, and each open stop gets a **Navigasi** button. Navigation is a **deep link** into the map app already on the phone (Google Maps universal URL, plus Waze where coordinates exist) rather than an embedded routing SDK: no API key, no billing, no per-request cost, and it reuses the driver's own offline map cache. Deliberately not the `geo:` URI, which is unsupported on iOS — a dead Navigate button mid-route is worse than none.

### 🟠 Gudang could not set the route — **FIXED**

`drop_seq` was fixed at creation, so a dispatcher who spotted a wrong-way-round route had to cancel and rebuild the Surat Jalan, and per-stop guidance had nowhere to live but the trip-wide notes blob. Added `sj_drops.delivery_instructions` (migration 221) and a route planner: reorder stops, write a brief per stop, still editable mid-route once the order is locked.

**No auto-optimise, deliberately.** A truck is loaded back-to-front, so the sequence is a property of how it was packed; an optimiser reshuffling it would mean unloading half the truck at every stop. Reordering renumbers in two passes because `UNIQUE (sj_id, drop_seq)` is checked per-statement and a straight swap collides.

### 🟠 Live truck tracking — built, **blocked on HTTPS**

New `sj_positions` table: append-only breadcrumbs, batched and idempotent on `client_id` for offline flush, with `recorded_at` (device) kept separate from `received_at` (cloud) — collapsing them would make an offline stretch indistinguishable from a truck standing still, which is exactly what a dispatcher asks when a delivery is late. RLS mirrors `sj_drops_scope`, so a driver writes and reads only their own trail. The dispatcher gets a Leaflet/OSM map paired with a **list**, because a truck with no signal has no pin and that is the case you must not let disappear from the screen.

**It cannot work until the box serves HTTPS.** Browsers refuse geolocation on insecure origins — verified: `isSecureContext: false`, `getCurrentPosition` → `PERMISSION_DENIED "Only secure origins are allowed"`. Service workers are blocked for the same reason, so offline-first is degraded on HTTP too. The driver screen states this honestly rather than pretending. Unblocking is the documented upgrade path: a domain pointed at the box, then `docker-compose.prod.yml`'s Traefik + Let's Encrypt.

### 🔴 Every device reported itself permanently offline — **FIXED**

`getBrowserLocalRuntime` built its upstream list purely from the persisted device identity, but `identity.cloudUrl` is only ever written by `applyRegistration()` and **nothing in the app calls `/api/devices/register`**. So every browser handed the selector an **empty candidate list**: nothing to probe, the tier never moved, and every surface showed "Offline — Tidak Ada Koneksi. Perangkat ini bekerja sendiri" forever, on a good connection where `/sync/v1/health` returned `{"ok":true}`.

Worse than cosmetic: a false offline banner on a back-office laptop teaches people to ignore the one indicator that matters when a device really is isolated. The cloud candidate now defaults to the app's own origin — correct rather than a guess, since `next.config.ts` rewrites `/sync/v1/*` same-origin precisely so this works.

**Its own fallout, caught by a smoke pass over all 15 interfaces and fixed:** with an upstream finally available, every page fired `GET /sync/v1/pull` → `401 "Missing device credential"` on each heartbeat. Health is unauthenticated (which is what fixes the tier); push/pull/heartbeat are not. `SyncEngine` now takes `hasDeviceCredential` and skips authenticated cycles without one.

### 🟢 The hub is now an interface directory; `superadmin` added

Owner's ruling: _owner and superadmin see every interface; every other account is redirected to its own interface._ The hub had been a three-card chooser (Dasbor / Kasir / Dokumentasi) — abstract groupings rather than actual surfaces, and for a Kepala Gudang with several permitted areas it amounted to a second navigation menu.

Now **one card per unique interface** (15), grouped under the same sections as the sidebar so the two cannot disagree, derived from `lib/nav.ts` + `usePermissions` and never hand-listed. Owner and superadmin land here; everyone else is redirected — verified live: `kepalagudang1` → `/warehouse`, kasir/finance/hr → straight past the hub.

**Owner was missing exactly two surfaces** (`/outlet`, `/driver`) because it held none of `replenishment.create` / `opname.create` / `waste.create` / `pettycash.create` / `delivery.drop.execute`. It now does. **This is a real segregation-of-duties trade-off** — an owner can raise a document and approve it in the same session, which the approval chains were written assuming could not happen. It was put to the owner explicitly and accepted, and is recorded in migration 222 so it is not later read as an oversight.

**`superadmin` is the 10th role**, appended to `RBAC_ROLE_ORDER` — never inserted, because position _is_ the column index into all 138 matrix rows and inserting it anywhere else would have silently re-mapped the other nine. True on every row, with a test that fails and **names** any key it ever lacks. `ROLE_RANK` 110, above owner, so the approval engine's "act on any step at or below your level" rule reaches every chain. The login is seeded, deliberately **not** minted by the migration — that would put a privileged credential in version control and create it on every environment it ran against.

> **The half that would have silently broken it:** `app_is_central()` hardcoded four role names, and `app_has_location()` falls back to it for every location-scoped table. A superadmin holding all 138 permissions would have passed every guard and still read **almost nothing** — each query returning an empty set rather than an error, which reads as "the system has no data" rather than "this role cannot see it". Migration 222 adds the role there too; that is what makes the grants real.

`/driver` renders **empty** for owner/superadmin: `my-jobs` is a personal work queue keyed on a `drivers` row neither account has. Flagged before it was built; the dispatcher view is the owner-appropriate way to see a route.

### 🔴 CI had been red for 11 straight commits — **NOW GREEN**

Not noticed earlier because the failure was at the **Lint** step, so the test suite behind it had never run in CI at all. Three things stacked:

1. **Four ESLint errors**, all pre-existing and none in files this session touched (`rls-cleanup.interceptor.ts`, `supplier.integration.spec.ts`, `sync-admin.integration.spec.ts`).
2. **668 files failing `format:check`** — the repo had a `.prettierrc` and a CI gate but had **never been formatted**, so fixing lint alone would only have moved the failure one step down. Done in one mechanical commit (`78d35eb`), with `.git-blame-ignore-revs` so blame still points at whoever last changed a line's meaning.
3. **An empty `@mimi/e2e` stub failing the whole run** — `pnpm -r test` picked it up and `playwright test` exits 1 on "No tests found". Excluded from the recursive script; the dedicated `pnpm e2e` script still runs it.

### 🟡 Two test-isolation defects found while getting there

- **`pickUnusedStockKey` returned keys that were not unused.** It filtered on `stock_balances` alone, while stock-ledger's C5 property counts `stock_reconciliations` — and this database carries several reconciliation rows on keys with no balance row, left behind by earlier suites. `ORDER BY random()` made it an **intermittent** CI failure ("expected 5 to be 4") rather than a reproducible one. Now excludes movements and reconciliations too.
- **Live-DB suites drain the warehouse.** Several `COMMIT` real stock movements out of GDG instead of rolling them back (the `withWrite`-inside-`withRollback` behaviour the statutory suite documents at length), so every full run draws it down until it hits zero and the suite fails with `StockInsufficientError` on a database that seeded fine. Mitigated by stocking GDG an order of magnitude deeper than an outlet — realistic anyway, since one warehouse supplies twenty outlets. **The underlying isolation leak is not fixed.**

### Known-flaky, unresolved

`attachment-store.test.ts` ("evicts oldest UPLOADED blobs") failed 2 of roughly 8 full runs and passes every time in isolation. Load- or ordering-sensitive; it has **not** failed in CI. The eviction logic reads as deterministic, so no fix was attempted — guessing at a fix in someone else's package is worse than leaving it flagged.

---

### 🟢 The e2e package is real now — and it paid for itself on the first run

`@mimi/e2e` had been a stub since Wave 1: a `package.json`, an empty `tests/`
holding only `.gitkeep`, and no Playwright config at all. It now has **24 specs**
across four files — session recovery, the hub, the dispatcher, the driver —
covering the flows this session built and the incident it opened with.

Deliberate choices worth knowing before extending it:

- **No `webServer`.** The suite runs against an already-running instance
  (`E2E_BASE_URL`, default `localhost:3000`). Booting Postgres + Redis + MinIO +
  backend + frontend from a test runner would duplicate `docker-compose.yml`
  badly and hide which layer broke.
- **No retries, serial, one worker.** A retry converts a real intermittent
  defect into a green run, which is precisely how CI sat red for eleven commits
  without anyone reading it. Serial because every spec logs in through the real
  UI against ONE shared database.
- **Not in `pnpm test`.** The unit/integration suites must stay runnable with
  nothing served; a browser suite that "passes" because the app was down is
  worse than no suite. Run it with `pnpm e2e`.

**It found a credential leak on its very first run.** The suite clicks Submit as
soon as the field accepts text — what a real user does on a slow phone — and the
browser navigated to `/login?username=driver1&password=password123`.
`<form onSubmit>` only prevents the default submission once React has HYDRATED;
before that, a click (or Enter) performs the browser's own GET, writing the
password into the URL bar, history, the next request's Referer and the server
access log. Worst on cheap phones on weak connections — the driver's device.
Fixed with two independent guards (`method="post"`, plus the submit disabled
until hydrated) and a regression test asserting both.

> **Class of bug worth remembering:** anything interactive that is
> server-rendered does nothing at all before hydration — silently. The login
> form submitted natively; a Surat Jalan row's click handler simply wasn't
> there yet. Only the login form has an explicit guard; elsewhere the app just
> ignores the first click.

**Three of the suite's early failures were the suite's own bugs**, recorded
because each is a trap worth not repeating: filling login fields BEFORE
hydration (controlled inputs discard the text and post an empty username);
filling two of set-pin's THREE fields, leaving confirm empty so validation
failed and the page never navigated; and evaluating a skip condition before the
async content loaded — a skip reading "not applicable" when the truth was "I
looked too early" is worse than a failure, because reports show it as fine.

### 🔴 Seed dates were UTC, so drivers saw nothing for 8 hours a day — **FIXED**

The e2e suite passed all evening and then skipped every driver test at 00:06
WITA. Not flakiness — it had walked into a real defect:

```
host UTC : 2026-08-18 16:06   <- what the seed wrote
host WITA: 2026-08-19 00:06   <- what the driver's app asks for
```

`isoDate()` was `toISOString().slice(0, 10)` — the UTC calendar day. Every
surface asks the server for "today" in the business timezone (the driver screen
fetches `my-jobs?date=<local today>`), so between 00:00 and 08:00 WITA the two
disagreed: the seed stamped yesterday onto "today's" Surat Jalan and the
driver's phone read "Tidak ada Surat Jalan untuk hari ini" against a freshly
seeded database. It also silently defeated the roll-forward added earlier that
day, which used the same helper.

Both seed files now derive calendar dates from `@mimi/shared`'s
`businessDateOf`. **This is the third DATE/WITA defect in this tracker** (§1c
has two more) and the first found by a test rather than by someone noticing a
wrong number on screen.

Its own fallout, also fixed: importing `@mimi/shared` meant the seed needed the
workspace BUILT, which CI's "Migrations + seed" job and the VPS's bare
`node:22-alpine` container did not do. `db:seed`/`db:reset` now build the
package first — fixed in the root script rather than in `ci.yml`, so every
caller is covered instead of one workflow file knowing a secret the others
don't.

---

## 1d. Running system — verified in a real browser

**The app runs end to end.** Backend `:4000` (39 modules, 339 routes), frontend `:3100`. Logged in as `owner` via Playwright and captured every surface.

**What works, seen on screen:** branded shell with the full Indonesian IA (Operasional / Logistik & Gudang / Keuangan / SDM / Sistem), the **two-state connectivity indicator live in the header** (Offline · Tersinkron · Coba Sinkron), and `admin` rendering **real backend data** — actual users, roles and outlets across all four cities, with working search, filters and sort.

**Why it looked unbuilt:** `/dashboard` — where every Owner lands after login — still rendered the Wave-1 placeholder reading _"Dibangun oleh W5-01 pada Wave 5."_ Every other surface was real; the first screen anyone sees was the one that wasn't.

**Two environment traps found while getting it up:**

- The frontend reads `NEXT_PUBLIC_API_URL`; starting it with the wrong var name silently falls back to `/api` on its own origin, so **login 404s with no useful error**. Documented in `.env.example` but easy to get wrong.
- Login inputs carry **no `name` attribute** (React-generated ids only) — breaks password managers, autofill, and any selector-based automation.

## 2. ACTIVE BLOCKERS

### 🔄 WhatsApp chat (W7) — BUILT 2026-08-20, DELIVERY UNPROVEN

The last item of the owner's 2026-08-20 request. Built end to end except the one part that cannot be built: proof that a message reaches a phone. `WA_ENABLED=false` and there are no gateway credentials (RISK-P4), so **delivery remains untested and must be exercised in staging against a real n8n workflow before anyone relies on it.**

**Delivery is borrowed, not rebuilt.** `WhatsAppChannelService` already existed for one-way templated notifications: it owns the n8n webhook, records every attempt in `notification_outbox`, and no-ops when `WA_ENABLED=false`. Chat sends through it rather than talking to the gateway itself, so there is exactly one answer to "did it actually go". What chat adds is the shape a notification log cannot express: a thread, a reply, and who said what.

- Migration `225` — `chat_conversations` (UNIQUE on `contact_phone`: a phone number IS the conversation) + `chat_messages` (UNIQUE `external_id` for webhook idempotency). Denormalised `last_message_at`/`unread_count` because ordering an inbox by newest message via a correlated subquery is the obvious way to make it slow. RLS: central sees all, a scoped role sees its locations PLUS unclassified threads (an inbound stranger has no location, and hiding it from everyone but head office means nobody answers), and a user always sees their own.
- Migration `226` — `chat.read.own` to every role; `chat.read`/`chat.send`/`chat.manage` to head office and managers only. A kasir must not be able to read a supplier negotiation.
- Admin inbox (`/chat`) and the staff thread (`/me/chat`). The staff endpoint takes NO conversation id — the server resolves it from the session, because accepting one would let any authenticated user post into somebody else's thread, the same class of hole as B-15.
- **The UI never claims a message was delivered.** While WA is off, every outbound message is `pending` and rendered as such. 5 frontend tests exist for exactly this, because the failure mode of shipping a chat feature blind is a sent tick that lies.

**A real defect this surfaced, now fixed:** `rbac-endpoint-sweep.spec.ts` exempted `@Public` routes from BOTH of its assertions, so a public WRITE — the most dangerous shape there is — passed with nobody recording why it was safe. Added a third assertion requiring every public mutating route to be justified. It immediately found **six** pre-existing ones nobody had recorded: device register/heartbeat, node register, and sync hello/bootstrap/push. All were verified as genuinely authenticated (pairing tokens, `DeviceTokenGuard`, `DeviceAuthGuard`) and are now documented rather than invisible.

Verified: 847 backend + 464 frontend tests pass, lint and format clean. **Not verified: that WhatsApp delivery works at all.**

### ✅ Supplier management UI — DONE 2026-08-20

Reported as "pembelian has no features: add supplier and its items and prices, categories, supplier lists, items lists". Split into what was actually missing:

- **Items, categories, units, products, locations** — ALREADY EXIST, under **Admin → Master Data** (`MasterDataPanel`, four tabs). Nothing built; the ask was already met, just not where the owner looked.
- **Suppliers** — genuinely missing. The backend was complete all along (`suppliers` CRUD, `supplier_items`, `supplier_price_history`, transactions, and the D-20 outlet-visible projection) with **no UI whatsoever**.

Built as a fourth tab in Pembelian rather than under Master Data, because it is worked on by the person raising POs, beside the PR/PO tabs they already have open:

- `SuppliersPanel` — searchable list (debounced), create/edit/deactivate.
- `SupplierFormModal` — `code` is locked on edit, since it is printed on POs already issued and changing it would silently re-label historical documents. Empty text fields are sent as `null`, not `''`.
- `SupplierDetailDrawer` — items with inline price editing, price history, PO history. Save appears only when a price actually changed, because every changed price appends a permanent history row.

**The permission split is mirrored from the server, not approximated:** `supplier.read` lists, `supplier.price.read` reveals items and history, `supplier.price.manage` allows editing, `supplier.manage` allows create/deactivate. Outlet roles hold none and get a stripped name/contact directory from a different endpoint. 5 tests cover exactly this split — showing a control the server will 403 is what caused the original "no features" report.

`outletVisible` gets a written explanation in the form rather than a bare switch: it exposes the supplier's NAME and CONTACT to outlet supervisors for petty-cash forms, while price, terms and bank details stay stripped for those roles either way.

One bug caught by reading the server instead of trusting the shape: the transactions endpoint returns `total`/`paymentStatus`, not the `totalAmount` first assumed.

459 frontend tests pass, lint and format clean.

### 🔄 Driver interface upgrade (owner request 2026-08-20) — 5 of 6 done

Asked for "Google Maps like the laundry driver". Worth recording what that turned out to mean: **laundry has no embedded map at all** — it deep-links to `google.com/maps/search/?api=1&query=<address>`. Mimi already deep-linked to Google Maps AND did it better (coordinates rather than a text address, plus a Waze option). So the real gap was not the deep link; it was that a driver could not SEE the route. Built on Leaflet + OSM (owner confirmed), matching the dispatcher's existing `LiveTruckMap` — no API key, no billing account, no per-request cost, so the panel cannot become an outage when a card expires.

- **`DriverRouteMap`** — every stop as a numbered pin in `dropSeq` order, next stop ringed, finished stops greyed, straight dashed connector. The connector is straight ON PURPOSE: it shows the SEQUENCE, and drawing a convincing road path we never actually routed would be a lie a driver might follow. Stops without coordinates are counted in a line under the map rather than silently omitted.
- **Route progress + next-stop focus** — `lib/route-progress.ts` derives "where am I up to" once, so the header count, the highlighted pin and the expanded card cannot disagree. Finished stops collapse. 6 unit tests, incl. that an EMPTY route is not a "complete" one (that would send a driver home mid-shift) and that a failed stop is finished-for-sequencing but never counted as delivered.
- **Offline job cache** — `lib/job-cache.ts` + a new `driver_jobs` IndexedDB store (`DB_VERSION` 1→2; the upgrade path was already additive). Previously the route lived only in React state and `DriverJobsPanel`'s own comment admitted a hard reload with no signal lost the day. A separate store, NOT `master_data`, because the reconciler wipes that wholesale — precisely the wrong moment for a driver in a dead zone. Read-fallback only: the outbox stays the authority for actions taken. Stale data is shown but LABELLED with its age, never passed off as live. 5 tests.
- **Call the destination** — `locations.phone` existed on every outlet and was simply never selected, the same gap `address`/`latitude` had. Now on the drop, with a one-tap `tel:` on open stops only.
- **Day summary** — shown when no stop is left open. Deliberately NOT a "finish run" button: the SJ already completes server-side from its drops, and a second driver-pressed notion of done would create two sources of truth that disagree the moment someone forgets to press it. Failures, discrepancies and cold-chain breaches get equal billing to successes.
- **NOT DONE: WhatsApp chat (client + admin).** Still owed. `WA_ENABLED=false` and there are no WA credentials, so it can be built but not proven end to end.

Verified: 454 frontend + 837 backend tests pass, lint and format clean.

### ✅ RESOLVED 2026-08-20 — "purchasing and dispatcher have no features": owner could not see the buttons

Reported as missing functionality: no way to add a PO, and no surat-jalan creation or route control on the dispatcher screen. **Nothing was missing.** `CreateSuratJalanModal`, `SuratJalanDetailDrawer` (which hosts `RoutePlanner` — stop reordering and per-stop instructions) and `PurchaseOrdersPanel`'s `CreateOrderModal` were all built, wired and reachable.

They were invisible because they render behind a `PermissionGate`, and **owner was `false`** on `delivery.sj.create`, `delivery.sj.dispatch`, `delivery.sj.cancel`, `delivery.receive`, `purchasing.pr.create`, `purchasing.po.create`, `purchasing.po.receive` and `purchasing.po.close`. Migration 222 had granted owner five create rights under the standing "owner does everything" decision and simply missed these eight. Fixed in `rbac.ts` + migration `224`.

**This is the third time this exact failure mode has cost a session** (the driver menu, the notification bell, now this): a feature is built, and the only account the owner actually uses cannot see it. The lesson is not "grant more permissions" — it is that a feature is not done until it is verified as reachable BY THE ROLE THAT USES IT. `e2e:role-journeys.spec.ts` asserts what each role sees, and it did not cover these two create paths.

Owner still lacks 22 keys (payroll run/approve, `accounting.journal.post`, `payment.verify`, POS shift/sale, etc.). Those are deliberately left alone — they are the segregation-of-duties boundary, and unlike the eight above nobody has reported being blocked by them. Say the word if owner should hold everything.

### ✅ RESOLVED 2026-08-20 — the live-DB suite corrupted its own database (G1 invariant drift)

Long-standing and previously recorded as "root cause open": running the backend suite left `stock_balances` disagreeing with `fold(stock_movements)`, so `stock-ledger.integration.spec.ts` failed on the NEXT run with the invariant already broken "before this suite touches anything", and other suites failed with `StockInsufficientError` from drained stock.

Root cause was in `stock-opname-gl-posting.spec.ts`'s cleanup, and it was two bugs: it deleted the `stock_movements` it had created but never the `stock_balances` row they moved, and its `DELETE FROM stock_movements WHERE ref_type = 'test_seed'` was **unscoped**, wiping the seed movements of every other key — including those of specs running concurrently — and stranding their balances.

Both scoped/fixed. Verified by reseeding and then running the full suite TWICE with no reseed between: 837 passed both times, drift 0. Previously the second run failed.

### ✅ B-16 RESOLVED 2026-08-20 — the general ledger was structurally incomplete: 13 of 25 posting rules were never triggered. **All 12 that should fire automatically now do; the 13th is manual by design**

**Opened:** 2026-08-19 · **Found by:** W6-04 · **Partially fixed 2026-08-19** · **Verified independently before recording**

**Count correction:** the original report said "13 of 23", which cannot both be true — the enums hold 16 `JournalEventType` + 9 `JournalSystemEventType` = **25**, of which 12 are emitted and **13 were dead**. The list of 13 was right; the 23 was not. Recorded because the wrong denominator was briefly copied into this file.

`packages/shared/src/gl/posting-rules.ts` defines 23 journal event types and `accounting.integration.spec.ts` proves the posting ENGINE balances for all 23. It proves it by hand-constructing each event and calling `postForEvent` directly — which is why nobody noticed that **most of those events are never published by production code**.

Grepping every `journal.action` publish site outside specs left five files: `delivery/services/drop.service.ts`, `delivery/services/surat-jalan.service.ts`, `payroll/runs/runs.service.ts`, `pos/services/pos-void-refund.service.ts`, and the accounting module's own services. That is 12 event types emitted; the other 13 were defined, tested in isolation, and dead.

**The worst two are now FIXED: `outlet_sales` (JOUT-03) and `outlet_ingredient_usage` (JOUT-02) — POS revenue and COGS.**

CONTRACTS §6.2 defines both as a "daily aggregate of applied `sales.completed`", and the posting engine's own comment says its caller is a daily aggregator. No aggregator existed, and the backend has no scheduler at all, so neither ever fired. `accounting/daily-posting.service.ts` is that missing caller:

- Aggregating a finished DAY, rather than emitting per sale, is deliberate and is what the contract asks for: a sale is created offline, synced late, and may be voided afterwards, so a per-sale emit would post revenue on the wrong calendar day or post revenue that later reverses.
- **The cash leg is net of change given.** `Σ payments` exceeds `Σ total` by exactly the change handed back, so the obvious "sum payments by method" would post a permanently unbalanced entry. There is an explicit guard that refuses to post rather than write an unbalanced day, and a test that hands over 100k for a 75k sale to prove it.
- `ref_id` is a UUIDv5 derived from (location, business date), not generated — that is what makes a re-run a no-op against the journal's `UNIQUE (event_type, ref_type, ref_id)` instead of double-posting revenue.
- `occurredAt` is built as `<date>T23:59:59+08:00` so `entryDate = occurredAt.slice(0,10)` lands on the WITA business day — the same UTC-vs-WITA trap the seed already fell into once.
- `daily-posting.scheduler.ts` re-attempts YESTERDAY every 30 minutes (`OnApplicationBootstrap` + `setInterval`, the house pattern — this workspace has no `@nestjs/schedule`). Short interval + idempotent work is chosen over a real 01:00 cron on purpose: a once-a-day cron silently loses the day if the process is restarting at 01:00, whereas this self-heals after any outage. It never posts TODAY, because a partial day posted now would become permanent.
- `POST /api/accounting/daily-posting` (`accounting.journal.post`) backfills a named day by hand.

`daily-posting.spec.ts` (4 tests, live DB) proves a cash sale reaches Dr 1000 / Cr 4000, that a split-payment day with change still balances, that a re-run does not double-post, and that a day with no trading posts nothing.

**Seven more wired 2026-08-20** (event-triggered, not daily aggregates — each fires at a lifecycle point): `outlet_waste`/`gudang_waste` (waste approved), `outlet_return_to_warehouse`/`gudang_return_to_supplier` (return shipped), `outlet_stock_adjustment`/`gudang_stock_adjustment` (opname approved), `gudang_purchase` (PO approved). Each derives its amount from the SAME `qty × unit_cost` as the stock movement it accompanies rather than re-deriving it, uses the real document id as `documentId` so a replayed approval cannot double-post, and stamps `occurredAt` through a shared `common/wita-occurred-at.util.ts` so `entryDate` lands on the WITA business day. Outlet-vs-gudang is resolved from `locations.type`, never from a name convention.

Two correctness details worth keeping: the engine's two adjustment rules are ASYMMETRIC — `outlet_stock_adjustment` branches on `direction === 'overage'` while `gudang_stock_adjustment` branches on `direction === 'shortage'`, so the wrong string silently swaps the accounts instead of failing. Both are fed from one typed `'shortage' | 'overage'` value that also chooses the movement type, so the ledger and the journal cannot disagree. Outlet shortages post `attributable: false` (Dr 6400 expense, not Dr 1210 employee receivable) because attributability is a payroll decision made later.

**The last three wired 2026-08-20**, and reading the contract first mattered more than the code did:

- **`gudang_goods_in` (JGUD-02) is NOT a PO receipt.** The obvious reading of the name is wrong; CONTRACTS §6.2 says the trigger is `returns.received_at_warehouse`, the outlet→gudang leg, and the accounts confirm it (Dr 1100 / Cr **1120 Dalam Perjalanan**, not Cr 2000). It is the CLEARING half of `OUTLET_RETURN_TO_WAREHOUSE` (Dr 1120 / Cr 1110) posted at ship. Without it, 1120 accumulated every returned rupiah forever and never cleared. Wired at `returns.receive`.
- **`outlet_direct_purchase` (JOUT-07) and `outlet_petty_cash` (JOUT-08) are the same document split in two.** One petty-cash slip can be both — a supervisor buys onions and pays the parking attendant on one trip. The stockable lines became inventory (Dr 1110), the rest was spent (Dr 6100), so a verify emits both, split by the _same_ `isStockableLine` predicate the stock loop uses. Extracted to one type-guard so the two halves cannot drift apart and describe different purchases. Context is `source: 'petty_cash'`, deliberately not `po_receipt`: this was paid from the cash float, so the credit is 1010 Kas Kecil, and the wrong context would silently book a payable nobody owes. No `expenseAccountCode` is passed — category→account mapping is a documented future refinement and the engine already defaults to 6100.

**`gudang_stock_revaluation` (JGUD-07) is deliberately NOT wired, and that is the correct end state.** Appendix A-8: it is "a valuation statement, not an event", served primarily by `GET /api/accounting/stock-value`, with the rule kept for a manual FIN entry — and "moving-average cost updates from PO receipts do NOT auto-post revaluation entries in v1". Inventing a trigger would have contradicted the contract. Counting it as an open gap was my error, corrected here.

**Proven by execution, not by grep.** Two specs drive the real services and then assert the GL is empty: `waste-gl-posting.spec.ts` files and approves a cold-chain-breach waste report — the `waste_out` stock movement posts, and `journal_entries` has zero rows for it; `pos-online-order-gl-posting.spec.ts` does the same for a completed GoFood order. Both pin the CURRENT broken behaviour deliberately, so they go red the moment the wiring is fixed. That is the intended signal, not a passing grade.

**Impact now:** every event type that should post automatically does. The remaining exposure is not the wiring but the HISTORY: days traded before 2026-08-19 have no `outlet_sales`/`outlet_ingredient_usage` entries, and the pre-existing documents (waste, returns, opname, POs, petty cash) approved before their wiring landed were never posted either. `POST /api/accounting/daily-posting` backfills the sales side per day; **the document-side events have no backfill and would need one written**. Nothing has been backfilled yet, and doing so on production is an owner decision, not a cleanup task.

Verified: reseed, then the full backend suite run TWICE with no reseed between — 837 pass both times.

**Remaining work.** Each of the 11 needs its amount, context and idempotency key derived correctly at the right lifecycle point, following the `drop.service.ts` pattern. That is design work on money, not a mechanical wiring pass.

### ✅ B-15 RESOLVED 2026-08-22 — the PIN oracle was **deleted**, not rate-limited

**Opened:** 2026-08-19 (found by the W6-03 endpoint sweep) · **Closed:** 2026-08-22, on ten owner decisions

`POST /auth/pin/verify` took an **arbitrary `userId`**, never read `req.user`, ran under
`withSystemContext` (bypassing RLS), and returned whether a submitted 6-digit PIN was correct — no rate
limit, no lockout, no audit row. Any authenticated caller could brute-force any other account's PIN, and
because `offline_credentials.pin_verifier` is minted from the same `users.pin_hash`, what leaked was not a
session token but the credential that approves voids and discounts on an offline tablet.

**The decision that mattered was Q8: remove the standing secret rather than guard it.** A limiter bolted
onto that endpoint would still have left a static, reusable value behind an imperfect gate. Instead the
approval credential is now generated at approval time, single-use, and destroyed on use — there is nothing
left for repeated guessing to extract.

**The flow now** (one path, not two — owner Q0=C):

1. The kasir requests a void. Eligible approvers are notified (unchanged).
2. The approver authorises **from their own session, anywhere** — `POST /api/approvals/void_refund/:id/code`
   — and receives a six-digit one-time code. Being able to do this off-site is the point of Q2: shifts get
   swapped and people call in sick, and previously the supervisor had to physically log in at the register
   (which is exactly why the unlimited PIN endpoint existed as the workaround).
3. The kasir types the code at the till. `POST /api/pos/void-refunds/:id/approve` now takes `{code}`, is
   gated on `pos.void.request`, and records the decision against **the approver**, never the redeemer.

**What each owner decision became, in code:**

| Q    | Decision                                       | Where it lives                                                                                                                                                                         |
| ---- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q0=C | One PIN path, not two                          | `AuthService.verifyPin` **deleted**; `PosVoidRefundService.approve`'s private `verifyPin` deleted; the void flow redeems a code                                                        |
| Q1   | Scope to real approvers                        | `ApprovalCodeService.issue` refuses unless `resolveEligibleRoles`/`isRoleAuthorized` (the §5.2 state machine, not a second copy) names the caller for **this document's current step** |
| Q2   | Gate the caller by role, not identity          | Redeem is `pos.void.request` — any cashier on that branch, deliberately, so a swapped shift is not a dead end                                                                          |
| Q3   | Deterministic binding                          | A code carries `document_type` + `document_id` + `redeemable_by_user_id`; it cannot be minted speculatively, replayed onto another sale, or spent by a bystander who overheard it      |
| Q4   | Lock the **caller**, never the approver        | `AuthLockoutService` keys on the redeemer. The approver whose code is being guessed is never touched — a test asserts exactly that                                                     |
| Q5   | 5 attempts / 15 min, backoff, reset on success | Attempts 1–2 free, 30 s at 3, 2 min at 4, hard lock at 5; window measured from `window_started_at` so one-guess-every-15-minutes still accumulates                                     |
| Q6   | Unlock requires higher authority               | `POST /api/auth/lockouts/:userId/clear`, with a **strict** `ROLE_RANK` comparison — a supervisor frees a kasir, never a peer, so two cashiers cannot take turns                        |
| Q7   | Offline needs its own recovery                 | **NOT DONE — opened as B-17.** Offline still uses the cached `pin_verifier`; no server exists there to mint a code. This is the honest remaining gap                                   |
| Q8   | Generated at request time, one-time            | `approval_codes` (migration 230): argon2id-hashed, 5-minute TTL, one live code per document (partial unique index), `consumed`/`superseded`/`expired` states                           |
| Q9   | Notify + email + audit                         | `approval_code_issued` (in-app/email/WhatsApp, to the approver) and `auth_lockout` (in-app/email, to whoever can clear it plus the locked user); `@Audited` on issue and on clear      |
| Q10  | Go-live blocker                                | Shipped in this pass                                                                                                                                                                   |

**Three design points worth keeping:**

- **The failure counter commits on its own connection.** A wrong code throws, and a thrown request is
  rolled back — by the route and unconditionally by `RlsCleanupInterceptor`. Had the counter ridden on the
  caller's transaction it would have been erased with the rejection and counted to one forever while an
  attacker guessed all day. Same class as "THE BIG ONE", except here the silent rollback would have been a
  security control doing nothing. `recordSuccess` deliberately does NOT commit separately: a success only
  counts if the transaction it authorised commits too.
- **"No code issued" is not a failed attempt.** Otherwise anyone could lock a till out of service by
  hammering a document nobody had authorised yet — the denial-of-service mirror image of the mistake Q4
  avoids by locking the caller instead of the approver.
- **Wrong code, wrong document and wrong redeemer all return the same error.** Distinguishing them for the
  caller is precisely the oracle this work removed.

**Its own sweep entry is gone, not reworded.** `rbac-endpoint-sweep.spec.ts` carried
`'AuthController.verifyPin': 'KNOWN GAP — see B-15; allowlisted, not accepted'`. The route no longer
exists, so the entry was deleted — an allowlist that keeps entries for deleted routes stops being a list of
accepted risks. The sweep then immediately caught the ONE new unguarded route this work added
(`GET /auth/lockouts/me`, a self-only read), which is the system working.

**Verified:** 8 new live-DB tests in `kernel/approvals/approval-code.integration.spec.ts` (issue, role
refusal, supersede, wrong redeemer, expiry, the lockout ladder, rank-gated unlock, locked-before-read), the
POS void suite rewritten onto the code flow (5 tests, including "the decision is recorded against the
SUPERVISOR" and single-use replay), 11 frontend tests across the two new surfaces, and the auth suite's old
oracle tests replaced by their inverse. Backend 862 pass, frontend 476 pass, lint and format clean.

**One harness defect this surfaced and fixed:** a committed lockout row outlives `withRollback` — by
design — so the POS suites hard-locked the seeded kasir and poisoned every later run. Both now call a new
`clearAuthLockouts()` in `beforeAll`/`afterAll`. This is the same family as the QA-ISOLATION drift already
recorded, and the first case where the state that leaks is deliberate rather than accidental.

### ✅ B-17 RESOLVED 2026-08-22 — an outlet with no internet can now recover a locked credential

**Opened:** 2026-08-22 (owner Q7, the offline half of B-15) · **Closed:** same day

B-15 closed the ONLINE oracle. Offline was structurally different: a tablet holds
`offline_credentials.pin_verifier` locally, so guessing happens where no server can see it, and no server
exists in that state to mint a one-time code. The owner's direction was to accept the residual local risk —
the attacker must physically hold the tablet — and build a way BACK instead.

**Something was already there, and the blocker mis-stated it when opened.** The device-side attempt counter
existed: `authorizeOffline` counted failures and set `lockedOut` at `PIN_MAX_ATTEMPTS`. What was missing was
recovery, and the lock was the wrong SHAPE for an offline device — five strikes went straight to terminal,
with no way back until connectivity returned.

**Part 1 — the soft cooldown.** `authorizeOffline` now climbs the same ladder the owner accepted for online
in Q5: attempts 1–2 free, 30 s at 3, 2 min at 4, terminal only at 5.

- Deliberately the same numbers as `kernel/auth-lockout/auth-lockout.service.ts`. A supervisor should not
  have to learn two rules depending on whether the outlet happens to have internet.
- `cooling_down` is a DISTINCT outcome from `locked_out` and carries `retryAfterSeconds`. One means "wait
  30 seconds", the other "this credential is dead until the device is online" — and the POS modal shows the
  actual number, because "try again shortly" is the kind of message that gets tapped repeatedly.
- Checked BEFORE the PIN is verified: same ordering rule as the server, and it also stops a cooling-down
  caller running argon2id at m=64MiB and hanging the tablet.
- **This alone recovers the overwhelmingly common case with no human process at all**, which is the only
  kind of recovery a device in a dead zone can have.

**Part 2 — the phone channel for a terminal lock.** The tablet mints a 6-digit challenge the moment it locks
the credential, the supervisor reads it to head office, head office calls
`POST /api/auth/offline-credential/:credentialId/unlock-code`, and the 8-character answer is read back and
verified on the device against the binding secret it already holds. No connectivity on the device at any
point — the phone is the channel, which is the one an isolated outlet still has.

- **The derivation is defined ONCE**, in `@mimi/shared` (`unlockCodeMessage` / `encodeUnlockCode`), because
  the last two-tier HMAC in this codebase was defined twice, agreed in prose and disagreed in bytes (`'|'`
  vs `'‖'`) and failed every offline approval silently. Both tiers assert against the same known-answer
  fixture, and the device test computes its expected value with `node:crypto` the way the SERVER does rather
  than by calling its own helper — a test where the device checks its own arithmetic would prove nothing.
- 8 characters from Crockford base32 minus I/L/O/U (≈40 bits), taken 5 bits at a time off the digest rather
  than `% 32`, which would bias toward the low end of the alphabet and shrink the space the length is chosen
  to provide. Case, spaces and hyphens are forgiven, and O→0 / I→1 / U→V, because this arrives by voice.
- Bound to `unlock‖v1‖credentialId‖challenge`, so a code is inert against another credential, another lock,
  or a replay after the device has moved on. Three wrong codes and the credential waits for the device to
  come back online — a terminal state that is honest rather than infinite.
- Unlocking resets `failedAttempts` too, not just the flag. Leaving it at 5 would send the credential
  straight back into a terminal lock on the next mistyped digit, which is not what "unlocked" means to
  someone who just spent a phone call getting there.

**The RLS decision, and why no new migration was needed.** `offline_credentials` is `app_is_self(user_id)`
with no central arm, so head office cannot read the row it needs. The owner chose the narrow option — a
`SECURITY DEFINER` function returning only what is required, never `pin_verifier` — over widening the
policy, which would have handed every central role a crackable argon2id hash of every user's PIN and been a
step back toward B-15. **That function already existed:** migration 206
(`app_offline_credential_for_verification`) was written by W1-C for §7.4 re-verification, makes exactly this
argument in its own header, excludes exactly that column — and had **no callers**. A migration was drafted
and then deleted once that turned up. This feature is its first consumer.

**Two real defects found by the tests, both fixed:**

- A supervisor unlocking a KASIR — the primary case — failed with "credential owner not found". The owner's
  role was being read on the caller's own client, and `users_select` is central-or-self, so a supervisor
  reading a kasir's row got zero rows. Now resolved through a system context; the rank check itself is
  unchanged and still decides the outcome.
- The existing "locks out after 5 failed attempts" test passed only because nothing paced the attempts. It
  now advances a clock past each cooldown — which is also the assertion that would catch the ladder silently
  CAPPING the counter at 3 instead of merely pacing it.

**Verified:** 7 shared derivation tests, 9 device tests (including the cross-tier one), 7 live-DB server
tests (including that a plain `SELECT` returns zero rows where the definer function returns one, and that
the function still cannot return `pin_verifier`), 4 offline-ladder tests, plus a POS modal guard. Frontend
**489 pass**. Lint and format clean.

**What remains offline, stated plainly:** someone holding the tablet can still grind the cached
`pin_verifier` outside the app entirely — no client-side control can prevent that, and the owner accepted it
on the grounds that physical possession is required. The cooldown and the attempt cap raise the cost inside
the app; the 24-hour credential TTL bounds the window.

### 🟠 Two pre-existing `waste-return` failures, root cause identified 2026-08-22

Surfaced while re-running the full backend suite for B-15. **Not caused by that work** — the B-15 diff
contains no stock code, and the 14 suites it does touch pass 133/133 — but worth recording because the
mechanism is now pinned down rather than filed under "the live-DB suites drain stock".

The count also grows with each full run on an unreseeded database (2 failures, then 4, across three runs
today, spreading into `accounting` and `inventory/low-stock`), which is the same drain compounding. A
reseed is the documented remedy and has not been run here — the local database is the owner's.

`waste-return`'s `test-support/live-db.ts` has two helpers that contradict each other:

- `ensureStock()` writes `stock_balances` **directly**, with no matching `stock_movements` row. Its own
  comment already admits this knowingly breaks D-07's "never write `stock_balances` directly" rule as a
  test bootstrap.
- `reconcileStockBalance()` then recomputes that balance as **the fold of the movements** — which is zero
  for a key whose stock only ever existed as a hand-written balance.

So `afterAll` reconciles away the very stock `beforeAll` created, and the next run starts from a warehouse
key with no stock and no movements. Verified directly: `SELECT` on the failing key returns **0 balance rows
and 0 movement rows**. Both tests then die on `StockInsufficientError`.

The fix is for `ensureStock` to post a real movement rather than a bare balance, so the bootstrap and the
invariant agree. Not done here — it is another module's harness and outside the B-15 scope.

### 🚀 Verified on the server and deployed — 2026-08-23

**New standing rule (owner, 2026-08-23): test and set up on the SERVER, never locally.** The server is
Linux and the dev box is Windows; verifying on Windows and discovering the difference at deploy time is
the failure this rule exists to stop. Everything below ran on the VPS.

**How it was verified without touching the owner's demo box:**

- The branch was checked out into a SEPARATE git worktree (`/home/ubuntu/mimi-test`), so the live deploy
  at `/home/ubuntu/mimi` stayed on `main` throughout.
- A THROWAWAY Postgres (`mimi-testpg`) was started on the stack's own docker network and migrated + seeded
  from scratch. The suites commit real rows and drain stock; pointing them at the live demo database would
  have corrupted the data the owner actually uses.
- Tests ran inside a `node:22-alpine` container mounted on the worktree. Nothing was installed on a host
  that carries seven unrelated compose projects — it has no Node at all, and it still doesn't.
- The production images were built under a separate compose project name (`mimitest`) BEFORE merging, so
  a build failure could not take the live stack down. Both built.

**Results, all on Linux:** 114 migrations apply clean on an empty database · seed clean · backend
**895/895** (97 files) · frontend **515/515** (82 files) · shared **257** · sync-protocol **141** ·
branch-node **18** · lint 0 errors · format clean.

Then merged to `main`. `deploy-vps` green, CI green.

**Confirmed against PRODUCTION after the deploy, not inferred:**

| Check                                       | Result                                                                                                                                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Migrations 232 + 233 applied                | present in `schema_migrations` on the live database                                                                                                                                            |
| `approval_codes`, `auth_lockouts`           | both tables exist                                                                                                                                                                              |
| `approval.code.issue`, `auth.lockout.clear` | both permission keys seeded                                                                                                                                                                    |
| **`POST /api/auth/pin/verify`**             | **404 — the oracle is genuinely gone from the running system**, not merely deleted from the repo                                                                                               |
| `GET /api/auth/lockouts/me`                 | 200 `{"locked":false,"hardLocked":false,"lockedUntil":null}`                                                                                                                                   |
| xlsx export (was 501)                       | 200, correct OOXML content-type, 48 KB, magic bytes `PK`                                                                                                                                       |
| that workbook, opened by Python             | CRC-valid, every part parses, **1,241 rows of real production data**, decimals intact (`1.200`, `15803.00` — trailing zeros preserved, which is the whole point of the inline-string decision) |

**The smoke job earned itself on its first run.** It failed — and the failure was real, not the job
misbehaving: 15 of 16 specs passed and `hub.spec.ts`'s "kepala gudang still LANDS on the warehouse"
timed out, twice, on a warm box. The app was right and the TEST was stale: the seven-interface rework
made `app/page.tsx` redirect past the hub only for someone who can reach a single interface, and a kepala
gudang reaches three. The app's own header documents that rule. The assertion had shipped contradicting
the design it was written alongside, and nothing caught it because e2e ran only by hand — exactly the gap
B-9 closed. Corrected in `c8f18b1`; the following deploy ran green end to end.

**Server left clean:** test worktree removed, throwaway database and test images deleted, live stack
healthy on `c8f18b1`.

### ✅ Gap-closing pass — 2026-08-23

Six items off §1a's owed list, plus one verified as already resolved.

| Gap       | Outcome                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-13**  | CLOSED. Both halves of the deep link exist. Pinned from both ends: the backend now asserts the WHOLE path including the id (it asserted the prefix and the id separately, which a link that 404s would still satisfy), and a new frontend test asserts the ROUTE FILE exists — a filesystem check, because the failure mode is a folder rename that no amount of rendering would catch |
| **B-08**  | CLOSED. `test/audit-http.e2e.spec.ts` boots the real `AppModule`, binds a real socket, logs in, drives a real audited mutation and reads `audit_log` on a separate connection. No supertest — `app.listen(0)` + global `fetch` needs no new dependency. **It immediately found something**, below                                                                                      |
| **D-22b** | CLOSED. xlsx works on all 10 report endpoints via a dependency-free writer built on Node's `zlib`                                                                                                                                                                                                                                                                                      |
| **D-27**  | CLOSED. The recipe-explosion formula lives once in `@mimi/shared`; both call sites import it                                                                                                                                                                                                                                                                                           |
| **D-30**  | CLOSED. `outlet` and `warehouse` import `ApprovalDetail`/`ApprovalStepDetail` instead of re-declaring them                                                                                                                                                                                                                                                                             |
| **B-9**   | DONE, **needs one secret**. A post-deploy `e2e-smoke` job runs hub + session-recovery + print against the box just deployed. **It fails until `VPS_PUBLIC_URL` is set in repo secrets** — deliberately: defaulting to localhost would let it pass with nothing served                                                                                                                  |
| **B-11**  | NOT A GAP any more. Verified and pinned rather than "fixed", below                                                                                                                                                                                                                                                                                                                     |

**B-08's finding: audit writes are fire-and-forget.** `AuditInterceptor` writes with
`void this.writeAuditRow(...)` inside a `tap()`, after the response has gone out, with a `.catch()` that
only logs. So a client holding a 201 has no guarantee the row exists yet, and **if that write throws the
mutation still succeeds and the audit row is silently absent** — visible only as a server log line. The
first test written here passed by winning that race and the next one lost it, which is how it surfaced.
Deliberately not changed (failing a mutation because auditing failed would be worse), but now written
down, and the harness waits explicitly rather than sleeping so the property is documented, not folklore.

**B-11 was already resolved by construction.** `AppShell` returns `null` until `isHydrated`, so on every
non-public route there is no control on screen to click before hydration; `/login` is the only public
route and carries its own `hydrated` guard plus a `method="post"` fallback.
`AppShell.hydration.test.tsx` pins it, because the gap returns from two ordinary-looking refactors —
dropping the `!isHydrated` early return to remove a "flash of nothing", or adding a route with real
controls to `PUBLIC_ROUTES`. Neither would fail any other test.

**Two bugs I introduced and the tests caught, both the same shape — a detail that looked cosmetic:**

- The xlsx writer's control-character class was written with LITERAL control bytes and arrived as an
  INVERTED class (`[^…]`), which would have stripped every real character from every export while
  leaving the control bytes in. Rewritten with explicit `\u` escapes, with a comment on why literals are
  unacceptable in that position.
- The shared explosion helper tested `isZeroQty()` on the RATIO, which is carried at 6 decimal places
  while every `Qty` helper parses at 3 and throws above that. Four property tests went red at once. The
  zero check belongs on `qtySold`; the scale trap now has its own section in the module header and its
  own test.

**Not done, and why:**

- **B-2 (run the perf harness).** k6 is not installed here, and a 150-VU run on a dev laptop also hosting
  Docker, an IDE and a second agent session would measure local contention rather than the system.
  Recording that as "NFR-01 measured" would be worse than the honest `NONE` in `ACCEPTANCE.md`. Needs k6
  plus a representative target — an environment decision, not a code one.
- **B-12 (`attachment-store` flake).** Did not reproduce: 6 isolated and 8 full-suite runs clean today.
  One earlier full run had a single failure whose name was not captured before it passed on rerun, so it
  cannot even be attributed to this file. Left open rather than closed — and no fix attempted, because
  guessing at an unreproducible flake is how a real defect gets papered over.
- **B-3, B-5, B-6** stay blocked on the architect decision, the hardware order and HTTPS respectively.
- **W7-02 technical docs** untouched this pass.

### 🟠 W6-05 perf — the harness now provably RUNS; the 150-VU gate still has nowhere honest to run

**2026-08-23.** Two separate things were conflated under "the perf harness has never been run", and they
have different answers now.

**Done: the suite is no longer unexecuted code.** All eight k6 scripts — `smoke.js`, the NFR-01 gate, the
five per-endpoint scenarios and the sync-backlog script — were loaded by a real k6 (`grafana/k6:latest`,
`k6 inspect`) for the first time. Every one parses, resolves its imports and produces well-formed options;
the gate's five scenarios come back with the documented traffic split (90/30/15/10/5 VUs) and a
`p(95)<3000` threshold. Until now nobody knew whether a single line of it even compiled, and "a harness is
not a measurement" cut both ways — an unexecuted harness might not have been a harness at all.

**Not done, and not honestly doable on this host: the 150-VU gate itself.** Measured before attempting it:

| The shared VPS        | Value                                      |
| --------------------- | ------------------------------------------ |
| Cores                 | **4**                                      |
| 1-minute load average | **3.46** (before adding any load)          |
| Running containers    | **46**, across **8** unrelated projects    |
| Free memory           | ~0 GB free, ~8 GB available (cache-backed) |

Driving 150 VUs into that would measure CPU contention on a box that is already near saturation, not the
system under test — and it would degrade seven neighbouring projects while doing it. A number produced
that way would be worse than the honest `NONE` in `ACCEPTANCE.md`, because it would look like evidence.

The suite's own `perf/README.md` says the same thing from the other direction: **"only ever point this at a
LOCAL stack that is already running. Never at the shared VPS."** That constraint is respected here rather
than argued with.

**What NFR-01 actually needs:** a dedicated target — a box, or a window on this one with the neighbours
quiesced — plus someone watching. It is an environment decision, not a code task. `ACCEPTANCE.md` still
reads `NONE` for NFR-01 and should keep reading `NONE` until a real run exists.

### 🟡 B-14 update 2026-08-23 — CLOSED FOR TESTING on :8443, self-signed, nobody's ports touched

The blocker above framed the choice as "take `:80`/`:443` from `aire-nginx`, or wait for a domain". There
was a third option: **a high port.** A secure context is a property of the SCHEME, not the port number —
`https://150.109.15.108:8443` is exactly as secure-context as `https://example.com` as far as the browser's
feature gating is concerned.

**Live now, verified from off-box:**

```
https://150.109.15.108:8443/        200   TLS handshake 111ms
https://150.109.15.108:8443/manifest.json  200
http://150.109.15.108:8080/         200   (kept, unchanged)
subject=CN=150.109.15.108, O=Mimi Chicken OS, C=ID
X509v3 Subject Alternative Name: IP Address:150.109.15.108, DNS:localhost
```

**What this unblocks** — the three features that were dead, not broken: driver truck tracking (geolocation),
attendance selfie + GPS geofence from a phone (camera + geolocation), and PWA install on the outlet tablets
(service worker). All three need a secure context and nothing else. A tester accepts the certificate warning
once per device.

**What it does NOT do.** The certificate is self-signed, so every visitor sees a warning first. That is
fine for testing and unacceptable for a public production address. A real certificate still needs `:80` or
`:443` — Let's Encrypt's HTTP-01 challenge wants `:80`, TLS-ALPN-01 wants `:443`, and DNS-01 needs a DNS
API that sslip.io does not have. So the `aire-nginx` decision recorded above is still the gate for a
_trusted_ cert; it is no longer the gate for _testing the features_.

**How it is built** (`infrastructure/tls/nginx-tls.conf`, `tls` service in `docker-compose.vps.yml`):
nginx terminating TLS in front of `mimi-frontend:3000` — one container, because Next's rewrites already
carry `/api`, `/socket.io` and `/sync/v1` internally, which is the same insight the sslip.io attempt
reached. Carries the WebSocket upgrade headers (socket.io drives the topology tree and truck tracking) and
raises the body limit to 25 MB so a phone-camera selfie is not rejected by a proxy default. The key is
generated on the host at deploy time and never enters git.

**Two things went wrong on the way, both recorded at the code:** the container omitted `networks:` and so
landed on Compose's implicit `default` network, where `frontend` does not resolve — nginx resolves upstream
names at startup and exits, so nothing listened and the check read `000`. And the deploy's diagnostic
grepped `mimi-tls` before the overlay set that `container_name`, so the one log dump that would have
explained it printed nothing. `:8080` answered 200 throughout both failures, by design: the deploy treats
only the HTTP check as fatal, so a broken TLS config cannot take the box down.

### 🟠 B-14 side-note 2026-08-23 — the sslip.io + `:80`/`:443` attempt, and why the port really is held

**Superseded on the substance by the `:8443` note above, which is the better answer.** This attempt framed
the choice as "take `:80`/`:443`, or wait for a domain" and missed that a secure context is a property of
the SCHEME, not the port — so self-signed TLS on a high port unblocks the features today without needing
anyone's ports. Kept for the one durable finding it did produce, below.

The owner chose the sslip.io route (no registrar, no DNS work). It got as far as the question that still
governs a TRUSTED certificate: **who owns `:80`/`:443` on a shared box.**

**What checked out.** `150-109-15-108.sslip.io` and `api.150-109-15-108.sslip.io` both resolve to the box.
And the switch turns out to be much smaller than `docker-compose.prod.yml` implies: the frontend already
proxies `/api`, `/socket.io` and `/sync/v1` to the backend via `next.config` rewrites, so ONE hostname
pointed at `mimi-frontend:3000` serves the whole application over TLS. No `api.` subdomain, no relabelling,
no restart of the running stack.

The approach built for that was deliberately additive: a standalone Traefik on its own compose project,
attached to `mimi_mimi-network`, using a FILE provider (the docker provider would need labels on the
running containers, and labelling means recreating them). `:8080` would have kept working throughout, so a
failed certificate would have cost nothing.

**What blocked it.** `docker compose up` failed with `Bind for 0.0.0.0:80 failed: port is already
allocated` — and this is worth writing down, because the earlier reading in this file was wrong:

> `:80`/`:443` are genuinely free (aire's nginx is down)

They are not free. **`aire-nginx` is in a restart loop** (`Restarting (1)`, still, as PROGRESS has said
since 30 July), and a container that is restarting **keeps its host port reservation between attempts**.
So `ss -tln` shows nothing listening — which is what produced the earlier "free" conclusion — while
Docker's allocator still refuses the bind. Both observations are correct; only the inference was wrong.

**Why it stopped there.** Taking those ports means stopping `aire-nginx`: another project's service, on a
box that carries seven of them, unattended, at 03:00. Broken today is not the same as abandoned, and that
is not a call to make on someone else's behalf without asking.

Everything was removed cleanly — no Traefik container, no volume, no directory. `aire-nginx` was never
touched, the mimi stack is healthy, and `http://150.109.15.108:8080/login` still answers 200.

**What this still gates:** a TRUSTED certificate, and only that. Let's Encrypt needs `:80` (HTTP-01) or
`:443` (TLS-ALPN-01), and sslip.io offers no API for DNS-01. So the `aire-nginx` decision is the gate for
a browser-trusted cert — retire it and mimi takes the ports (the Traefik piece above is then perhaps twenty
minutes), or keep it and the two need a shared front proxy and a real domain. **Testing the
secure-context features is no longer blocked on any of that** — see the `:8443` note above.

### 🔴 B-14 — The demo box is HTTP-only, so geolocation and service workers are dead

**Opened:** 2026-08-18 · **Blocks:** live truck tracking (built, cannot function), full offline-first behaviour

Browsers gate "powerful features" behind a secure context, and `http://150.109.15.108:8080` is not one. Verified in a real browser on the live box:

```
isSecureContext: false      protocol: "http:"
navigator.geolocation.getCurrentPosition
  → code 1 PERMISSION_DENIED "Only secure origins are allowed"
navigator.serviceWorker → undefined
```

**Consequences today:** every driver reports "no signal" and the dispatcher's live map stays empty, no matter how correct the code is — the driver screen says so plainly rather than pretending. `public/sw.js` never registers either, so background sync and the offline shell are unavailable on this host; IndexedDB still works, so queued actions survive, and the online path is unaffected.

**Not a code fix.** `docker-compose.vps.yml`'s own header already documents the upgrade path: point a DNS A record at the box, decide who owns `:80`/`:443` (aire's nginx has been crash-looping since 30 July, which is the only reason those ports look free), then swap the overlay for `docker-compose.prod.yml` with Traefik + Let's Encrypt and set `DOMAIN`/`ACME_EMAIL`. Everything else in the delivery feature works over plain HTTP today.

> Also the reason the overlay's own comment says HTTP-only "is fine for a demo but NOT acceptable for real payroll data" — this blocker is that note coming due.

### ✅ B-09 — Dashboards silently freeze in production — **RESOLVED**

**Owner:** W1-C · **Closed:** migration `219_w1c_matview_refresh_function`
`refresh_dashboard_matview(view_name)` — `SECURITY DEFINER`, validates against a fixed 4-item allow-list, runs `REFRESH … CONCURRENTLY` dynamically. One function, so the service's per-view loop and try/catch work unchanged. **Verified by coordinator over the real path** (`mimi_app` → `SET LOCAL ROLE app_user` → refresh inside a transaction → COMMIT).
W1-C also answered the question that mattered: a clean `db:reset` reproduces `mimi`-owned matviews **every time** — the matviews are always created by whichever role runs migrations, never `app_user`. So this was permanent and would have hit every fresh environment.

<details><summary>Original report (audit)</summary>
**Verified live by coordinator**</details>
`app_user` cannot refresh any materialized view — all four are owned by `mimi`:
```
SET LOCAL ROLE app_user; REFRESH MATERIALIZED VIEW mv_sales_daily;
  → ERROR: must be owner of materialized view
```
`MatviewRefreshService` catches per-view and logs, so nothing crashes — which means the 5-minute auto-refresh **and** `POST /refresh` both silently no-op. Revenue, top products, staff KPI and delivery recap freeze at whatever a migration last built, with no error surfaced. Dashboard tests pass only because they refresh over the superuser pool.
**Same failure shape as D-22:** a working-looking system where the security boundary quietly disables the feature.

### 🟠 B-10 — W4-04 fan-out incident (contained, work salvaged)

**State:** ✅ contained — recorded as a process finding
W4-04 spawned three sub-agents against a 3-agent cap, collided with its own children's edits (its `dashboard.controller.ts` was overwritten mid-write), then entered a **polling loop burning ~213k tokens per wake-up** reporting "still waiting". Stopped via `TaskStop`.
**Outcome: the work survived.** 22 tests pass across asset (5), dashboard (8), report (9); backend builds clean. The dashboard child's both-directions proof is genuine — Supervisor `6,229,894.00` vs Owner `33,865,889.00`, both matching manual SUM oracles.
**Coordinator fixed 2 build breaks directly** (cheaper than 3 dispatches) — and **both were my fault**: I had `currentStep` added to `ApprovalDetail` as _required_, breaking two existing callers I failed to check for.
**Policy amended:** sub-agent fan-out is now explicitly forbidden in BUILD-PLAN §5.5 and must be stated in every brief.

**Status: 6 of 9 blockers closed today.** Remaining three are all deferred-by-decision, not stuck: B-05 and B-08 are Wave 6 test-infrastructure items; B-07 needs a scheduling call from you (below).

**Recently closed:** B-01 (HR projector), B-02 (multi-origin relay), B-03 (storage/MinIO), B-04 (seed counters), B-06 (outlet could not complete a shipment), plus `approvals.current_step` never clearing — all verified live by the coordinator.

### ✅ B-01 — HR sync projector produced no rows — **RESOLVED**

**Owner:** W3-09 · **Closed:** same day · **Verified:** 22/22 in `src/modules/hr/`
**Cause:** a pre-existing fixture bug, not a regression. The seed carries a committed `attendance` row for "today"; `attendance.integration.spec.ts` clears it via `withCleanSlate`, but the projector spec never did — so `applyCheckIn` correctly threw "already checked in today" and the projector was never reached. **File-parallelism had been masking it** (another spec's clean-slate window briefly deleted the same row); serial execution exposed it reliably.
**My migrations lead was wrong** — the agent checked and found `app_is_self()` is a no-op on this path, since the projector runs under `assertSystemContext`'s central-role bypass which short-circuits before that predicate matters. Second time an agent correctly disproved a coordinator hypothesis.
Also fixed: FK-ordered teardown, and a self-inflicted regression where its own idempotency change made `cancel()` a no-op — the old "cancel twice must fail" test was updated to assert the new intentional behaviour rather than reverting it.

### ✅ B-02 — Multi-origin relay regressed — **RESOLVED**

**Owner:** W3-10 · **Closed:** same day
**Cause:** W2-D added a 5th constructor parameter (`projectors: SyncProjectorRegistry`) to `SyncIngestService`. W3-10's test constructs that service manually and still passed 4 args, so `this.projectors` was `undefined` and `runApplyHooks` threw. Not a conflict with its `kernel/sync` edits, which were confirmed intact.
**Verified:** node-gateway 4/4, device-registry 10/10, combined 14 tests / 9.01s.
**Left behind:** see D-14 — 8 test files construct this service by hand, so the next constructor change breaks them all silently.

### ✅ B-03 — Two storage kernel tests failing — **RESOLVED**

**Owner:** W2-C · **Closed:** same day
**Cause:** the `mimi-minio` container was gone from the Docker daemon (`No such container`); both tests do a real `fetch()` PUT/GET and died at `ECONNREFUSED 127.0.0.1:9000` before reaching any assertion. Restarted; **10/10 storage, 23/23 with notification.** Verified independently.
**Note — my diagnosis was wrong and the agent disproved it.** I suggested the scope test was "stale-by-fix" from W1-C's `app_is_self()` change. It isn't: `assertEntityScope()` is pure TypeScript comparing `locationScope`/`CENTRAL_ROLES` and never touches an RLS predicate. The agent checked instead of accepting a confident-sounding lead. It also pre-emptively confirmed the bucket-state theory was moot (object keys are `randomUUID()`-based).

### ✅ B-04 — Seed never created `document_counters` rows — **RESOLVED**

**Owner:** W1-C · **Closed:** same day
**Fix:** took the harder, better option — migration `215` adds `allocate_document_number(doc_type, period)`, an atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING` that is now the **single** path capable of producing a document number. Seed and the eventual application numbering service both call it, so they cannot drift apart again.
**Swept and fixed all six affected seed sites** — SJ, PO, PC, WST, PRUN, RR — each re-keyed to a real idempotency key (`client_id`, a `notes` marker, or an existing unique constraint) rather than the document number. Confirmed no other document type is seeded at all, so `GR`'s live counter is application-created.
**Verified:** full `db:reset` (91 migrations) clean; all 6 counters correct post-seed; allocation returns the next number with no collision; a real `INSERT … surat_jalan` with an allocated number succeeds; re-running the seed alone stays idempotent with no counter burn.

### ✅ B-06 — Outlet cannot complete a shipment it receives — **RESOLVED**

**Owner:** W1-C · **Closed:** same day, migration `216_w1c_fix_surat_jalan_with_check_asymmetry`
**Verified live by coordinator:** `WITH CHECK` now carries the destination arm. Real-path proof: kepala_gudang dispatches a single-drop SJ, leader_outlet at the destination completes it (previously an RLS violation), and an unrelated outlet's supervisor gets 0 rows on both read and update.
**Sweep result:** the suggested `polqual` vs `polwithcheck` comparison across _all_ policies found 18 asymmetric ones — 17 legitimately so (narrower write-role lists matching RBAC), 1 real bug. Broader and more useful than the four tables originally named.
**Open follow-up:** two migrations share the number **216** (`_approvals_current_step_nullable` and `_fix_surat_jalan_with_check_asymmetry`). Harmless today — the runner keys on full filename — but ordering between them is decided by arbitrary string sort, which is a silent behaviour change waiting for a fresh `db:reset`. Renumber assigned.

<details><summary>Original report (kept for audit)</summary>
**Found by:** the new cross-kernel test</details>
`surat_jalan_scope` has an asymmetric policy — `USING` has three arms (origin, destination-outlets, driver), `WITH CHECK` has two (**destination arm missing**). Verified live. A `leader_outlet` receiving the last drop triggers `UPDATE surat_jalan SET status='completed'` and gets `new row violates row-level security policy`.
**Impact:** the primary receiving flow fails for any single-drop delivery — most of them.
**Why it survived:** `delivery.integration.spec.ts` runs `receive()` under `CENTRAL_CTX`/`owner`. **Third real bug hidden by an owner-role harness.**

### ✅ B-12 — Offline photo evidence — **CLOSED: mechanism + every consumer verified**

Device (W2-E), cloud (W2-C), and now all four call sites. Coordinator applied the new gate check repo-wide: `driver` and `outlet` pass `.attachmentId` where the schema wants a UUID; `pos` passes the whole `AttachmentRef`, which is what `commitVoidApprovedOffline(selfieRef?: AttachmentRef)` takes; `me` uses `captureEvidence` correctly. **Zero remaining minted-UUID attachment ids.** W4-07 also added the resolve-the-id-off-the-event assertion to both its offline tests.

<details><summary>The miss, kept for audit</summary>
I closed B-12 having verified the device and cloud fixes without checking the calling code. W4-09 caught it while building the same flow correctly. **Fixing a mechanism does not fix its consumers** — now a standing gate check: after any shared-API change, grep the call sites.
</details>
**Re-opened by W4-09**, which spotted it while building the driver surface against the same pattern.
`outlet/ReceivingPanel.tsx:85,89` calls `mintId()` for the photo and signature ids instead of using the `attachmentId` that `captureEvidence()` now returns. Driver does it correctly (`photoRef.attachmentId`). So outlet receipts still carry ids pointing at nothing — the exact *wajib foto* integrity break the fix was for. Assigned to W4-07 with a resolve-the-id-off-the-event test.
**Coordinator error:** I closed B-12 having verified the device fix and the cloud fix, but never checked that the calling code consumed them. **Fixing a mechanism does not fix its consumers** — worth a standing gate check: after any shared-API change, grep the call sites.

### ✅ B-12 mechanism — resolved, both tiers

**Cloud (W2-C): done.** `POST /api/attachments/presign` accepts an optional `X-Attachment-Id`; the online path is unchanged when absent. UUID-validated (`ERR_VALIDATION`) since a device-supplied primary key is attacker-influenceable. Same id + same declared content → idempotent re-presign; same id + different content → `ERR_CONFLICT`. `confirm()` rejects a re-confirm whose recomputed sha256 differs, and server-side `CopyObject`s when the bytes already exist — **sha256 stays the dedupe key, `attachmentId` the reference key**. End-to-end proof: presign with a device-minted UUID → real PUT → confirm → `getUrl()` by that same id → fetch → assert the bytes. 14/14.

**Device (W2-E): done.** `AttachmentRecord` gains a canonical `attachmentId`, minted once per distinct sha256 and reused on every dedupe hit; `captureEvidence` returns it; `getAttachmentByAttachmentId()` added. Regression test resolves **the exact id pulled off the committed event's payload** and asserts it points at the right bytes — not merely that both rows exist. Frontend **205/205**. Also closed D-25 (`listCachedCredentials()`), so POS and outlet stop reaching into IndexedDB directly.
**Cloud (W2-C): assigned.** `storage.controller.ts` ignores the `X-Attachment-Id` header, so the server still mints its own id and the correlation breaks server-side. The device _must_ own the id because an event can be applied before its binary uploads.
**Caught before shipping** because W2-E stated its wire assumption explicitly rather than burying it — the same divergence class that produced three earlier bugs, found one tier earlier this time.

<details><summary>Original report (audit)</summary>
**Verified live by coordinator**</details>
`AttachmentRecord` is keyed by **sha256** only — no UUID field. The `sj_drops.received` wire schema requires `photoAttachmentIds: array(uuid())` and `signatureAttachmentId: uuid()`. A client-minted UUID goes on the wire and **nothing correlates it back to the blob**.
**Impact:** an offline goods receipt produces an audit trail that *claims* photographic evidence and cannot produce it. This is the *wajib foto* path — FR-LOG-15's anti-fraud checkpoint on the warehouse→outlet flow. A record that looks complete but has no retrievable evidence is worse than no photo requirement at all.
Bundled with the same fix: `LocalRuntime` needs `listCachedCredentials()` (D-25) — POS currently reaches into the IndexedDB store directly.

### ✅ B-11a — Outlet receiving now works offline

`ReceivingPanel` rewired to `captureEvidence` + `commitDropReceived`. **Proof is unusually rigorous**: the test builds a real runtime with a `SyncTransport` whose every method _throws if called_, never invokes `start()`/`syncNow()`, and asserts outbox depth 0→1 and idempotence on double-tap. It can only pass if nothing touches the network.
Still open: the drop _list_ is an online read (no local SJ cache), so §8 row 6's true "blind receipt" is not yet reachable.

### ✅ B-11 RESOLVED 2026-08-23 — the four outlet flows now survive an outage end to end

**Opened:** by W4-07 while building the outlet UI · **Closed:** 2026-08-23

**The blocker's own description was out of date, and the truth was worse.** It read "`LocalRuntime` exposes
commit helpers for POS, attendance and delivery-drop facts — but none for `stock_opname`, `waste_records`,
`returns`, or `petty_cash`, and no `SyncEntity`/op mapping exists for them". By this week that was wrong in
both directions:

- All four already had authority-matrix entries WITH `pushOps`, and all four had payload schemas in the
  sync registry. Three of them (`stock_opname`, `waste_records`, `petty_cash`) already had device commit
  helpers too. Only `returns` was missing its helpers.
- What was ACTUALLY missing was the server half. Only `delivery`, `hr` and `pos` ever registered a
  `SyncProjector`. So a device could queue these facts perfectly well, push them successfully, and the
  server would log them into `sync_events` and **never create the domain row**.

That last part is the reason this mattered more than the ticket implied.
`SyncProjectorRegistry.project` returns `{ ok: true, ran: false }` for an `(entity, op)` nobody claimed —
correct for the many entities that are pull-only or logged-only, and a **silent data-loss trap** for one
whose entire purpose is offline capture. An outlet with no internet counted stock, photographed spoiled
chicken, raised a retur and paid cash for onions; all four synced; ingest reported success; nothing existed
afterwards; and nothing anywhere went red.

**What shipped — four projectors, each calling its module's OWN service:**

| Entity          | Ops projected                                      | Notes                                                                                                                                                             |
| --------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `waste_records` | `reported`                                         | `approved_offline` deliberately NOT projected — a provisional approval is a claim for §7.4 re-verification, not a write to replay                                 |
| `stock_opname`  | `opened`, `area_counted`, `submitted`, `cancelled` | `approved`/`rejected` stay online: adjudicating a variance is a conversation, and `pushOps` says so                                                               |
| `petty_cash`    | `recorded`                                         | actor is the PURCHASER from the payload, not whoever's device pushed the batch — on a shared tablet those differ and the claim must name who handed over the cash |
| `returns`       | `submitted`, `shipped_back`                        | plus the two missing device helpers, `commitReturnSubmitted`/`commitReturnShippedBack`                                                                            |

**Three rules held throughout, and each is written into the code:**

1. **Call the service, never the tables.** Every projector goes through `WasteService.create`,
   `StockOpnameService.create/upsertLines/submit/cancel`, `PettyCashService.create`,
   `ReturnService.create/submit/ship` — so the offline path keeps the same wajib-foto checks, document
   numbering, approval submission and stock posting as the online one. A projector that inserted rows
   itself would be a second implementation of each flow, which is exactly the shape of D-27.
2. **The DEVICE's id is the idempotency key, not `event.eventId`.** A retried push whose ack was lost, or a
   re-projection sweep off the conflict queue, carries a NEW event id and the SAME document id. Each
   service gained an optional caller-supplied id and returns the existing row untouched when it already
   exists.
3. **The device's document NUMBER is always discarded.** Two outlets offline both mint `SO/202608/0001`,
   and those columns are UNIQUE. The server issues real numbers; the device's id carries identity. Same
   rule the delivery projector already followed.

**The verify-first loop paid for itself immediately.** `ReturnSyncProjector` was added to the module's
constructor but not to its `providers` array — prettier had collapsed that array to one line, so the edit's
anchor silently missed. Nest cannot resolve such a constructor and **the entire application refuses to
boot**. `test/app-boot.spec.ts` caught it on the branch, before merge, which is precisely what that spec
exists for after the original boot incident. Fixed and re-verified before anything reached `main`.

**Verified on the server:** backend **899/899** across 98 files on a freshly migrated + seeded Linux
database, frontend **515/515**, lint 0 errors, format clean. Deployed; post-deploy e2e smoke green.

**Still online-only, and correctly so:** every `approved`/`rejected`/`verified` decision on these four, plus
`returns.received_at_warehouse`. Those are adjudications, not captures, and the authority matrix's
`pushOps` already said so — the projectors simply honour it rather than widening it.

### ✅ B-07 — Notifications never fired on business events — **RESOLVED**

`ApprovalService` now notifies on **submit** (step-1 approvers), **step advance** (next approvers), and **decision** (requester, with the reason on reject/amend — so someone whose order was silently halved is told). Channels follow the configured mode. Root cause of the silent filtering was found and fixed: `approval_pending`'s template declared `channels: ['in_app']` and `notify()` intersects with that list, so email/WhatsApp were dropped regardless of mode.
Recipient resolution is a cross-user read done through `withSystemContext`, never a raw pool or the caller's own scope. Every hook is try/catch-and-log — **a supervisor's phone being off must not fail a void**. 79 approvals tests, including a stub-failing notify proving the approval still commits.
**Notable care:** the new constructor params are `@Optional()` so the ~10 domain suites that build `new ApprovalService(new ApprovalsRepository())` keep passing unchanged; Indonesian outcome verbs live in the i18n file, the one place Indonesian text belongs.

### 🔴 B-13 — Approval notifications point at a route that does not exist

**Owner:** FE agent · **State:** 🔄 assigned · **Verified by coordinator**
The deep link is `${APP_WEB_BASE_URL}/approvals/:documentType/:documentId`. Frontend routes are `(auth) admin assets dashboard driver finance hr me outlet pos purchasing topology warehouse` — **no `/approvals`**. A WhatsApp link that 404s is worse than no notification.
Compounding it: **`getPending()` is built, tested, and rendered nowhere.** Approvers are now told they have work and have no queue to open. One surface closes both.

**Owner:** unassigned — needs a decision · **Found by:** the new cross-kernel test
Neither `ApprovalService` nor `ReplenishmentService`/`ReplenishmentAdvancementService` calls `NotificationService` **anywhere** (grep: zero hits). The kernel works, the templates exist (`approval_pending`, `low_stock`, …), but nothing invokes them for approvals, dispatch, or receiving. The only real producer in the whole flow is `ColdChainService`'s breach check.
**Impact:** an approver is never told they have something waiting. For a system whose value is timely multi-step approval (OBJ-03, APR-01..08), the workflow has no notifications at all.
**Question for scheduling:** wire per-module now, or as one pass in W5-04?

### 🟡 B-08 — No service-layer test can produce an audit row

**Owner:** deferred to Wave 6 · **Found by:** the new cross-kernel test
`AuditInterceptor` is HTTP-only (`context.getType() !== 'http'`) and is the sole writer of `audit_log`. Every service-layer integration test in the codebase — including the cross-kernel one — cannot generate a real audit row; `replenishment.integration.spec.ts` hand-inserts a synthetic one and says so in a comment.
**Impact:** "audit rows on every mutation" is a gate criterion that **cannot currently be verified below HTTP level**. Needs HTTP-level (supertest) coverage in W6.

### 🟡 B-05 — Cross-suite seed-invariant check fails

**Owner:** coordinator · **State:** accepted artifact, not scheduled
`stock-ledger`'s "seed invariant unchanged after the entire suite" fails in full runs because other suites mutate shared seed data. Correct behaviour for the assertion; wrong environment. Real fix is per-agent schemas (see D-01).

---

## 3. RESOLVED BLOCKERS (kept for audit)

| ID  | Blocker                                                                                                                                                                                                                                              | Resolution                                                                                                                           |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| ✅  | **D-22** — app connected as superuser with `BYPASSRLS`; a Kasir saw all 418 sales                                                                                                                                                                    | 4 defence layers + CI gate                                                                                                           |
| ✅  | `app_is_self()` threw on empty-string GUC                                                                                                                                                                                                            | `NULLIF` + 5 further sites audited                                                                                                   |
| ✅  | `NotificationService` on raw pool — **every** notification dead                                                                                                                                                                                      | fixed + `permission denied` pin                                                                                                      |
| ✅  | `StorageService` on raw pool — every _wajib foto_ flow dead                                                                                                                                                                                          | fixed + pin                                                                                                                          |
| ✅  | `audit.interceptor` on raw pool — audit rows silently failing                                                                                                                                                                                        | fixed + pin                                                                                                                          |
| ✅  | `findPendingCandidates` INNER JOIN — **every scoped approver's inbox empty**                                                                                                                                                                         | `app_user_display()` SECURITY DEFINER                                                                                                |
| ✅  | Same JOIN bug hid an entire opname header from a Supervisor                                                                                                                                                                                          | LEFT JOIN + id fallback                                                                                                              |
| ✅  | `kepala_gudang` blocked from outlet requests — FR-LOG-10 step 2 dead                                                                                                                                                                                 | `app_is_fulfilment_role()`, verified no over-widening                                                                                |
| ✅  | `INSERT … RETURNING` RLS violation on SJ tables                                                                                                                                                                                                      | policy rewrite + self-caught regression                                                                                              |
| ✅  | **No domain-projection hook** — synced offline facts never became rows                                                                                                                                                                               | registry + SAVEPOINT isolation                                                                                                       |
| ✅  | `SyncEmitService` guard checked the wrong axis                                                                                                                                                                                                       | now `canOriginate(CLOUD, …)`                                                                                                         |
| ✅  | bcrypt 72-byte truncation — **refresh-token rotation was a no-op**                                                                                                                                                                                   | SHA-256                                                                                                                              |
| ✅  | HMAC joiner `‖` vs `\|` — every offline approval would fail §7.4                                                                                                                                                                                     | fixed + known-answer fixtures both sides                                                                                             |
| ✅  | `atob`/`btoa` vs base64url + UTF-8                                                                                                                                                                                                                   | fixed + fixtures                                                                                                                     |
| ✅  | Postgres `DATE` → local midnight; every date shipped a day early under WITA                                                                                                                                                                          | fixed in HR/auth                                                                                                                     |
| ✅  | Supplier module could not serve one request (15 raw-pool calls)                                                                                                                                                                                      | request-client pattern                                                                                                               |
| ✅  | 27 tests asserting `expect(true).toBe(true)`                                                                                                                                                                                                         | rewritten, 12 real                                                                                                                   |
| ✅  | Wire format snake_case vs camelCase between tiers                                                                                                                                                                                                    | camelCase, spec corrected                                                                                                            |
| ✅  | Heartbeat field names diverged 3 ways                                                                                                                                                                                                                | `at`/`queueDepth`/`batteryPct`, all 3 artifacts aligned                                                                              |
| ✅  | Contract claimed Ed25519-signed token; code unsigned                                                                                                                                                                                                 | decided unsigned for v1, documented with rationale                                                                                   |
| ✅  | **CORS wide open in production** — `main.ts` falls back to `origin: true` with `credentials: true` when `CORS_ORIGIN` is unset, and it was never wired into either compose file or documented. Any origin could make credentialed cross-origin calls | Found by W1-A during a routine env sweep, not by a security pass. Prod now pins `https://${DOMAIN}`; documented in both env examples |

---

## 4. Wave task register

### Wave 0 — Contracts ✅

- [x] **W0-A** `CONTRACTS.md` — 3,448 lines · 104 tables · 137 permission keys · 317 endpoints · 12 approval chains · COA + posting rules
- [x] **W0-B** `SYNC-PROTOCOL.md` v1.4 — 95 entities · 27-row degradation matrix · T-01…T-17

### Wave 1 — Foundation ✅ · Gate G1 closed

- [x] **W1-A** infra — 7 manifests, compose ×3, CI with postgres + skip-detection gate
- [x] **W1-B** `@mimi/shared` + `@mimi/sync-protocol` — 339 tests, payload registry, 3 closed literal unions
- [x] **W1-C** schema — 94 migrations, 104 tables, RLS, realistic seed
- [x] **W1-D** BE core — two-phase RLS, boot-time superuser refusal, 30 pre-wired stubs, canonical system-context
- [x] **W1-E** FE shell — 27 components, 13 routes, i18n, PWA

### Wave 2 — Kernel ✅ · Gate G2 closed

- [x] **W2-A** stock-ledger — sole balance writer, dual mode
- [x] **W2-B** approvals — 12 chains, 4 runtime-resolved
- [x] **W2-C** audit / notification / storage / events — _2 tests currently red (B-03)_
- [x] **W2-D** cloud sync engine — ingest, authority, conflicts, **projection registry**
- [x] **W2-E** device local-first runtime — 152 tests, real argon2id, signature seam
- [x] **W2-F** branch node — optional Tier 2, simulate mode

### Wave 3 — Domain backend 🔄

- [x] **W3-01** auth · users · settings — 43 tests, statutory wizard, first system-context consolidation
- [x] **W3-02** location · item · product — 43 tests, storage areas, recipes/BOM
- [x] **W3-03** supplier — 12 tests, D-20 both directions
- [x] **W3-04** inventory — 88 tests, ledger-invariant property test
- [x] **W3-05** stock-opname — 19 tests, re-verified under **real** scoped sessions
- [x] **W3-06** replenishment — 28 tests, all 9 FR-LOG-11 statuses
- [x] **W3-07** delivery — 61 tests, Surat Jalan + cold chain + projector
- [x] **W3-08** pos — 13 tests, projector for **8 ops**, payment ladder preserved offline
- [x] **W3-09** hr — 22 tests, attendance + leave projectors with defensibility preserved
- [x] **W3-10** device-registry · node-gateway — 14 tests, topology + staleness sweep + multi-origin relay

**Wave 3: 10 of 10 built and verified.**

**Wave 3 gate — one item outstanding**

- [x] B-01, B-02, B-03, B-04 all resolved
- [x] Clean serial run — **61 files / 579 tests, all passing**
- [x] Node staleness sweep test — delivered by W3-10
- [x] **Cross-kernel scenario** — written, passing (1.4s, live DB, every step under its **real** role). Found 4 defects: B-06 (production-blocking), B-07, B-08, and `approvals.current_step` never clearing
- [x] **B-06 resolved** — migration `216_w1c_fix_surat_jalan_with_check_asymmetry.sql` adds the missing destination-outlet arm to `surat_jalan_scope`'s `WITH CHECK`, so the receiving outlet can complete its own shipment
- [x] **B-05 test isolation resolved** — QA-ISOLATION split `vitest.config.ts` into a parallel `unit` project and a serial `integration-live-db` project, and replaced blind-delete cleanups with balance reconciliation in 4 suites. Two consecutive full runs now give identical results

### Wave 4 — BE finish + FE start ✅ (ran as 4 sequential batches of ≤3, per §5.5 budget policy)

- [x] **W4-01** payroll — 10 tests, all §4.15 endpoints, golden case + 3 money-path wiring tests (statutory-ON vintage selection, POUT-05 opname shortfall, D-19 double-deduct prevention)
- [x] **W4-02** purchasing + waste-return — 10 tests, all §4.11/§4.12 endpoints, both retur directions with their genuinely different approvers, 2 permission-denied pins, wajib-foto enforced
- [x] **W4-03** accounting — 58 tests (26 property cases over all 16 PRD + 7 system + 2 local event types), double-entry GL, posting engine, PV ladder, trial balance / P&L / balance sheet. **D-04 and D-06 closed; D-18 unblocked**; 2 posting-rule mismatches found against real publishers
- [x] **W4-04** asset + dashboard + report — 22 tests (asset 5, dashboard 8, report 9); salvaged after the B-10 fan-out incident; dashboard proves both scoping directions with real figures
- [x] **W4-05** `(auth)` + `admin` UI — 38 tests, PIN setup, users/master-data/audit/settings, rank-limited role assignment
- [x] **W4-06** `pos` UI — 13 tests, offline via `LocalRuntime`, honest per-method payment status, ESC/POS receipt
- [x] **W4-07** `outlet` UI — 18 tests, 6 panels, receiving rewired to the offline path
- [x] **W4-08** `warehouse` UI — 11 tests, SJ builder with frozen/dry split + seal/temp, approval queue with amend-reason gate
- [x] **W4-09** `driver` + `assets` UI — both surfaces render live data; _`driver` emits a 403 on load, see §2_
- [x] **W4-10** `hr` + `me` UI — 25 tests, roster, attendance review surfacing `time_suspect`, payroll lifecycle, BPJS/PPh21 effective-window editors, absen rewired to the offline path

**Wave 4: 10 of 10 built.** Batch order was A (W4-01, W4-03) → B (W4-02, W4-04) → C (W4-05..07) → D (W4-08..10).

### Contract defects found by the UI surfaces (each flagged, none worked around silently)

| Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| ~~`Return.lines` response omits its line key~~ — **RESOLVED.** The field was there, named `id`, colliding with the return's own `id`; renamed to `lineId`. **Coordinator's premise was wrong**: `return_lines` has `UNIQUE (return_id, item_id)`, so the two-lines-one-item failure was already impossible. Fix still worthwhile — unambiguous key, and a raw Postgres unique-violation is now a clean `ERR_VALIDATION`                                                                   | ✅ W4-02              |
| **`ShipmentType` is 2-way (frozen/dry) but `StorageAreaType` is 5-way** — `chiller` has no shipment category. W4-08 lumped chilled under frozen. **Domain question, see §7**                                                                                                                                                                                                                                                                                                              | ⬜ needs client input |
| `AttendanceRow` has `geofenceOk: boolean` but no distance — UI recomputes client-side; a dispute should be adjudicated on the server's figure                                                                                                                                                                                                                                                                                                                                             | ⬜ backlog            |
| **`Leave[] & quota: {...}` is not a valid JSON shape** — arrays cannot carry named properties. UI handles both shapes and shows "Kuota belum tersedia" rather than a wrong balance                                                                                                                                                                                                                                                                                                        | ⬜ contract fix       |
| ~~**Offline attendance path existed and was unused**~~ — **RESOLVED.** A failed 6am check-in would mark the employee _alpha_ → **POUT-03 wage deduction**, from a connectivity problem. Now commits via `LocalRuntime`, selfie through `captureEvidence` for a canonical `attachmentId`. Proof: transport-throws test, outbox 0→1 on check-in, 1→2 on check-out, idempotent on double-tap. Also merges the online read with local optimistic state so a queued check-in isn't re-prompted | ✅ W4-10              |

> **Pattern worth carrying into Wave 5:** two of three offline-capable UI surfaces shipped online-only because their authors assumed a `LocalRuntime` helper was missing without checking. Both were rewired after the fact. **Every future FE brief must say: verify the exports before concluding a helper is absent.** Already added to W4-09's brief.

> **Coordinator correction:** the tracker previously listed W4-10 as "purchasing UI". That was my error — BUILD-PLAN §5 assigns **W4-10 = F08 `hr` + F11 `me`**, and F06 `purchasing` UI belongs to **Wave 5 (W5-04)**. Caught when W4-05 checked the RBAC matrix and found `payroll.statutory.config` is `finance`/`hr_admin`, so the BPJS/PPh21 rate editors belong to the HR surface — not the admin surface my brief had implied. It built only the Owner/Manager slice (readiness + enable/disable) and flagged the split rather than duplicating W4-10's work.

### Wave 5 — Completion 🔄

- [x] **W5-01** `dashboard` UI — 13 tests, RBAC-scoped (supervisor sees one outlet with an explicit scope banner), 4 tabs, outlet drill-down. Found the double `/api/api` routing bug
- [x] **W5-02** `finance` UI — 15 tests, payment ladder, journal with a live debits=credits gate, COA, reports with an explicit balanced/unbalanced indicator, fiscal periods, D-17 exception queue. Money as BigInt cents throughout
- [x] **W5-03** `topology` UI — 17 tests, handles the no-node case, does not alarm on legitimately-offline devices
- [x] **W5-04** `purchasing` UI — 11 tests, PR/PO/receiving/price history, D-20 price gate. _(Was mis-listed as "notification surfaces"; F06 purchasing is the BUILD-PLAN §5 assignment)_
- [x] **W5-05** print/document layer — **DONE 2026-08-19**, and the register was wrong about all three parts:
  - **Nota: was already done.** POS ships a full ESC/POS Web Bluetooth thermal receipt printer with
    unit-testable byte builders. Nothing needed building.
  - **Slip gaji: was a DEAD button.** `SlipGajiPanel` rendered "Download PDF" only when
    `slip.slipPdfUrl` was set, and `runs.service.ts` hardcodes it to null — so the control never appeared
    and no employee could obtain a payslip.
  - **Surat Jalan: nothing at all**, for the one LEGAL document in the system (D-14).
    Both now exist as chromeless `/print/**` routes printed by the browser rather than a bundled PDF
    generator — the same call already recorded for `/docs`. Being chromeless is what lets them print without
    the structural-selector trick `docs.css` had to use to hide the shell. Covered by e2e through the
    BUTTONS that reach them (a route nobody can navigate to is not a feature), plus a check that `/print`
    still requires a session
- [x] **W5-06** posting-rule completion — **verified done 2026-08-19**, not by reading the code but by the coverage tests in `packages/shared/src/gl/posting-rules.test.ts`: every one of the 16 PRD `JournalEventType`s AND all 9 D-04 `JournalSystemEventType`s has at least one rule (7 tests). The register had this open; it was not
- [~] **W5-07** branch-node packaging — **still PARTIAL, but the runbook half is DONE 2026-08-19.**
  `infrastructure/branch-node/` now carries the field package: `docker-compose.node.yml` (the outlet
  mini-PC stack — node + its own Postgres, `restart: unless-stopped`, named volume, LAN-bound health
  port, `TZ=Asia/Makassar` so a node cannot repeat the UTC-vs-WITA day defect), `node.env.example`, and
  a README that walks the install, the **order-dependent** pairing (the API refuses to mint a token for
  an outlet whose node setting is still OFF, D-26), a three-step verify, fleet update and teardown.
  Three things are still owed and are listed in the README under **Still owed** rather than dropped:
  **`install.sh`**, **signed images + a CI registry publish**, and a **fleet self-update channel**.
  None blocks a pilot install; all three block shipping nodes at scale. Deploying real node hardware
  remains a CHANGE ORDER (RISK-P5) — populating this directory does not make that decision
- [~] **W5-08** notification surfaces + n8n WA live test — **surfaces DONE 2026-08-19; WA half still blocked.**
  The earlier note here ("the header renders in-app notifications") was wrong. The bell was a `<button>`
  with no `onClick`, no badge and no panel, while `GET /notifications`, `POST /notifications/:id/read` and
  `/read-all` had been live all along with 56 rows behind them — every notification the system raised
  (an approval waiting on you, a cold-chain breach, a sync conflict) was written where nobody could read it.
  Now a real inbox: unread badge, dropdown, per-item and mark-all read, and a link through to the document
  a notification names. Polled at 60s rather than pushed over the sync socket — that socket is for DEVICE
  sync, and coupling user messaging to it would mean any browser without a device credential (which is
  every browser today) silently loses its notifications too.
  **Still blocked:** the n8n/WhatsApp live test — `WA_ENABLED=false` and no credentials supplied. Counted
  as PARTIAL rather than done for exactly that reason

### Wave 5b — Owner-driven UI round (2026-08-17) ✅ (8 items, all closed; F-UX is counted under 5c, where it belongs)

Raised directly by the owner after using the deployed system.

- [x] **F02-FIX** POS location gate — outlet picker for head-office roles; **two** indefinite spinners removed (22 tests)
- [x] **F-BRAND** branded login + role-aware home hub — hub reads `NAV_SECTIONS` live so it cannot drift from the sidebar; fixes missing `name`/`autoComplete` on login (5 tests)
- [x] **F-DELIVERY** `/delivery` dispatcher surface — SJ list with status/date filters, drop-level cold chain, completion rollup, chiller-vs-dry rule unit-tested (27 tests)
- [x] **F-WAREHOUSE** warehouse upgrade — permission-filtered tabs, stock opname + waste panels, outbound summary, terminal error states; **wired up `replenishment/:id/process`, which no UI could reach**
- [x] **BE-PURCH-FIX** purchasing contract + DATE/WITA fixes — incl. a **write-path** date bug and a supplier endpoint that could never execute
- [x] **DB-PV-RLS** migration 220 — `FOR SELECT` carve-out so `kepala_gudang` can read the PV row its own receiving creates, with proof it gained no write access
- [x] **CLEANUP-DATE** consolidated `formatDateOnly` into `common/`; removed two independently-wrong private copies
- [x] **QA-ISOLATION** live-DB suite determinism — serial `integration-live-db` project + reconcile-on-cleanup. **Closed 2026-08-19: 803 pass / 0 fail on a freshly reset database.** Two further isolation defects were found and dealt with along the way (`pickUnusedStockKey` handing out dirty keys — fixed; suites committing stock out of GDG — mitigated, root cause open, see §1a)

### Wave 5c — IA rework + live-system defects (2026-08-17, owner-reviewed) 🔄

The owner compared the system against AIRE and walked the deployed box. Everything here came from that.

- [x] **F-HUB-2** home = a **workspace chooser**, not a second menu. Three cards (Dasbor · Kasir · Dokumentasi), no sidebar. Single-workspace users are redirected straight in, so a cashier never sees a chooser. _The first hub was wrong: it kept the sidebar and listed every destination._
- [x] **F-POS-2** POS is now a standalone full-screen app — own top bar, branch + reason line, tabs Kasir / GoFood-ShopeeFood / Shift. Shell change only; all components reused (418 tests)
- [x] **F-DOCS** `/docs` — six role-filtered manuals in Bahasa Indonesia written from the real UI, print-to-PDF, no PDF dependency added. **This is BUILD-PLAN W7-03.**
- [x] **FIX-SECURECTX** `crypto.randomUUID` + double sync banner — **DONE.** `lib/uuid.ts` falls back to a `crypto.getRandomValues`-backed RFC-4122 v4 on an insecure origin (never `Math.random()` — these ids are `clientId`s and idempotency keys in an append-only protocol), pinned by `lib/uuid.test.ts`, which simulates the insecure origin explicitly
- [~] **FIX-LOADS** warehouse stock/opname/waste/retur, `/hr` denying the owner, empty recipe-ingredient list — **believed fixed, NOT verified as a set.** The commit-path repair ("THE BIG ONE") plus migrations 220/224 addressed the causes: `rbac.ts` grants owner `hr.employee.read`, and the warehouse panels' writes now actually commit. The empty recipe-ingredient list is D-28 (the seed has no batch recipe). Left at `[~]` on purpose — nobody has walked these four screens on the live box since, and this file does not mark things done on inference
- [~] **F-UX** the remaining flow simplification beyond hub/POS — **IN FLIGHT 2026-08-21, uncommitted.** The six-interface IA rework; see §1a-2. Frontend suite green (464/464) on the working tree

### 🔴 `crypto.randomUUID is not a function` — blank pages on the deployed box

`/pos` and `/admin` render **nothing** — "Application error: a client-side exception has occurred". `crypto.randomUUID()` exists **only in a secure context** (HTTPS or `localhost`). The deployment is plain HTTP on an IP, so it is `undefined` and throws.

**Every dev machine passes because `localhost` is treated as secure.** That is the entire reason this shipped, and it invalidates the coordinator's earlier judgement that "HTTP is acceptable for a demo box with mock data" — plain HTTP silently disables secure-context APIs, and this codebase depends on them for every client-generated id in the offline layer.

Fixed two ways: a correct RFC-4122 **v4 fallback built on `crypto.getRandomValues`** (available on insecure origins — `Math.random()` is NOT acceptable here, these ids are `clientId`s and idempotency keys in an append-only protocol), and HTTPS proper, which needs a hostname.

### 🔴🔴 THE BIG ONE — writes returned 201 and silently rolled back, across TEN modules

Found while investigating an unrelated "Gagal memuat data". The worst defect in the project so far.

`RlsCleanupInterceptor` issues an unconditional `ROLLBACK` after every request — by design, because a module service is expected to have already run its own `BEGIN…COMMIT` on the same client, making the rollback a no-op. **Ten modules never did.**

Confirmed live: `POST /api/stock-opname` → **201 with a full body**; an immediate `GET` on that id → **404**; list stays at 0. **Stock opname counts have never persisted, and the API reported success every single time.** Opname variance feeds POUT-05 wage deductions, so this reaches payroll.

**Broken (writes present, commit absent):** `stock-opname`, `accounting`, `hr`, `payroll`, `device-registry`, `node-gateway`, `settings`, `supplier`, `users`, and two `sync-admin` endpoints.
**Audited and already correct:** `asset`, `delivery`, `inventory`, `item`, `location`, `product`, `purchasing`, `waste-return`, `pos` (controller-commit convention), `auth`, `dashboard`, `report`.

**Why 765 passing tests never caught it — the important part.** Integration suites commit _manually_ in their own harness (`withCommit`), so they never exercise the interceptor path a real HTTP request takes. The tests proved the SQL was right and proved nothing about whether it survived the request. Structurally identical to the boot incident, where 744 tests passed while the app could not start because no test ever built the real DI graph.

**A second bug hid inside the first.** The old opname tests chained several mutations onto one connection — which only worked _because nothing committed_. Once commits became real, Postgres reset `SET LOCAL ROLE` at `COMMIT` and the chained calls failed with `permission denied`. The fake behaviour had been holding the tests up.

**Fixes:** a `withWrite()` helper per module matching the existing convention; tests restructured to **write on one connection and read back on a genuinely separate one** — a 201 assertion proves nothing here; and `RlsCleanupInterceptor` now _detects_ an uncommitted write on a successful mutating response (via `pg_current_xact_id_if_assigned()`), logging a WARN always and throwing outside production, so this class of bug can never be silent again.

> **Rule earned:** for any mutation, assert the read-back in a **separate request/connection**. A 2xx response body is not evidence of persistence.

### 🟠 Audit and logging — answering "do we have one?"

Yes. `audit_log` + `AuditInterceptor` + `@Audited()`, surfaced as **Administrasi → Jejak Audit**. Settings → **Umum is NOT a log** — it is system parameters (approval thresholds, cold-chain bounds, offline-credential TTL, company profile).
**Caveat on record:** the interceptor only activates on a real HTTP `ExecutionContext`, and every integration suite calls services directly, so **no test currently proves `@Audited()` writes a row**. It works in production; it is unproven in CI. An HTTP-level (supertest) harness would close this.

### 🟠 Test flakiness under load — measured, not assumed

`attachment-store.test.ts` and `hash-wasm-pin-verifier.test.ts` were reported as failing in one agent's run. Re-run in isolation and as a full suite: **418/418 pass**. Recorded as load flakiness so it is not inherited as a phantom known-failure.

### Wave 6 — QA ⬜

- [x] **W6-00 acceptance matrix — DONE 2026-08-19** → `docs/ACCEPTANCE.md`. Every criterion carries the NAMED test that evidences it, or `manual`, or `NONE`; every cited path was verified to exist. The `NONE` rows are ranked at the end — B-15, B-14, payroll golden cases, offsite backups, IDOR sweep. It also records what is deliberately NOT automated (thermal printing needs a printer; WhatsApp needs credentials) so those do not read as oversights
- [x] **W6-01 E2E × roles — DONE 2026-08-19.** `@mimi/e2e` is real: **39 specs passing against the live box**, covering session recovery, the hub, dispatcher route planning, the driver, both printable documents, and a journey for **all ten roles** (the nine business roles + superadmin).
      Each role journey asserts where `(auth)/landing.ts` puts it and exactly which surfaces it can and cannot reach, so it doubles as a nav-level RBAC sweep — a slice of W6-03, though the server remains the real boundary. The SEES/HIDDEN lists are TRANSCRIBED from `lib/nav.ts`'s permission arrays rather than recomputed at runtime: a test that derives its expectations from the code under test proves nothing.
      **Caught while writing it:** summarising `/approvals`' gate instead of reading it produced two wrong expectations — that entry accepts ANY of ELEVEN approve keys, so finance (`payment.verify`) and hr_admin (`hr.leave.approve`) legitimately see the approvals inbox. The test was wrong, not the app
- [~] **W6-02 offline adversarial — the unblocked half DONE 2026-08-19; the SW half still blocked by B-14.**
  - `apps/frontend/src/lib/local/sync/outbox-drain.ack-loss.test.ts` + `idempotent-commit.storage-full.test.ts`
    — ack loss (the push commits server-side but the ACK never arrives) and a storage-full IndexedDB. **8 tests, pass.**
  - `e2e/tests/offline-connectivity.spec.ts` — a REAL browser against the live box: every `/sync/v1`
    request aborted mid-session, then unblocked. Asserts the pill flips Offline, `OfflineBanner` appears,
    the app does not blank, and recovery returns it to Online with no reload. **2 tests, pass.**
  - **Both e2e tests failed on their first real run**, and neither failure was a product defect:
    (1) the suite asserted on the header straight after `login()`, but `owner` now lands on the
    **chromeless hub** (`CHROMELESS_EXACT_ROUTES`), which mounts no `Header` and no `OfflineBanner` —
    the same "assert before the surface exists" mistake this log has already recorded three times;
    (2) once degraded, `OfflineBanner` mounts a SECOND "Coba Sinkron", so the unscoped locator became a
    strict-mode violation. Both are recorded because the suite was authored by an agent that explicitly
    reported it had NOT executed it — which is exactly why unexecuted tests are not trusted here.
  - Still blocked: service workers do not register on an insecure origin, so the offline **shell** cannot
    be exercised on the demo box as deployed (B-14). The tests above deliberately avoid `serviceWorker`
    and geolocation, which is why they run at all
- [x] **W6-03 RBAC sweep — DONE 2026-08-19** (the automated half). `apps/backend/test/rbac-endpoint-sweep.spec.ts` enumerates every route the compiled AppModule registers (100+) and fails if any is neither `@Public` nor `@RequirePermission` — mutating routes asserted separately. Found four unguarded: three deliberate and now documented (the two CONTRACTS §4.0 approval reads, and the attachment URL which `StorageService.assertEntityScope` enforces), and one real gap, **B-15**.
      Not a full pen-test: this proves a guard EXISTS on every route, not that each key is the right one, and it does not probe for IDOR or scope-escape. Those remain manual
- [x] **W6-04 financial correctness — DONE 2026-08-19**, and it found the worst defect in the project so far (**B-16**).
      Added, all verified by running them myself rather than trusting the report: `packages/shared/src/payroll/payroll.golden.test.ts` (22) closes ACCEPTANCE **E6** — a cent-exact golden payslip, BPJS cap/floor clamping, the December Article-17 true-up, idempotency, and line reconciliation (Σearnings=gross, Σdeductions, ΣemployerCost). Notably **no figure is asserted as "correct Indonesian tax"** — every number is re-derived from the same configured rows the engine consumes, so the test proves self-consistency and cannot silently encode a wrong tax claim.
      `packages/shared/src/cart/online-order-net.property.test.ts` (9) closes **E7**'s arithmetic half. `apps/backend/src/kernel/stock-ledger/reconcile-opname.property.spec.ts` (2, live DB) proves `reconcile()` against arbitrary movement histories. `waste-gl-posting.spec.ts` and `pos-online-order-gl-posting.spec.ts` (2 each, live DB) are the executed proof of B-16.
      **31 + 6 = 37 tests pass.** The six live-DB ones need `DATABASE_URL` set — they `describe.skipIf` without it, which is the house convention (CI sets it; two existing specs do the same), but it does mean they silently skip on a bare local `vitest run`
- [~] **W6-05 perf (NFR-01) — harness written 2026-08-19, NOT YET RUN; both defects it found ARE fixed.** `perf/` holds a k6 suite:
  `nfr01-150-concurrent.js` (the gate — 150 VUs across a documented traffic mix, threshold `p(95)<3000ms`,
  the only number the repo actually states), five single-endpoint isolation scripts, a 1-VU smoke, and a
  sync-backlog script that mints real pairing tokens per outlet. **No run has happened** — no local backend
  was up and the live box is the owner's demo. So NFR-01 is still evidenced by NOTHING; a harness is not a
  measurement, and `docs/ACCEPTANCE.md` still reads `NONE` for it.
  Two **N+1 reads found and confirmed by hand**, both real:
  - `delivery/services/surat-jalan.service.ts:105-109` (`list`) and `:131-136` (`myJobs`) loop over SJ ids
    issuing per-row queries — 2/row and 5/row. **`myJobs` has no `LIMIT` at all**, so a driver with a long
    history fans out unbounded. This is the driver's pre-departure cache load, on a phone, on outlet wifi.
  - `pos/services/pos-sale.service.ts:488-511` (`GET /api/pos/sales`) — 2 queries/row. Minor.
    Two missing indexes were also found. **Both defects are now fixed:**
    - `queries.ts` gained batch twins (`selectDropsForSjs`/`LinesForSjs`/`TempLogsForSjs`/`SealsForSjs`, `selectSuratJalanHeaders`) and both builders now funnel through one pure `assembleSuratJalan`, so a list row and a detail row can no longer drift apart — they previously duplicated all 16 field mappings. `list` is 2 queries per PAGE instead of 2 per row; `myJobs` is 4 per page instead of 5 per row. Header order is re-imposed from the id page, since `ANY($1::uuid[])` returns rows unordered. **67 delivery tests pass unchanged**, which is what makes it fair to call this behaviour-identical.
    - Migration `223_w6_05_perf_indexes_wita_date_and_sj_lists.sql`: expression indexes on the WITA business-day filter for `sales`, `pos_shifts` AND `void_refunds` (there were three such call sites, not one), plus `(planned_date DESC, created_at DESC)`, `(status, planned_date DESC, created_at DESC)` and `(driver_id, planned_date)` on `surat_jalan`, dropping the two now-redundant single-column prefixes. Verified with `EXPLAIN` under `enable_seqscan=off` that the planner actually MATCHES the expression index (`Index Cond: ((occurred_at AT TIME ZONE 'Asia/Makassar')::date = ...)`) and that the composite serves filter+ordering with no `Sort` node — an expression index that fails to match is invisible, so that check is the point, not a formality.
      Also fixed: `myJobs` is now bounded. Without a `date` it used to return the driver's ENTIRE history and load full detail for each row; it now defaults to the last 7 WITA days with a hard `LIMIT 200`. The driver UI always passes today, so only other API consumers see any change
- [x] **W6-06 topology soak — DONE 2026-08-19.** `apps/backend/src/modules/device-registry/topology-heartbeat-soak.integration.test.ts`
      (10 tests, pass) drives heartbeat/staleness over a compressed clock. It surfaced a **real defect**, now
      fixed: `staleness-sweep.service.ts` emits `outlet_offline`/`outlet_online` sync events, but neither op
      existed in `packages/sync-protocol`'s authority matrix or schema registry — so every one was rejected and
      swallowed by a `.catch(logger.warn)`. **An outlet going offline never reached any device.** Added to both
      `authority-matrix.ts` and `schema/registry.ts` (141 sync-protocol tests pass, warnings gone).
      The lesson is the `.catch(logger.warn)`: a fire-and-forget emit made a total delivery failure look like noise

### Wave 7 — Deploy & handover ⬜

- [~] **W7-01 VPS / Traefik / backups + restore drill — PARTIAL, and much less risky than it was.**
  - Deployed with CI/CD, proven green.
  - **Backups: DONE 2026-08-19.** `backup.sh` had been written but never wired up — no cron entry, no dumps on disk. Now scheduled nightly at 02:00 via the `ubuntu` crontab, appended so the three neighbouring projects' entries were untouched. The exact cron line was executed under `env -i /bin/sh` to prove it works with a stripped environment, which is where "it runs by hand but not from cron" usually hides.
  - **Restore drill: DONE, and it actually restored.** The newest dump was loaded into a throwaway `mimi_restore_drill` database on the same server: 0 errors, and `users`/`sales`/`sj_drops`/`stock_movements`/`employees`/`role_permissions`/`sj_positions` all matched the live counts exactly. The throwaway database was dropped; the live one was never touched (pg_dump only reads).
  - **Still open:** no TLS (blocker B-14 — needs a domain), and `OFFSITE_REMOTE_CMD` is unset, so every dump lives on the same disk as the database it protects. That is fine against "someone dropped a table" and worthless against "the host died" — set it before go-live (NFR-06).
  - Host clock is `Asia/Shanghai`, which is UTC+8 with no DST, so 02:00 there IS 02:00 WITA today. If that host timezone ever changes, the schedule drifts relative to the business day.
- [x] **W7-02 technical docs — DONE 2026-08-23** → `docs/TECHNICAL.md`. Written for the engineer who inherits this, so it explains what the code cannot: why the layers sit where they do, the four database rules that are load-bearing (the `mimi_app`/`app_user` split, commit-your-own-transaction, `SET LOCAL ROLE` resetting at COMMIT, one writer for `stock_balances`), how an offline fact actually travels and where its silent trap is, and the sharp edges. · [x] W7-03 **Bahasa Indonesia manual** DONE as `/docs` (F-DOCS); training still owed
- [ ] W7-04 hardware spec — needs owner input (budget, vendor, per-outlet device count)
- [ ] W7-05 data importer — needs the owner's real files to design against

---

## 5. Technical debt register

| ID       | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Owner                |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| D-01     | Integration tests share one Postgres → per-agent schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Wave 6               |
| D-02     | 4 of 5 `system-context` copies still to retire (auth ✅ done)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | batch sweep          |
| D-03     | 3 display-name solutions; point POS + stock-opname at `app_user_display()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Wave 5               |
| D-04     | `journal_entries` seeds empty — GL invariant vacuous, finance UI has no data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | W4-03                |
| D-05     | `petty_cash_topup` / `employee_loan_disbursement` in prose, not enums                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | W4-03                |
| D-06     | `payment_verifications` online REST path blocked for Kasir context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | W4-03                |
| D-07     | `sync_events` unpartitioned — needed before production traffic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | W7-01                |
| D-08     | Heartbeat `storage: {usedMb:0, quotaMb:0}` is a **stub** — topology must treat as advisory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | W5-03                |
| D-09     | `outlet_online` recovery template missing; queue alert threshold-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | W5-04                |
| D-10     | `event.relayReceivedAt` not populated on in-memory envelope — read back from the row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | W2-D                 |
| D-11     | POS offline void does not drive `ApprovalService` bookkeeping (ordering in `runApplyHooks`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | W4-01/W2-D           |
| D-12     | `locations` = 23, not seeded 21 (uncleaned fixtures)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | housekeeping         |
| D-13     | 2 code comments inverted by SYNC-PROTOCOL v1.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | cosmetic             |
| D-14     | **8 test files construct `SyncIngestService` by hand.** A constructor change breaks all of them, silently and one wave later — this is exactly what caused B-02. Needs a shared test factory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Wave 6               |
| D-30     | **Frontend modules locally re-declare `ApprovalDetail` instead of importing it.** `components/outlet/lib/types.ts` and `components/warehouse/lib/types.ts` both define their own — and **neither carries `currentStep`**, the documented "chain complete" signal that was added to `@mimi/shared` specifically so consumers would stop inferring completion by scanning `steps`. So the fix landed in the contract and never reached the code. **Seventh instance of the duplication pattern**, and the clearest: _adding to a shared contract achieves nothing if nobody imports from it._ The new approvals surface imports from `@mimi/shared` and sets the pattern; migrate these two to match                                          | Wave 5               |
| D-27     | **Recipe-explosion formula lives in two places.** `modules/product`'s `RecipeService.explodeForSale` and `modules/pos`'s `recipe-usage.util` both implement `qty × (qtySold / yieldQty)`. They **had already diverged** — pos omitted the yield division, mis-posting stock for any batch recipe on every sale (latent: all 39 seeded recipes are `yield_qty = 1`, which is why 13 tests missed it). Now fixed, but the duplication remains. **Correct resolution: extract the pure formula to `@mimi/shared`** beside the `divQty`/`convertQty` primitives it already uses, so both import one implementation and neither depends on the other. Sixth instance of this pattern in the campaign                                             | W1-B + W3-02 + W3-08 |
| D-28     | **Seed has no batch recipe** — all 39 have `yield_qty = 1`, so the yield-division path is unexercised by any shared fixture. A test-local fixture is being added in `pos`; consider one in the seed so every module's tests hit it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | W1-C                 |
| D-29     | Device-side stock estimate will drift where `recipeLines[i].unitId` differs from the ingredient's base unit — `unit_conversions` is not shipped in the catalog payload. Acceptable per FR-POS-06 being an explicit _estimate_, but flagged so it is not a surprise                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | accepted             |
| D-25     | **`LocalRuntime` has no `listCachedCredentials()`** — it exposes `cacheOfflineCredential` (write) but nothing to discover a cached credential's id, which `commitVoidApprovedOffline` requires. The POS UI reads `runtime.db.store('credentials').getAll()` directly, breaking the runtime's encapsulation                                                                                                                                                                                                                                                                                                                                                                                                                                  | W2-E                 |
| D-26     | POS v1 scoping, called out explicitly rather than hidden: **single payment method per sale** (no split tender), and **void is offered only for the last completed sale on this device** (no searchable sales history)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | accepted for v1      |
| D-21     | **`mv_delivery_recap_daily` is unusable for its stated purpose** — its per-item grain double-counts `sj_count`/`drop_count` when summed across items. **Two agents independently reached this conclusion** and both avoided it (report queries base tables; dashboard's `ops-status.service.ts:77` documents the same). No active bug, but a matview nobody can aggregate from is dead weight: fix the grain or drop it                                                                                                                                                                                                                                                                                                                     | W1-C                 |
| ✅ D-22b | **RESOLVED 2026-08-23.** xlsx now works on all 10 report endpoints via `report/xlsx-writer.util.ts` — a real `.xlsx` (ZIP of OOXML parts) built on Node's own `zlib`, no npm dependency, no lockfile churn. Every cell is an inline STRING so `NUMERIC` decimals reach Excel byte-for-byte; routing them through a JS number would silently drop trailing zeros on a finance export. Output is byte-deterministic (fixed DOS timestamps) and was validated by an INDEPENDENT implementation — Python's `zipfile` CRC check plus an XML parse of every part — not only by the writer's own tests. Deliberate limits, written into its header: one sheet, no styles, no formulas; if it ever needs those, add `exceljs` rather than grow this | W1-A → report owner  |
| D-23     | Seed has **0 `stock_opname` rows**, so the report module's opname test skips (gracefully, not silently). Add an opname fixture so that path is exercised                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | W1-C                 |
| D-24     | `/reports/sales?groupBy=product` covers POS `sale_lines` only — online-order line items are qty-only per Appendix A-7 with no defensible price to attribute, so they are omitted rather than guessed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | accepted             |
| D-20     | **Seed leaves 6 outlets with an already-`open` `pos_shifts` row, all `device_id IS NULL`** (verified). `PosShiftService.open()`'s conflict check has no device filter when `deviceId` is omitted, so any test opening a shift at one of those locations collides. W3-08 worked around it transaction-locally (`neutralizeOpenShifts`) without touching seed data — correct, but the next module to open a shift hits the same wall. Either close them in the seed or give the conflict check a device filter                                                                                                                                                                                                                                | W1-C / W3-08         |
| D-16     | **PIN-05 tenure tiers have no schema home** — `salary_components.default_amount` is flat, not tiered; payroll uses a local `DEFAULT_TENURE_TIERS` placeholder. Needs a settings key or table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | W1-C / architect     |
| D-17     | **`payment_verifications.ref_type` CHECK omits `'employee_loan'`** despite CONTRACTS §6.3 naming it; payroll uses `'other'` for loan disbursement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | W1-C                 |
| D-18     | `markPaid` requires a PV already `status='paid'`, but no path reaches that state until M17's verify/pay flow lands — blocked seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | W4-03                |
| D-19     | POUT-04 combines annual + marriage leave quotas into one bucket (base calculator takes a single quota/taken pair)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | W4-01 / architect    |
| D-15     | `AUTHORITY[DEVICE_EVENTS].ops` (8 telemetry ops) barely overlaps the `device_events.type` DB CHECK (10 lifecycle types) — `outlet_offline`/`outlet_online` are valid in the DB but rejected at emit. Non-fatal: the DB row, `topology:update` broadcast and notification all still fire; only the redundant `sync_events` mirror is skipped with a WARN                                                                                                                                                                                                                                                                                                                                                                                     | W1-B / architect     |

---

## 6. Gate procedure (coordinator-run, mandatory)

1. `grep` for `expect(true).toBe(true)` / `it.skip` / `WOULD TEST` / `Placeholder` — any hit is false-green until disproven.
2. **Check duration** — integration tests take seconds; milliseconds means no database.
3. Two-pool fixture pattern present.
4. **RBAC negatives assert both directions** — denied sees nothing _and_ permitted sees data.
5. **Never accept a test count without running it.**
6. **Does the service acquire its DB client the way production does?** Every module needs a `permission denied` pin.
7. **Does the harness set the role the test claims to test?** An `owner` session cannot detect an RLS defect.

_Six false-green failures have been caught by this, including two blind spots in my own gate._

---

## 7. Risks needing a human decision

| ID          | Risk                                                                                                                                                                                                     | Needs                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| **RISK-P5** | Branch node contradicts SCOPE-OUT-01/02 — ~20 mini-PCs, installs in 4 cities                                                                                                                             | **PM change order**     |
| **RISK-P8** | Amendments exceed the PRD's 4-week / 1-dev envelope                                                                                                                                                      | **PM scope call**       |
| **RISK-S1** | DNS-rebind protection silently breaks LAN HTTPS; router-allowlist runbook won't scale. Decide companion-app fallback **before** fleet rollout                                                            | **PM, with RISK-P5**    |
| **RISK-S2** | Supervisor approves on the _cashier's_ tablet. Token unsigned by design (§7.2 v1.4). Real fix is approver-owned-device QR signing                                                                        | **PM if SM-02 binding** |
| **RISK-P4** | WhatsApp gateway credentials still not supplied; mock outbox carries go-live                                                                                                                             | **Client**              |
| **BUDGET**  | Waves 4–7 = 28 tickets. At Wave 3's rate ≈ 14M tokens. §5.5 lean policy should cut this materially; if still over seat capacity, the highest-ratio lever is **narrowing Phase 1** (branch node, full GL) | **PM**                  |
