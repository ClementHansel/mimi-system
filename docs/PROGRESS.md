# Mimi Chicken OS — Progress Tracker

**Last updated:** 2026-08-19, from a measured run on a freshly reset database + a full e2e pass on the live box.
**Maintenance rule:** this file is updated by the coordinator **every time a task or wave completes**, and whenever a blocker opens, changes state, or closes.

Legend: `[x]` done & verified by coordinator · `[~]` in flight · `[ ]` not started · `[!]` blocked

---

## 1. At a glance

| Wave                      | Tasks  | Done   | State                                                                                        |
| ------------------------- | ------ | ------ | -------------------------------------------------------------------------------------------- |
| **0 — Contracts**         | 2      | 2      | ✅ complete                                                                                  |
| **1 — Foundation**        | 5      | 5      | ✅ complete · **Gate G1 closed**                                                             |
| **2 — Kernel**            | 6      | 6      | ✅ complete · **Gate G2 closed**                                                             |
| **3 — Domain backend**    | 10     | 10     | ✅ complete · gate closed                                                                    |
| **4 — BE finish + FE**    | 10     | 10     | ✅ complete                                                                                  |
| **5 — Completion**        | 8      | 6      | 🔄 print layer DONE; node packaging + notifications PARTIAL (WA blocked)                     |
| **5b — Owner UI round**   | 9      | 8      | 🔄 QA-ISOLATION closed (803/0 on a fresh DB); F-UX not started                               |
| **6 — QA**                | 7      | 1      | 🔄 W6-01 DONE (39 e2e specs, all 10 roles); the other six QA tasks untouched                 |
| **7 — Deploy & handover** | 5      | 1      | 🔄 deployed + CI/CD; backups now scheduled & restore-drilled; W7-01 still open on TLS (B-14) |
| **Totals**                | **62** | **49** | **79%**                                                                                      |

**Measured test state** — re-run on a freshly reset database, 2026-08-18, not taken from agent reports.

| Workspace          | Result                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| `@mimi/backend`    | **803 pass / 0 fail** (8 skipped), 82 files                             |
| `@mimi/frontend`   | **435 pass (435)**, 67 files                                            |
| `@mimi/shared`     | 211 pass · `@mimi/sync-protocol` 141 pass · `@mimi/branch-node` 42 pass |
| `@mimi/e2e`        | **39 pass (39)**, 6 files — real browser vs the live box (`pnpm e2e`)   |
| **Campaign total** | **1,632 unit/integration + 39 e2e**                                     |

102 migrations (latest **222**) · 106 tables + 4 matviews · 10 roles · `tsc`, `lint` (0 errors) and `format:check` all clean.

**CI is GREEN** — first passing run in 11 commits; see 1c-3 for why it had been red and never reached the tests.

**Deployed:** `http://150.109.15.108:8080` — demo box, mock data, auto-deploys from `main`. Own Postgres/Redis/MinIO, one public port, seven neighbouring projects untouched.

---

## 1a. Session close-out — what is done, and what is not (2026-08-19)

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
| `@mimi/e2e` is a real suite                                         | **24 specs, 24 passing, 0 skipped** against the live box                      |

### Not done — carried into the next session

| Item                                                   | Why it is open                                                                                                                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **B-14 — HTTPS** (see ACTIVE BLOCKERS)                 | Needs a domain + TLS, not code. Blocks live truck tracking entirely and degrades offline-first; everything else works over HTTP today                             |
| **Backups sit on the same disk as the database**       | `OFFSITE_REMOTE_CMD` unset. Protects against a bad `DELETE`, not against losing the host. Needs an offsite target (rclone/S3) chosen by the owner                 |
| **Live truck tracking cannot function**                | Built and deployed, but browsers refuse geolocation on an insecure origin. Unblocks itself the moment B-14 closes                                                 |
| **Live-DB suites drain GDG stock**                     | Several `COMMIT` real movements instead of rolling back, so each full run draws the warehouse down. **Mitigated** (GDG stocked 10× deeper), root cause untouched  |
| **`attachment-store.test.ts` is flaky**                | Failed 2 of ~8 full runs, passes every time in isolation, has never failed in CI. No fix attempted — guessing at someone else's package is worse than flagging it |
| **e2e is not wired into any pipeline**                 | Runs by hand via `pnpm e2e`. A post-deploy smoke job is the obvious next step but would need browser install in CI and a decision on failing a deploy on it       |
| **`/driver` renders empty for owner/superadmin**       | `my-jobs` is a personal queue keyed on a `drivers` row neither account has. Working as designed; noted so it is not re-reported as a bug                          |
| **Pre-hydration clicks are silently ignored app-wide** | Only the login form guards it. Elsewhere the first click on a server-rendered control can do nothing, with no feedback                                            |

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

### 🔴 B-11 — Four outlet flows have no offline path, contradicting SYNC-PROTOCOL §8

**Owner:** architect decision needed · **Found by:** W4-07 building the outlet UI
`LocalRuntime` exposes commit helpers for POS, attendance and delivery-drop facts — but **none for `stock_opname`, `waste_records`, `returns`, or `petty_cash`**, and no `SyncEntity`/op mapping exists for them. So an outlet with no internet cannot count stock, record waste, raise a retur, or log a petty-cash purchase.
**The inconsistency:** SYNC-PROTOCOL §8's degradation matrix lists several of these as offline-capable, and the backend has push-class authority entries for them. Either the device runtime gains helpers, or §8 is describing a system we did not build. **Resolve explicitly rather than by omission** — RISK-02 (unstable branch internet) is the reason offline-first exists.
**Partially self-inflicted:** W4-07 also reported receiving as uncovered. It is not — `commitDropReceived` exists and was simply not used. That one is being rewired now, and it is the most operationally critical of the set: a delivery arriving during an outage currently cannot be recorded.

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
- [~] **W5-07** branch-node packaging — **PARTIAL.** A working `Dockerfile` and a hardware-free `SIMULATE=true` dev profile exist, so the image builds and runs. What does not exist is the field-installable package BUILD-PLAN §4 promises under `infrastructure/` — no installer, no provisioning runbook, no pairing walkthrough for a box someone carries to an outlet
- [~] **W5-08** notification surfaces + n8n WA live test — **PARTIAL.** `notification_outbox` and the three channels (`in_app`/`email`/`whatsapp`) exist and the header renders in-app notifications. The WA live test is **blocked**: `WA_ENABLED=false` on the VPS and no n8n/WhatsApp credentials have been supplied

### Wave 5b — Owner-driven UI round (2026-08-17) 🔄

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
- [ ] **FIX-SECURECTX** `crypto.randomUUID` + double sync banner — in progress
- [ ] **FIX-LOADS** warehouse stock/opname/waste/retur, `/hr` denying the owner, empty recipe-ingredient list — in progress
- [ ] **F-UX** the remaining flow simplification beyond hub/POS — not yet started

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

- [ ] W6-00 QA lead / acceptance matrix
- [x] **W6-01 E2E × roles — DONE 2026-08-19.** `@mimi/e2e` is real: **39 specs passing against the live box**, covering session recovery, the hub, dispatcher route planning, the driver, both printable documents, and a journey for **all ten roles** (the nine business roles + superadmin).
      Each role journey asserts where `(auth)/landing.ts` puts it and exactly which surfaces it can and cannot reach, so it doubles as a nav-level RBAC sweep — a slice of W6-03, though the server remains the real boundary. The SEES/HIDDEN lists are TRANSCRIBED from `lib/nav.ts`'s permission arrays rather than recomputed at runtime: a test that derives its expectations from the code under test proves nothing.
      **Caught while writing it:** summarising `/approvals`' gate instead of reading it produced two wrong expectations — that entry accepts ANY of ELEVEN approve keys, so finance (`payment.verify`) and hr_admin (`hr.leave.approve`) legitimately see the approvals inbox. The test was wrong, not the app
- [ ] W6-02 offline adversarial — **partly blocked by B-14**: service workers do not register on an insecure origin, so the offline shell cannot be exercised on the demo box as deployed
- [ ] W6-03 RBAC pen-test — per-module RBAC specs exist in the backend suite, but no systematic role × endpoint sweep
- [ ] W6-04 financial correctness · [ ] W6-05 perf (NFR-01) · [ ] W6-06 topology soak

### Wave 7 — Deploy & handover ⬜

- [~] **W7-01 VPS / Traefik / backups + restore drill — PARTIAL, and much less risky than it was.**
  - Deployed with CI/CD, proven green.
  - **Backups: DONE 2026-08-19.** `backup.sh` had been written but never wired up — no cron entry, no dumps on disk. Now scheduled nightly at 02:00 via the `ubuntu` crontab, appended so the three neighbouring projects' entries were untouched. The exact cron line was executed under `env -i /bin/sh` to prove it works with a stripped environment, which is where "it runs by hand but not from cron" usually hides.
  - **Restore drill: DONE, and it actually restored.** The newest dump was loaded into a throwaway `mimi_restore_drill` database on the same server: 0 errors, and `users`/`sales`/`sj_drops`/`stock_movements`/`employees`/`role_permissions`/`sj_positions` all matched the live counts exactly. The throwaway database was dropped; the live one was never touched (pg_dump only reads).
  - **Still open:** no TLS (blocker B-14 — needs a domain), and `OFFSITE_REMOTE_CMD` is unset, so every dump lives on the same disk as the database it protects. That is fine against "someone dropped a table" and worthless against "the host died" — set it before go-live (NFR-06).
  - Host clock is `Asia/Shanghai`, which is UTC+8 with no DST, so 02:00 there IS 02:00 WITA today. If that host timezone ever changes, the schedule drifts relative to the business day.
- [ ] W7-02 technical docs · [ ] W7-03 **Bahasa Indonesia manual** + training
- [ ] W7-04 hardware spec — needs owner input (budget, vendor, per-outlet device count)
- [ ] W7-05 data importer — needs the owner's real files to design against

---

## 5. Technical debt register

| ID    | Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Owner                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| D-01  | Integration tests share one Postgres → per-agent schemas                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Wave 6               |
| D-02  | 4 of 5 `system-context` copies still to retire (auth ✅ done)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | batch sweep          |
| D-03  | 3 display-name solutions; point POS + stock-opname at `app_user_display()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Wave 5               |
| D-04  | `journal_entries` seeds empty — GL invariant vacuous, finance UI has no data                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | W4-03                |
| D-05  | `petty_cash_topup` / `employee_loan_disbursement` in prose, not enums                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | W4-03                |
| D-06  | `payment_verifications` online REST path blocked for Kasir context                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | W4-03                |
| D-07  | `sync_events` unpartitioned — needed before production traffic                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | W7-01                |
| D-08  | Heartbeat `storage: {usedMb:0, quotaMb:0}` is a **stub** — topology must treat as advisory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | W5-03                |
| D-09  | `outlet_online` recovery template missing; queue alert threshold-only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | W5-04                |
| D-10  | `event.relayReceivedAt` not populated on in-memory envelope — read back from the row                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | W2-D                 |
| D-11  | POS offline void does not drive `ApprovalService` bookkeeping (ordering in `runApplyHooks`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | W4-01/W2-D           |
| D-12  | `locations` = 23, not seeded 21 (uncleaned fixtures)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | housekeeping         |
| D-13  | 2 code comments inverted by SYNC-PROTOCOL v1.4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | cosmetic             |
| D-14  | **8 test files construct `SyncIngestService` by hand.** A constructor change breaks all of them, silently and one wave later — this is exactly what caused B-02. Needs a shared test factory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Wave 6               |
| D-30  | **Frontend modules locally re-declare `ApprovalDetail` instead of importing it.** `components/outlet/lib/types.ts` and `components/warehouse/lib/types.ts` both define their own — and **neither carries `currentStep`**, the documented "chain complete" signal that was added to `@mimi/shared` specifically so consumers would stop inferring completion by scanning `steps`. So the fix landed in the contract and never reached the code. **Seventh instance of the duplication pattern**, and the clearest: _adding to a shared contract achieves nothing if nobody imports from it._ The new approvals surface imports from `@mimi/shared` and sets the pattern; migrate these two to match | Wave 5               |
| D-27  | **Recipe-explosion formula lives in two places.** `modules/product`'s `RecipeService.explodeForSale` and `modules/pos`'s `recipe-usage.util` both implement `qty × (qtySold / yieldQty)`. They **had already diverged** — pos omitted the yield division, mis-posting stock for any batch recipe on every sale (latent: all 39 seeded recipes are `yield_qty = 1`, which is why 13 tests missed it). Now fixed, but the duplication remains. **Correct resolution: extract the pure formula to `@mimi/shared`** beside the `divQty`/`convertQty` primitives it already uses, so both import one implementation and neither depends on the other. Sixth instance of this pattern in the campaign    | W1-B + W3-02 + W3-08 |
| D-28  | **Seed has no batch recipe** — all 39 have `yield_qty = 1`, so the yield-division path is unexercised by any shared fixture. A test-local fixture is being added in `pos`; consider one in the seed so every module's tests hit it                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | W1-C                 |
| D-29  | Device-side stock estimate will drift where `recipeLines[i].unitId` differs from the ingredient's base unit — `unit_conversions` is not shipped in the catalog payload. Acceptable per FR-POS-06 being an explicit _estimate_, but flagged so it is not a surprise                                                                                                                                                                                                                                                                                                                                                                                                                                 | accepted             |
| D-25  | **`LocalRuntime` has no `listCachedCredentials()`** — it exposes `cacheOfflineCredential` (write) but nothing to discover a cached credential's id, which `commitVoidApprovedOffline` requires. The POS UI reads `runtime.db.store('credentials').getAll()` directly, breaking the runtime's encapsulation                                                                                                                                                                                                                                                                                                                                                                                         | W2-E                 |
| D-26  | POS v1 scoping, called out explicitly rather than hidden: **single payment method per sale** (no split tender), and **void is offered only for the last completed sale on this device** (no searchable sales history)                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | accepted for v1      |
| D-21  | **`mv_delivery_recap_daily` is unusable for its stated purpose** — its per-item grain double-counts `sj_count`/`drop_count` when summed across items. **Two agents independently reached this conclusion** and both avoided it (report queries base tables; dashboard's `ops-status.service.ts:77` documents the same). No active bug, but a matview nobody can aggregate from is dead weight: fix the grain or drop it                                                                                                                                                                                                                                                                            | W1-C                 |
| D-22b | **xlsx export returns HTTP 501** on all 10 report endpoints — no writer dependency exists. JSON and CSV work. Matters because PRD ASM-02 has the client's finance team working in Excel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | W1-A → report owner  |
| D-23  | Seed has **0 `stock_opname` rows**, so the report module's opname test skips (gracefully, not silently). Add an opname fixture so that path is exercised                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | W1-C                 |
| D-24  | `/reports/sales?groupBy=product` covers POS `sale_lines` only — online-order line items are qty-only per Appendix A-7 with no defensible price to attribute, so they are omitted rather than guessed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | accepted             |
| D-20  | **Seed leaves 6 outlets with an already-`open` `pos_shifts` row, all `device_id IS NULL`** (verified). `PosShiftService.open()`'s conflict check has no device filter when `deviceId` is omitted, so any test opening a shift at one of those locations collides. W3-08 worked around it transaction-locally (`neutralizeOpenShifts`) without touching seed data — correct, but the next module to open a shift hits the same wall. Either close them in the seed or give the conflict check a device filter                                                                                                                                                                                       | W1-C / W3-08         |
| D-16  | **PIN-05 tenure tiers have no schema home** — `salary_components.default_amount` is flat, not tiered; payroll uses a local `DEFAULT_TENURE_TIERS` placeholder. Needs a settings key or table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | W1-C / architect     |
| D-17  | **`payment_verifications.ref_type` CHECK omits `'employee_loan'`** despite CONTRACTS §6.3 naming it; payroll uses `'other'` for loan disbursement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | W1-C                 |
| D-18  | `markPaid` requires a PV already `status='paid'`, but no path reaches that state until M17's verify/pay flow lands — blocked seam                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | W4-03                |
| D-19  | POUT-04 combines annual + marriage leave quotas into one bucket (base calculator takes a single quota/taken pair)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | W4-01 / architect    |
| D-15  | `AUTHORITY[DEVICE_EVENTS].ops` (8 telemetry ops) barely overlaps the `device_events.type` DB CHECK (10 lifecycle types) — `outlet_offline`/`outlet_online` are valid in the DB but rejected at emit. Non-fatal: the DB row, `topology:update` broadcast and notification all still fire; only the redundant `sync_events` mirror is skipped with a WARN                                                                                                                                                                                                                                                                                                                                            | W1-B / architect     |

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
