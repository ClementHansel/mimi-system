# Mimi Chicken OS — Acceptance Matrix

**Owner:** W6-00 (QA lead) · **Created:** 2026-08-19 · **Gate:** G6 — "zero critical/major open; NFR-01..10 each evidenced"

## What this document is for

Before this file existed, "is it tested?" could only be answered by reading the
suites. That made two failure modes easy: assuming a surface was covered
because a nearby one was, and re-testing by hand something a machine already
checks on every push.

So each row below states a **checkable acceptance criterion** and, next to it,
**what actually evidences it today** — a named test file, `manual`, or `NONE`.
The `NONE` rows are the point of the document. They are not a backlog of nice
extras; they are the places where a regression would reach staging unnoticed.

**Coverage is recorded as it IS, not as it should be.** Where a suite exists
but only covers part of a criterion, the row says so rather than claiming the
whole thing.

### How to read the Evidence column

| Marker        | Meaning                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `e2e:<file>`  | Real browser against a running instance (`pnpm e2e`). Proves the flow works end to end, including routing and permissions |
| `int:<file>`  | Backend integration test against a live database, with real RLS                                                           |
| `unit:<file>` | Pure logic, no I/O                                                                                                        |
| `manual`      | Verified by a person; will not catch a regression                                                                         |
| `NONE`        | Nothing checks this                                                                                                       |

Run everything except the browser suite with `pnpm test`; the browser suite
with `E2E_BASE_URL=<url> pnpm e2e`.

---

## 1. Authentication and session

| #   | Criterion                                                                                     | Evidence                                                                                         |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A1  | A valid login lands the user on their role's route, not a generic page                        | `e2e:role-journeys.spec.ts`, `e2e:hub.spec.ts`                                                   |
| A2  | Credentials never appear in a URL, history or access log — including before the page hydrates | `unit:app/(auth)/login/page.test.tsx`                                                            |
| A3  | A corrupt or half-valid stored session recovers to `/login` instead of rendering nothing      | `e2e:session-recovery.spec.ts` (4 poisoned shapes)                                               |
| A4  | A good session survives a reload                                                              | `e2e:session-recovery.spec.ts`                                                                   |
| A5  | A role without a PIN is taken through set-pin and lands correctly afterwards                  | `e2e:support/app.ts` (exercised by every role journey)                                           |
| A6  | PIN verification cannot be brute-forced                                                       | **NONE — open defect, see B-15.** Any authenticated caller can guess any user's PIN, unthrottled |

## 2. Authorization (NFR-03)

| #   | Criterion                                                                          | Evidence                                                                               |
| --- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| B1  | Every registered route is either `@Public` or permission-gated                     | `int:test/rbac-endpoint-sweep.spec.ts` — 100+ routes, fails on any new unguarded route |
| B2  | Every **mutating** route carries a permission (CONTRACTS §0)                       | `int:test/rbac-endpoint-sweep.spec.ts`                                                 |
| B3  | Each role sees exactly the surfaces its permissions allow — no more                | `e2e:role-journeys.spec.ts` — all 10 roles, SEES _and_ HIDDEN asserted                 |
| B4  | The RBAC matrix matches CONTRACTS §3 per module                                    | `unit:packages/shared/src/rbac.test.ts` + per-module RBAC specs                        |
| B5  | `superadmin` holds every permission, and gains rows through RLS (`app_is_central`) | `unit:rbac.test.ts` (fails naming any key it lacks) + migration 222                    |
| B6  | A scoped role cannot read another location's rows (RLS, not just the guard)        | Partial — per-module RLS specs exist; **no systematic IDOR / scope-escape sweep**      |
| B7  | Pairing-token abuse and offline-credential replay (D-17)                           | **NONE** — named in W6-03's brief, not attempted                                       |

## 3. Delivery — dispatcher and driver (D-14)

| #   | Criterion                                                                       | Evidence                                                                                        |
| --- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| C1  | A Surat Jalan lists every stop with a real street address and coordinates       | `e2e:dispatcher.spec.ts`                                                                        |
| C2  | Gudang can reorder stops and write a per-stop brief while the SJ is draft/ready | `e2e:dispatcher.spec.ts` (round-trips through the server)                                       |
| C3  | Once loaded/in transit the ORDER locks but briefs stay editable                 | `e2e:dispatcher.spec.ts`                                                                        |
| C4  | The driver sees the address and can launch turn-by-turn in one tap              | `e2e:driver.spec.ts` (asserts the deep link carries real coordinates)                           |
| C5  | A brief written by gudang reaches the driver                                    | `e2e:driver.spec.ts`                                                                            |
| C6  | Location sharing state is always explicit — sharing, or denied, never silent    | `e2e:driver.spec.ts`                                                                            |
| C7  | A truck in transit appears on the dispatcher's live map                         | `e2e:dispatcher.spec.ts` (map renders; **positions blocked by B-14 — HTTP has no geolocation**) |
| C8  | Cold-chain temperature and seals are captured at load and every drop            | `int:delivery.integration.spec.ts`; **not covered end to end in a browser**                     |
| C9  | Receiving with a discrepancy records qty, reason and photo                      | `int:delivery.integration.spec.ts`; **no e2e**                                                  |

## 4. Documents (W5-05)

| #   | Criterion                                                                                       | Evidence                                                                       |
| --- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| D1  | A Surat Jalan prints as a signable delivery note — destination, items, signature block per drop | `e2e:print.spec.ts`                                                            |
| D2  | An unreceived line prints a blank ruled cell, never `0`                                         | Code-enforced; **assertion not in the spec**                                   |
| D3  | An employee can obtain their own payslip                                                        | `e2e:print.spec.ts`                                                            |
| D4  | A printable document still requires a session                                                   | `e2e:print.spec.ts`                                                            |
| D5  | POS prints a thermal receipt over Bluetooth                                                     | `unit:pos/receipt-printer` (byte builders). **Real hardware: manual, staging** |

## 5. Money and stock correctness (NFR-09/10)

| #   | Criterion                                                                     | Evidence                                                                                                                                                                 |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| E1  | Every journal event type has a posting rule                                   | `unit:packages/shared/src/gl/posting-rules.test.ts` — all 16 PRD + 9 D-04 events                                                                                         |
| E2  | Journals always balance (debits = credits)                                    | Engine: `int:accounting.integration.spec.ts`. Revenue/COGS now reach it: `int:accounting/daily-posting.spec.ts`. **11 of 25 event types are still never emitted — B-16** |
| E3  | Money is never floating point                                                 | `unit:packages/shared/src/money.test.ts`                                                                                                                                 |
| E4  | Stock balance always equals the sum of its movements, and never goes negative | `int:stock-ledger.property.spec.ts` (property-based)                                                                                                                     |
| E5  | Selling depletes ingredient stock via the recipe                              | Seed backfill + `int:stock-ledger`; the cost of that draw now posts to 5000 via `int:daily-posting.spec.ts`; **no e2e for a POS sale moving stock**                      |
| E6  | Payroll golden cases — a known input produces a known payslip                 | `unit:packages/shared/src/payroll/payroll.golden.test.ts` (22 tests) — cent-exact, statutory on/off, BPJS clamping, December Art-17 true-up, idempotency                 |
| E7  | Platform (GoFood/ShopeeFood) net-received math                                | Arithmetic: `unit:packages/shared/src/cart/online-order-net.property.test.ts` (9, property-based). **GL leg: FAILS — never posted, B-16**                                |
| E8  | Calendar dates use the WITA business day, not UTC (NFR-10)                    | `unit:packages/shared/src/wita`; seed fixed 2026-08-19 after a live 8-hour-a-day defect                                                                                  |

## 6. Offline and sync (NFR-07)

| #   | Criterion                                                                                                                   | Evidence                                                                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Connectivity tier and sync state are shown separately and correctly                                                         | `unit:lib/local` (135 tests)                                                                                                                                                                                                                                                                                                           |
| F2  | A device with no credential does not spam failed sync calls                                                                 | Fixed 2026-08-18; **no regression test**                                                                                                                                                                                                                                                                                               |
| F3  | Driver actions taken offline queue and flush on reconnect                                                                   | `unit:DriverJobsPanel.offline.test.ts`; **not exercised against a real network drop**                                                                                                                                                                                                                                                  |
| F4  | The adversarial set — mid-sale network kill, duplicate submit, clock skew, storage full, 24h backlog, two tablets diverging | Partial. `e2e:offline-connectivity.spec.ts` (real browser, every `/sync/v1` request killed then restored), `unit:outbox-drain.ack-loss`, `unit:idempotent-commit.storage-full`. **Still uncovered: clock skew, 24h backlog, two tablets diverging — and the offline SHELL, blocked by B-14 (no service worker on an insecure origin)** |

## 7. Non-functional evidence (gate G6)

| NFR    | Target                      | Evidence                                                                                                                          |
| ------ | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| NFR-01 | 150 concurrent users, < 3s  | **NONE.** A k6 harness now exists (`perf/`, threshold `p(95)<3000ms`) but **has never been run** — a harness is not a measurement |
| NFR-03 | RBAC across roles × modules | B1–B5 above                                                                                                                       |
| NFR-06 | Backups                     | Nightly cron + **restore drill performed** 2026-08-19. Gap: no offsite copy — every dump is on the same disk as the database      |
| NFR-07 | PWA / offline               | Partial — IndexedDB works; **service workers cannot register over HTTP (B-14)**                                                   |
| NFR-10 | WITA business day           | E8 above                                                                                                                          |
| Others | Defined in the PRD          | Not transcribed here — do not treat this table as the full NFR list                                                               |

---

## Standing gaps, ranked

1. **B-16 — the GL is still incomplete.** Revenue and COGS now post daily (`DailyPostingService`); purchases, waste, returns and stock adjustments (11 event types) still never do. Days traded before 2026-08-19 remain unposted until someone runs the backfill endpoint.
2. **B-15 — PIN oracle.** Any authenticated caller can brute-force any user's PIN. Mitigation is a product decision; four options are costed in PROGRESS.md.
3. **B-14 — no HTTPS.** Blocks live tracking outright and half of the offline suite (F4, C7, NFR-07).
4. **Offsite backups.** A restore drill passed, but every dump shares a disk with the database.
5. **IDOR / scope-escape sweep (B6, B7).** Guards are proven present; cross-location leakage is not disproven.
6. **NFR-01 has never been measured.** The harness is written; nobody has run it against a real instance.
7. **NFR-01 aside, delivery reads are now bounded** — the N+1 fan-out, the missing indexes and `my-jobs`' unbounded result set are all fixed. Nothing outstanding here beyond actually running the k6 harness.

## Deliberately not automated

- Thermal receipt printing on real hardware (D5) — needs a printer.
- WhatsApp notification delivery — `WA_ENABLED=false`, no credentials.
- Anything requiring a domain, until B-14 closes.
