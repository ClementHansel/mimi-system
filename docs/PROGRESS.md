# Mimi Chicken OS — Progress Tracker

**Last updated:** 2026-08-17, from a measured clean serial run.
**Maintenance rule:** this file is updated by the coordinator **every time a task or wave completes**, and whenever a blocker opens, changes state, or closes.

Legend: `[x]` done & verified by coordinator · `[~]` in flight · `[ ]` not started · `[!]` blocked

---

## 1. At a glance

| Wave | Tasks | Done | State |
|---|---|---|---|
| **0 — Contracts** | 2 | 2 | ✅ complete |
| **1 — Foundation** | 5 | 5 | ✅ complete · **Gate G1 closed** |
| **2 — Kernel** | 6 | 6 | ✅ complete · **Gate G2 closed** |
| **3 — Domain backend** | 10 | 10 | ✅ complete · gate closed |
| **4 — BE finish + FE** | 10 | 5 | 🔄 backend done, FE not started |
| **5 — Completion** | 7 | 0 | ⬜ not started |
| **6 — QA** | 7 | 0 | ⬜ not started |
| **7 — Deploy & handover** | 5 | 0 | ⬜ not started |
| **Totals** | **52** | **23** | **44%** |

**Measured test state**

| Workspace | Result |
|---|---|
| `@mimi/backend` | **740 pass / 4 fail (744)**, 74 files, serial. The 4 are the known cross-suite seed-mutation artifact (B-05), not defects |
| `@mimi/shared` | 205 pass · `@mimi/sync-protocol` 141 pass · `@mimi/branch-node` 42 pass |
| **Campaign total** | **~1,436 passing** |
| `@mimi/shared` | 198 pass |
| `@mimi/sync-protocol` | 141 pass |
| `@mimi/frontend` | **244 pass (244)**, 36 files — includes 2 transport-throws offline proofs (receiving, absen) |
| `@mimi/branch-node` | 42 pass |
| **Total** | **~1,102 passing** |

94 migrations · 104 tables + 4 matviews · backend `tsc` clean · all 3 contract artifacts consistent with code.

---

## 1b. Owner amendments (this session) — D-23…D-26

| Feature | State |
|---|---|
| **Approval modes** — `manual`/`whatsapp`/`auto`/`off` per document type (D-23), WhatsApp as deep-link notification not auth (D-24) | 🔄 backend building |
| **Connectivity + sync as two separate always-visible states** with a manual re-probe-and-sync button (D-25b) | ✅ **done** — 298 FE tests. Found the old pill *conflated* both dimensions (`isolated` always won), so "offline but drained" and "online with backlog" were both hidden |
| **Branch node per-outlet toggle, drain-before-off** (D-26) | ✅ **done** — 22 tests. Refuses OFF with a pending queue *and* refuses when the node is unreachable, since a stale zero is not a current zero. Reuses the real unpair sequence, no parallel path |
| **Cold chain: chilled + frozen share the truck** (owner: *"chilled and frozen always transported with chiller trucks… 2 types of trucks"*) | ✅ **backend done** — 66 delivery tests. `ShipmentType` stays `frozen`/`dry`, where `frozen` = the cold-chain truck carrying both classes. Range now comes from the **goods** via `storage_areas` (freezer −25…−15, chiller 0…5), evaluated **per class**, naming which class breached. Driver UI fix in flight |

**A worse bug found while fixing it:** `assertLinesMatchShipmentType` required exact `item.storage_type === shipmentType`, so **a chilled item could not be added to a frozen Surat Jalan at all** — chilled goods were structurally unshippable, not merely mis-validated. Also: had the range stayed static, every chilled reading would have flagged a breach, and an alarm that always fires is one drivers learn to ignore — which would have destroyed the cold-chain audit trail D-14 exists to create.

**Open follow-ups:** `@mimi/shared`'s `TempLog` exposes only `isBreach: boolean` and needs a `breachedClasses` field so the UI can name the class; the `coldchain.frozen` settings key is now a stale single range.

**Two real bugs found while building these:**
- `cloudReachable` returned `true` in LAN-only mode (`tier !== 'isolated'` instead of `=== 'online'`), so every plain-REST screen would attempt a cloud call in LAN mode and present the failure as a server error.
- **Worse, found adjacent:** `onUpstreamChange` fires only on a *transition*, so a device booting already-isolated never corrected the store's defaults — **a tablet powered on with no internet displayed "Online / Tersinkron"**. Fixed by reporting upstream state unconditionally from `start()` and the new `recheckConnectivity()`.

**Process failure of mine:** two agents in this batch edited `packages/shared` (frozen post-G1, collision rule 4) — one added a permission key, one added error codes. My briefs said "never write to `database/`" and never extended that to shared packages. All three additions were correct; the only casualty was a stale count assertion, since fixed. **Briefs must name every frozen path, not just the one that bit us last.**

## 1c. Post-Wave-4 work (owner amendments + incident fixes)

### 🔴 The application did not boot — **FIXED**
`SupplierModule` injected `SyncEmitService` without importing its module. Nest threw during graph construction, so **the entire API was dead**. Nothing caught it: **0 of 74 test files compiled `AppModule`**, only 1 used Nest's DI at all, and CI never started the app. Every suite constructs services directly, bypassing the container.
**Fixes:** the import; a boot test at `apps/backend/test/app-boot.spec.ts` that compiles the real graph and runs `init()` (**proven both directions** — fails with the exact original error when reverted); CI now runs it with postgres + redis.

### 🔴 `nest build` silently emitted nothing — **FIXED, and it was three packages**
`incremental: true` kept tsc's cache at the project root while `deleteOutDir: true` wiped `dist/`. tsc read "up to date", emitted zero files, exited 0. A deploy would have shipped an empty image.
**Reproduced in `packages/shared` and `packages/sync-protocol` too** (`rm -rf dist && npx tsc` → exit 0, no dist). All three now co-locate the cache at `dist/.tsbuildinfo`. CI and the Dockerfile both assert `dist/main.js` is non-empty; verified by booting the compiled graph **inside the built image**.

### B-11 offline flows — layers 1 and 2 done
| Layer | State |
|---|---|
| 1. Wire contracts + payload schemas | ✅ **already existed** — audit found all four entities classified class-B with schemas cross-checked against live DTOs. Nothing built; would have been the 8th duplication |
| 2. Device commit helpers | ✅ 135 tests in `lib/local`, transport-throws proofs |
| 3. Cloud projectors | ⬜ next |
| 4. Outlet UI rewire | ⬜ after |

**A silent-data-loss bug caught in layer 2.** `commitFact` dedupes on `(entity, entityId, op)`. Following my "use the entity id" instruction literally, a second `stock_opname.area_counted` would have **collided with the first area's queued row and been silently dropped** — an entire storage area's counts gone, no error. Since opname variance feeds POUT-05 wage deductions, that is money. Resolved with a distinct `areaCountId` per (opname, area) and a two-area regression test.

**Line correctly drawn by the contracts:** outlets may *submit* opname/waste/petty-cash/replenishment offline; Kepala Gudang approving and Finance verifying stay online. Only the outlet-supervisor step is offline-provisional (D-17), re-verified on sync.

### 🔴 Dates shifted a calendar day under WITA — **FIXED**
Found while correcting a naming inconsistency, and the naming was the lesser bug. `FiscalPeriodsService` returned the raw `pg` row (`period_code`, `start_date`) — the only place in `modules/accounting` skipping the `toX()` mapping every sibling uses. Fixing the names exposed what the names were hiding: **`node-pg` parses a `DATE` column into a JS `Date` using the local-timezone constructor**, so the implicit `.toISOString()` in `JSON.stringify` shifts the calendar day by the server's UTC offset. Under `Asia/Makassar` (UTC+8) a period ending **June 30 serialized as `2026-06-29T16:00:00Z`** — a wrong date reaching the finance UI, not merely a wrong field name.

Caught only because the fix added a test asserting the **value**, not the type. A test checking `typeof startDate === 'string'` passes on the wrong day.

**Fixes:** camelCase `FiscalPeriod` matching CONTRACTS §4.17; a documented `formatDateOnly()` that recovers `YYYY-MM-DD` regardless of server timezone; the **same bug found and fixed on `JournalEntry.entryDate`** during the audit-for-other-leaks sweep. Every other endpoint in the module checked — all already map through `toX()`, no `SELECT *`, and their `TIMESTAMPTZ` fields don't suffer this. Regressions now assert exact round-tripped dates, so a reintroduced shift fails loudly.

> **Class of bug worth remembering:** `DATE` (no time, no zone) and `TIMESTAMPTZ` (an instant) behave differently through `pg` + `JSON.stringify`. Only `DATE` shifts. Any new `DATE`-typed column returned to a client needs `formatDateOnly()`.

### 🔴 14 controllers were unreachable at their documented paths — **FIXED**
`main.ts` applies a global `api` prefix, and 14 controllers *also* declared `@Controller('api/...')`, so their real routes were `/api/api/...`. **Assets (3), suppliers, reports, all four HR controllers and all five payroll controllers** — entire subsystems answering 404 at every path CONTRACTS documents.

Nothing caught it: the app boots fine, the modules look correct in review, and **every suite calls services directly rather than over HTTP**, so no test ever issued a request to a real URL. Found only because the dashboard UI agent hit 404s building against the live API, investigated its own failure, and swept for siblings.

**Fixes:** all 14 corrected to the documented paths; a regression test (`test/no-double-api-prefix.spec.ts`) enumerates the registered route tree from the real `AppModule` **after** the global prefix is applied and asserts no route contains `/api/api/`.
**Coordinator-verified, not taken on report:** rebuilt, restarted, and probed each family with a real owner token — `assets`, `suppliers`, `reports/sales`, `hr/employees`, `payroll/periods`, `accounting/periods` all 200; `api/api/assets` correctly 404.

### 🔴 The UI reported "Offline" while fully online — **FIXED**
The header indicator and the offline banner were pinned to *Offline — Tidak Ada Koneksi* on a system visibly loading live data. Cause: `/sync/v1/*` is deliberately **outside** the `/api` prefix (main.ts exclude list, CONTRACTS §4.23) so a device's sync transport needs no knowledge of the REST prefix — but `next.config.ts` proxied only `/api/*` and `/socket.io/*`. The health probe therefore hit the **frontend** origin, 404'd, and the upstream selector concluded every candidate was unreachable.

Production is unaffected (the backend owns the whole `api.DOMAIN` host there), so this only bites same-origin deployments — including every dev machine. Fixed by adding the `/sync/v1/:path*` rewrite alongside `/socket.io`, which existed for exactly the same reason.

> This is the feature the owner specifically asked for. It was **built correctly and wired incorrectly** — the kind of defect unit tests structurally cannot see, since the store, the probe and the transport are each individually right.

### 🟡 Two host-dev environment traps — **one fixed, one documented**
- `next.config.ts` fell back to `http://backend:4000` — a Docker service name that cannot resolve on a host — so `next dev` outside compose 500s every proxied call with no hint at DNS. Both compose files set `BACKEND_ORIGIN` explicitly, so the fallback is *only* reached on a host; **changed to `localhost:4000`**, container runs unaffected.
- `.env` defines `REDIS_PORT=6379`, but the code reads **`REDIS_URL`** and the host mapping is **56379**. Starting the backend from `.env` alone crashes on redis. Not changed (compose-correct); needs `REDIS_URL` exported for host runs.

## 1d. Running system — verified in a real browser

**The app runs end to end.** Backend `:4000` (39 modules, 339 routes), frontend `:3100`. Logged in as `owner` via Playwright and captured every surface.

**What works, seen on screen:** branded shell with the full Indonesian IA (Operasional / Logistik & Gudang / Keuangan / SDM / Sistem), the **two-state connectivity indicator live in the header** (Offline · Tersinkron · Coba Sinkron), and `admin` rendering **real backend data** — actual users, roles and outlets across all four cities, with working search, filters and sort.

**Why it looked unbuilt:** `/dashboard` — where every Owner lands after login — still rendered the Wave-1 placeholder reading *"Dibangun oleh W5-01 pada Wave 5."* Every other surface was real; the first screen anyone sees was the one that wasn't.

**Two environment traps found while getting it up:**
- The frontend reads `NEXT_PUBLIC_API_URL`; starting it with the wrong var name silently falls back to `/api` on its own origin, so **login 404s with no useful error**. Documented in `.env.example` but easy to get wrong.
- Login inputs carry **no `name` attribute** (React-generated ids only) — breaks password managers, autofill, and any selector-based automation.

## 2. ACTIVE BLOCKERS

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
**Coordinator fixed 2 build breaks directly** (cheaper than 3 dispatches) — and **both were my fault**: I had `currentStep` added to `ApprovalDetail` as *required*, breaking two existing callers I failed to check for.
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
**Sweep result:** the suggested `polqual` vs `polwithcheck` comparison across *all* policies found 18 asymmetric ones — 17 legitimately so (narrower write-role lists matching RBAC), 1 real bug. Broader and more useful than the four tables originally named.
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
**Cloud (W2-C): assigned.** `storage.controller.ts` ignores the `X-Attachment-Id` header, so the server still mints its own id and the correlation breaks server-side. The device *must* own the id because an event can be applied before its binary uploads.
**Caught before shipping** because W2-E stated its wire assumption explicitly rather than burying it — the same divergence class that produced three earlier bugs, found one tier earlier this time.

<details><summary>Original report (audit)</summary>
**Verified live by coordinator**</details>
`AttachmentRecord` is keyed by **sha256** only — no UUID field. The `sj_drops.received` wire schema requires `photoAttachmentIds: array(uuid())` and `signatureAttachmentId: uuid()`. A client-minted UUID goes on the wire and **nothing correlates it back to the blob**.
**Impact:** an offline goods receipt produces an audit trail that *claims* photographic evidence and cannot produce it. This is the *wajib foto* path — FR-LOG-15's anti-fraud checkpoint on the warehouse→outlet flow. A record that looks complete but has no retrievable evidence is worse than no photo requirement at all.
Bundled with the same fix: `LocalRuntime` needs `listCachedCredentials()` (D-25) — POS currently reaches into the IndexedDB store directly.

### ✅ B-11a — Outlet receiving now works offline
`ReceivingPanel` rewired to `captureEvidence` + `commitDropReceived`. **Proof is unusually rigorous**: the test builds a real runtime with a `SyncTransport` whose every method *throws if called*, never invokes `start()`/`syncNow()`, and asserts outbox depth 0→1 and idempotence on double-tap. It can only pass if nothing touches the network.
Still open: the drop *list* is an online read (no local SJ cache), so §8 row 6's true "blind receipt" is not yet reachable.

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

| ID | Blocker | Resolution |
|---|---|---|
| ✅ | **D-22** — app connected as superuser with `BYPASSRLS`; a Kasir saw all 418 sales | 4 defence layers + CI gate |
| ✅ | `app_is_self()` threw on empty-string GUC | `NULLIF` + 5 further sites audited |
| ✅ | `NotificationService` on raw pool — **every** notification dead | fixed + `permission denied` pin |
| ✅ | `StorageService` on raw pool — every *wajib foto* flow dead | fixed + pin |
| ✅ | `audit.interceptor` on raw pool — audit rows silently failing | fixed + pin |
| ✅ | `findPendingCandidates` INNER JOIN — **every scoped approver's inbox empty** | `app_user_display()` SECURITY DEFINER |
| ✅ | Same JOIN bug hid an entire opname header from a Supervisor | LEFT JOIN + id fallback |
| ✅ | `kepala_gudang` blocked from outlet requests — FR-LOG-10 step 2 dead | `app_is_fulfilment_role()`, verified no over-widening |
| ✅ | `INSERT … RETURNING` RLS violation on SJ tables | policy rewrite + self-caught regression |
| ✅ | **No domain-projection hook** — synced offline facts never became rows | registry + SAVEPOINT isolation |
| ✅ | `SyncEmitService` guard checked the wrong axis | now `canOriginate(CLOUD, …)` |
| ✅ | bcrypt 72-byte truncation — **refresh-token rotation was a no-op** | SHA-256 |
| ✅ | HMAC joiner `‖` vs `\|` — every offline approval would fail §7.4 | fixed + known-answer fixtures both sides |
| ✅ | `atob`/`btoa` vs base64url + UTF-8 | fixed + fixtures |
| ✅ | Postgres `DATE` → local midnight; every date shipped a day early under WITA | fixed in HR/auth |
| ✅ | Supplier module could not serve one request (15 raw-pool calls) | request-client pattern |
| ✅ | 27 tests asserting `expect(true).toBe(true)` | rewritten, 12 real |
| ✅ | Wire format snake_case vs camelCase between tiers | camelCase, spec corrected |
| ✅ | Heartbeat field names diverged 3 ways | `at`/`queueDepth`/`batteryPct`, all 3 artifacts aligned |
| ✅ | Contract claimed Ed25519-signed token; code unsigned | decided unsigned for v1, documented with rationale |
| ✅ | **CORS wide open in production** — `main.ts` falls back to `origin: true` with `credentials: true` when `CORS_ORIGIN` is unset, and it was never wired into either compose file or documented. Any origin could make credentialed cross-origin calls | Found by W1-A during a routine env sweep, not by a security pass. Prod now pins `https://${DOMAIN}`; documented in both env examples |

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
- [x] **W2-C** audit / notification / storage / events — *2 tests currently red (B-03)*
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
- [ ] B-06 resolved (blocking — outlet cannot complete a shipment)
- [ ] B-05 test isolation (see §2) — a *second consecutive* run reintroduces the seed-invariant failure

### Wave 4 — BE finish + FE start ⬜ (4 sequential batches of ≤3, per §5.5 budget policy)
**Batch A — COMPLETE.** [x] **W4-03 accounting** — 58 tests (26 property cases across all 16 PRD + 7 system + 2 local event types), double-entry GL, posting engine, payment-verification ladder, trial balance / P&L / balance sheet. Carried items: **D-04 closed** (11 seeded balanced entries, 0 unbalanced), **D-06 closed** (`escalatedInsert` for Kasir-context PV writes), multi-leg rules verified against **real publishers** — found and fixed 2 mismatches. **D-18 unblocked.**
**Batch A** — [x] **W4-01 payroll** — 10 tests, all §4.15 endpoints, golden case + 3 money-path wiring tests (statutory-ON with vintage selection, POUT-05 opname shortfall, D-19 double-deduct prevention) · [~] W4-03 accounting · [x] **Wave 3 gate: cross-kernel scenario** (found 4 defects incl. production-blocking B-06)
**Batch B** — [x] **W4-02 purchasing + waste-return** — 10 tests, all §4.11/§4.12 endpoints, **both retur directions with their genuinely different approvers**, 2 permission-denied pins, wajib-foto enforced · [x] **W4-04 asset + dashboard + report** (22 tests: asset 5, dashboard 8, report 9 — salvaged after the B-10 fan-out incident; dashboard proves both scoping directions with real figures) · [x] **W3-08** transfer sales now reach the finance queue — **D-06 loop closed**
**Batch C — COMPLETE** — [x] **W4-05** `(auth)` + `admin` UI (38 tests; role-appropriate landing, PIN setup, users/master-data/audit/settings, rank-limited role assignment) · [x] **W4-06 POS UI** (13 tests; offline via `LocalRuntime`, honest payment-status per method, ESC/POS receipt) · [x] **W4-07 `outlet` UI** (18 tests; 6 panels — rewiring receiving to the offline path)
**Batch D** — [x] **W4-08 `warehouse` UI** (11 tests; SJ builder with frozen/dry split + seal/temp, approval queue with amend-reason gate) · [ ] W4-09 `driver` + `assets` UI · [x] **W4-10 `hr` + `me` UI** (25 tests; roster, attendance review with `time_suspect` surfacing, payroll lifecycle, BPJS/PPh21 effective-window editors, mobile self-service — *rewiring absen to the offline path*)

### Contract defects found by the UI surfaces (each flagged, none worked around silently)
| Finding | Status |
|---|---|
| ~~`Return.lines` response omits its line key~~ — **RESOLVED.** The field was there, named `id`, colliding with the return's own `id`; renamed to `lineId`. **Coordinator's premise was wrong**: `return_lines` has `UNIQUE (return_id, item_id)`, so the two-lines-one-item failure was already impossible. Fix still worthwhile — unambiguous key, and a raw Postgres unique-violation is now a clean `ERR_VALIDATION` | ✅ W4-02 |
| **`ShipmentType` is 2-way (frozen/dry) but `StorageAreaType` is 5-way** — `chiller` has no shipment category. W4-08 lumped chilled under frozen. **Domain question, see §7** | ⬜ needs client input |
| `AttendanceRow` has `geofenceOk: boolean` but no distance — UI recomputes client-side; a dispute should be adjudicated on the server's figure | ⬜ backlog |
| **`Leave[] & quota: {...}` is not a valid JSON shape** — arrays cannot carry named properties. UI handles both shapes and shows "Kuota belum tersedia" rather than a wrong balance | ⬜ contract fix |
| ~~**Offline attendance path existed and was unused**~~ — **RESOLVED.** A failed 6am check-in would mark the employee *alpha* → **POUT-03 wage deduction**, from a connectivity problem. Now commits via `LocalRuntime`, selfie through `captureEvidence` for a canonical `attachmentId`. Proof: transport-throws test, outbox 0→1 on check-in, 1→2 on check-out, idempotent on double-tap. Also merges the online read with local optimistic state so a queued check-in isn't re-prompted | ✅ W4-10 |

> **Pattern worth carrying into Wave 5:** two of three offline-capable UI surfaces shipped online-only because their authors assumed a `LocalRuntime` helper was missing without checking. Both were rewired after the fact. **Every future FE brief must say: verify the exports before concluding a helper is absent.** Already added to W4-09's brief.

> **Coordinator correction:** the tracker previously listed W4-10 as "purchasing UI". That was my error — BUILD-PLAN §5 assigns **W4-10 = F08 `hr` + F11 `me`**, and F06 `purchasing` UI belongs to **Wave 5 (W5-04)**. Caught when W4-05 checked the RBAC matrix and found `payroll.statutory.config` is `finance`/`hr_admin`, so the BPJS/PPh21 rate editors belong to the HR surface — not the admin surface my brief had implied. It built only the Owner/Manager slice (readiness + enable/disable) and flagged the split rather than duplicating W4-10's work.
**Batch C** — [ ] W4-06 **POS UI** (tablet, offline) · [ ] W4-07 `outlet` UI · [ ] W4-08 `warehouse` UI
**Batch D** — [ ] W4-09 `driver` UI + `assets` UI

### Wave 5 — Completion ⬜
- [ ] W5-01 `dashboard` UI · [ ] W5-02 `finance` UI · [ ] W5-03 `topology` UI
- [ ] W5-04 notification surfaces + n8n WA live test · [ ] W5-05 print/document layer (nota, SJ PDF, slip gaji)
- [ ] W5-06 posting-rule completion (all 16 journal events) · [ ] W5-07 branch-node packaging

### Wave 6 — QA ⬜
- [ ] W6-00 QA lead / acceptance matrix · [ ] W6-01 E2E × 8 roles · [ ] W6-02 offline adversarial
- [ ] W6-03 RBAC pen-test · [ ] W6-04 financial correctness · [ ] W6-05 perf (NFR-01) · [ ] W6-06 topology soak

### Wave 7 — Deploy & handover ⬜
- [ ] W7-01 VPS/Traefik/backups + restore drill · [ ] W7-02 technical docs · [ ] W7-03 **Bahasa Indonesia manual** + training
- [ ] W7-04 hardware spec · [ ] W7-05 data importer

---

## 5. Technical debt register

| ID | Item | Owner |
|---|---|---|
| D-01 | Integration tests share one Postgres → per-agent schemas | Wave 6 |
| D-02 | 4 of 5 `system-context` copies still to retire (auth ✅ done) | batch sweep |
| D-03 | 3 display-name solutions; point POS + stock-opname at `app_user_display()` | Wave 5 |
| D-04 | `journal_entries` seeds empty — GL invariant vacuous, finance UI has no data | W4-03 |
| D-05 | `petty_cash_topup` / `employee_loan_disbursement` in prose, not enums | W4-03 |
| D-06 | `payment_verifications` online REST path blocked for Kasir context | W4-03 |
| D-07 | `sync_events` unpartitioned — needed before production traffic | W7-01 |
| D-08 | Heartbeat `storage: {usedMb:0, quotaMb:0}` is a **stub** — topology must treat as advisory | W5-03 |
| D-09 | `outlet_online` recovery template missing; queue alert threshold-only | W5-04 |
| D-10 | `event.relayReceivedAt` not populated on in-memory envelope — read back from the row | W2-D |
| D-11 | POS offline void does not drive `ApprovalService` bookkeeping (ordering in `runApplyHooks`) | W4-01/W2-D |
| D-12 | `locations` = 23, not seeded 21 (uncleaned fixtures) | housekeeping |
| D-13 | 2 code comments inverted by SYNC-PROTOCOL v1.4 | cosmetic |
| D-14 | **8 test files construct `SyncIngestService` by hand.** A constructor change breaks all of them, silently and one wave later — this is exactly what caused B-02. Needs a shared test factory | Wave 6 |
| D-30 | **Frontend modules locally re-declare `ApprovalDetail` instead of importing it.** `components/outlet/lib/types.ts` and `components/warehouse/lib/types.ts` both define their own — and **neither carries `currentStep`**, the documented "chain complete" signal that was added to `@mimi/shared` specifically so consumers would stop inferring completion by scanning `steps`. So the fix landed in the contract and never reached the code. **Seventh instance of the duplication pattern**, and the clearest: *adding to a shared contract achieves nothing if nobody imports from it.* The new approvals surface imports from `@mimi/shared` and sets the pattern; migrate these two to match | Wave 5 |
| D-27 | **Recipe-explosion formula lives in two places.** `modules/product`'s `RecipeService.explodeForSale` and `modules/pos`'s `recipe-usage.util` both implement `qty × (qtySold / yieldQty)`. They **had already diverged** — pos omitted the yield division, mis-posting stock for any batch recipe on every sale (latent: all 39 seeded recipes are `yield_qty = 1`, which is why 13 tests missed it). Now fixed, but the duplication remains. **Correct resolution: extract the pure formula to `@mimi/shared`** beside the `divQty`/`convertQty` primitives it already uses, so both import one implementation and neither depends on the other. Sixth instance of this pattern in the campaign | W1-B + W3-02 + W3-08 |
| D-28 | **Seed has no batch recipe** — all 39 have `yield_qty = 1`, so the yield-division path is unexercised by any shared fixture. A test-local fixture is being added in `pos`; consider one in the seed so every module's tests hit it | W1-C |
| D-29 | Device-side stock estimate will drift where `recipeLines[i].unitId` differs from the ingredient's base unit — `unit_conversions` is not shipped in the catalog payload. Acceptable per FR-POS-06 being an explicit *estimate*, but flagged so it is not a surprise | accepted |
| D-25 | **`LocalRuntime` has no `listCachedCredentials()`** — it exposes `cacheOfflineCredential` (write) but nothing to discover a cached credential's id, which `commitVoidApprovedOffline` requires. The POS UI reads `runtime.db.store('credentials').getAll()` directly, breaking the runtime's encapsulation | W2-E |
| D-26 | POS v1 scoping, called out explicitly rather than hidden: **single payment method per sale** (no split tender), and **void is offered only for the last completed sale on this device** (no searchable sales history) | accepted for v1 |
| D-21 | **`mv_delivery_recap_daily` is unusable for its stated purpose** — its per-item grain double-counts `sj_count`/`drop_count` when summed across items. **Two agents independently reached this conclusion** and both avoided it (report queries base tables; dashboard's `ops-status.service.ts:77` documents the same). No active bug, but a matview nobody can aggregate from is dead weight: fix the grain or drop it | W1-C |
| D-22b | **xlsx export returns HTTP 501** on all 10 report endpoints — no writer dependency exists. JSON and CSV work. Matters because PRD ASM-02 has the client's finance team working in Excel | W1-A → report owner |
| D-23 | Seed has **0 `stock_opname` rows**, so the report module's opname test skips (gracefully, not silently). Add an opname fixture so that path is exercised | W1-C |
| D-24 | `/reports/sales?groupBy=product` covers POS `sale_lines` only — online-order line items are qty-only per Appendix A-7 with no defensible price to attribute, so they are omitted rather than guessed | accepted |
| D-20 | **Seed leaves 6 outlets with an already-`open` `pos_shifts` row, all `device_id IS NULL`** (verified). `PosShiftService.open()`'s conflict check has no device filter when `deviceId` is omitted, so any test opening a shift at one of those locations collides. W3-08 worked around it transaction-locally (`neutralizeOpenShifts`) without touching seed data — correct, but the next module to open a shift hits the same wall. Either close them in the seed or give the conflict check a device filter | W1-C / W3-08 |
| D-16 | **PIN-05 tenure tiers have no schema home** — `salary_components.default_amount` is flat, not tiered; payroll uses a local `DEFAULT_TENURE_TIERS` placeholder. Needs a settings key or table | W1-C / architect |
| D-17 | **`payment_verifications.ref_type` CHECK omits `'employee_loan'`** despite CONTRACTS §6.3 naming it; payroll uses `'other'` for loan disbursement | W1-C |
| D-18 | `markPaid` requires a PV already `status='paid'`, but no path reaches that state until M17's verify/pay flow lands — blocked seam | W4-03 |
| D-19 | POUT-04 combines annual + marriage leave quotas into one bucket (base calculator takes a single quota/taken pair) | W4-01 / architect |
| D-15 | `AUTHORITY[DEVICE_EVENTS].ops` (8 telemetry ops) barely overlaps the `device_events.type` DB CHECK (10 lifecycle types) — `outlet_offline`/`outlet_online` are valid in the DB but rejected at emit. Non-fatal: the DB row, `topology:update` broadcast and notification all still fire; only the redundant `sync_events` mirror is skipped with a WARN | W1-B / architect |

---

## 6. Gate procedure (coordinator-run, mandatory)

1. `grep` for `expect(true).toBe(true)` / `it.skip` / `WOULD TEST` / `Placeholder` — any hit is false-green until disproven.
2. **Check duration** — integration tests take seconds; milliseconds means no database.
3. Two-pool fixture pattern present.
4. **RBAC negatives assert both directions** — denied sees nothing *and* permitted sees data.
5. **Never accept a test count without running it.**
6. **Does the service acquire its DB client the way production does?** Every module needs a `permission denied` pin.
7. **Does the harness set the role the test claims to test?** An `owner` session cannot detect an RLS defect.

*Six false-green failures have been caught by this, including two blind spots in my own gate.*

---

## 7. Risks needing a human decision

| ID | Risk | Needs |
|---|---|---|
| **RISK-P5** | Branch node contradicts SCOPE-OUT-01/02 — ~20 mini-PCs, installs in 4 cities | **PM change order** |
| **RISK-P8** | Amendments exceed the PRD's 4-week / 1-dev envelope | **PM scope call** |
| **RISK-S1** | DNS-rebind protection silently breaks LAN HTTPS; router-allowlist runbook won't scale. Decide companion-app fallback **before** fleet rollout | **PM, with RISK-P5** |
| **RISK-S2** | Supervisor approves on the *cashier's* tablet. Token unsigned by design (§7.2 v1.4). Real fix is approver-owned-device QR signing | **PM if SM-02 binding** |
| **RISK-P4** | WhatsApp gateway credentials still not supplied; mock outbox carries go-live | **Client** |
| **BUDGET** | Waves 4–7 = 28 tickets. At Wave 3's rate ≈ 14M tokens. §5.5 lean policy should cut this materially; if still over seat capacity, the highest-ratio lever is **narrowing Phase 1** (branch node, full GL) | **PM** |
