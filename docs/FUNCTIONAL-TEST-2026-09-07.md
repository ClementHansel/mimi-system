# Functional test, 2026-09-07 — a whole company day driven through the UI

A simulation of the business actually operating: nine real staff accounts, each in
their own browser, walking the whole operation in the order it happens — head
office sets up master data, the outlet asks for stock, the supervisor and then
Gudang Pusat approve it, the warehouse builds and dispatches a Surat Jalan, the
driver runs the drops on a phone, the outlet receives the goods, the till trades
and closes its shift, the outlet counts / writes off / returns / logs petty cash,
and the office turns what the warehouse cannot fill into a PR and a PO, pays for
it, and runs the people side.

It is a **simulation, not an assertion suite**. Every step is recorded pass /
fail / blocked and the run carries on, because the question being answered is
"which parts of this would work if a crew turned up tomorrow" and stopping at
the first failure answers it for one step out of sixty.

- Suite: `e2e/tests/sim-company-day.spec.ts` (+ `e2e/tests/support/journal.ts`)
- Run it: `E2E_BASE_URL=… E2E_ALLOW_WRITES=1 SIM_REPORT=… pnpm --filter @mimi/e2e test -- tests/sim-company-day.spec.ts`
- It **writes** — real requests, sales, shipments, hires — so it is gated on
  `E2E_ALLOW_WRITES=1` and belongs on a local or demo box, never on production.

`blocked` is deliberately distinct from `fail`: "receiving was never exercised
because nothing got dispatched" and "receiving is broken" are different
findings, and adding them together produces a false picture.

**Where it finished: 51 of 60 steps passing.** The first run of this simulation
scored 39, and the difference is the eleven defects in §1. The nine that remain
are the two unfixed defects in §2, the steps blocked behind them, and one
form that refuses silently (§2d).

---

## 1. Defects found, and fixed

Every one of these was found by driving the real UI as the person whose job it
is. None of them were visible to the unit suite — all 951 frontend tests passed
throughout, before and after.

The backend suite is a different story, but not because of these changes: 18
tests across 7 files fail on this box for the reason in §2e, and the chat and
delivery suites that cover the two backend fixes here pass in full (96 tests).

| #   | What a user hit                                                                                            | Root cause                                                                                                                                                                                                                                                                                                                      | Fix                                                                                                  |
| --- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1   | **Outlet "Terima Barang" was dead** — `Gagal memuat data` on every visit                                   | `SuratJalanService.list` built its WHERE with `String.replace('$$', …)`, which substitutes only the FIRST occurrence. The `locationId` clause names the value twice, so the survivor reached Postgres as a literal `$$` — a dollar-quote opener — and every location-filtered query died on `unterminated dollar-quoted string` | `replaceAll`                                                                                         |
| 2   | **No Surat Jalan could be created at all** — 409 "Data ini masih terpakai di dokumen lain"                 | `SjCreateForm` sent `unitId: l.itemId` — an item id in a column with a foreign key to `units` (`sj_lines_unit_id_fkey`, SQLSTATE 23503). `ReplenishmentLine` carries `unitCode` and no unit id, so no client could have filled that field correctly                                                                             | The unit is now DERIVED from `items.base_unit_id` server-side, so no client can get it wrong         |
| 3   | **The entire messaging feature persisted nothing** — Mail to head office, internal Chats, WhatsApp threads | Neither chat service ever committed. `RlsCleanupInterceptor` rolls back unconditionally, so every write was discarded. The `BE-TXN-ROLLBACK` tripwire turned it into a 500 rather than silent loss — this is occurrence **#4** of that pattern                                                                                  | `withWrite()` at the controller, one transaction per request                                         |
| 4   | **No voucher batch could be created**                                                                      | `CreateBatchDto` requires `code` (printed on the card, `/^[A-Z0-9_-]+$/`); the form never rendered or sent one, so every submit 400'd on a field the user could not see                                                                                                                                                         | Added the "Kode Batch" field, uppercased as typed, gated on the server's own rule                    |
| 5   | **Outlet "Retur ke Gudang" always failed**                                                                 | `ReturnService` requires `toLocationId` for `outlet_to_warehouse`; the form never sent it                                                                                                                                                                                                                                       | Resolved from the single `warehouse` location — it is not a choice the outlet makes                  |
| 6   | **Two of five waste reasons could not be saved; four real ones printed raw i18n keys**                     | Both waste panels hardcoded `['expired','damaged','spoiled','prep_error','other']`. `spoiled`/`prep_error` are not in `WasteReason`, so the API rejected them; `lost`/`contaminated`/`cold_chain_breach`/`production_error` are, and had no label — `/warehouse/waste` showed `outlet.waste.reason.cold_chain_breach` on screen | Both panels now use the shared enum; the seven labels match the DB CHECK                             |
| 7   | **Owner and Superadmin could not register an asset**                                                       | The required "Lokasi" picker was built from `user.locations`, which is empty by design for an all-locations account — and they are the only roles holding `asset.manage`                                                                                                                                                        | Sourced from `/locations`, the same way `EmployeesPanel` does                                        |
| 8   | **Pressing "Mulai Pemrosesan" made a request unshippable**                                                 | The SJ picker asked for `status=approved` only, while `listWarehouseQueue`'s own header says "`approved`+`processing` feed SJ building". The documented order is `approved → processing → shipped`; picking the stock removed it from the picker                                                                                | The picker now fetches both                                                                          |
| 9   | **The till said "Tersinkron" while nothing had been sent**                                                 | `setQueueDepth` had exactly one caller — at the END of a successful sync cycle. When no cycle can run (the case that matters), the depth was never read and `SyncPill` rendered 0 as "synced"                                                                                                                                   | Depth is published before the early returns and on every probe tick. The till now reads "1 menunggu" |
| 10  | **The Surat Jalan printed the wrong driver's name**                                                        | `drivers.name` kept the name `seed.ts` inserted; `org-model.ts` then renamed the person but its own INSERT is guarded on `NOT EXISTS`, so the driver row was never updated. `driver1` read "Cahyo Setiawan" while their user and employee records both said "Ayu Rahayu"                                                        | The seed re-asserts the name alongside `is_active`                                                   |
| 11  | **A cook opening Waste got a 403 and an unhandled page error**                                             | `WastePanel` fetched the returns list even when rendering `only="waste"`, and neither fetch had a `.catch` — a Juru Masak holds `waste.read` but not `return.read`                                                                                                                                                              | Fetch only what the view renders; catch refusals                                                     |

### Environment, not product

`S3_PUBLIC_ENDPOINT` was never passed to the backend by `docker-compose.yml` —
only by the prod overlay. Every presigned upload URL therefore pointed at
`http://minio:9000`, which no browser can resolve, so **every photo-evidence
flow** (waste, retur, PO receiving, attendance selfie) failed at the upload step
on any dev or LAN stack. The backend logs this at boot and it was still missed.
The base compose file now passes it through, defaulting to the old behaviour
when unset.

---

## 2. Defects found, NOT fixed

### 2a. Warehouse stock opname cannot be performed at all

`/warehouse/opname` → Mulai Opname → any area → **"Belum ada data"**, on a
Chiller holding 99 stocked items.

`StockOpnamePanel.openSheet` builds the count sheet from `opname.lines` alone,
and a freshly-created opname has none — lines exist only once a quantity has
been recorded. This is the identical defect that was found and fixed for the
OUTLET on 2026-09-02: `components/outlet/lib/opname-sheet.ts` exists precisely
for it, is unit-tested, and its header describes this exact dead end. The
warehouse sibling was never given the same treatment.

**Fix:** port `buildOpnameSheet(full.lines, balances)` from
`components/outlet/OpnamePanel.tsx` into `components/warehouse/StockOpnamePanel.tsx`.

**Why it is not done here:** the warehouse panel keys its drafts, its CSV import
join and its submit path on the LINE id, while the sheet builder is keyed on
`itemId`; the component has no tests of its own, and the CSV import path is the
part most likely to break silently. It wants doing deliberately, not as a
drive-by at the end of a long session.

### 2b. Nothing the till commits ever reaches the server

A shift opened and two sales rung sat in the browser's IndexedDB `outbox`
indefinitely, with **zero** write requests made in 90 seconds while the app
reported itself online.

`SyncEngine.syncNow()` returns early when `hasDeviceCredential()` is false, and
`lib/local/browser.ts` says why in its own comment: _"No browser has one today —
nothing in the app calls `/api/devices/register` yet."_ So the outbox never
drains for anybody — this is not an unpaired-till edge case.

Confirmed at the database: no `pos_shifts` row and no `sales` row for any of the
sales this simulation rang.

Finding #9 above at least makes the backlog visible ("1 menunggu" instead of
"Tersinkron"), but **device registration is unimplemented and the offline-first
half of the product is therefore not delivering anything.** That is a feature,
not a fix, and needs a decision rather than a patch.

### 2c. A precise server error is replaced by a generic one

Filing leave beyond quota returns

```
400 {"code":"ERR_VALIDATION",
     "message":"Requested 2 day(s) exceeds remaining annual quota (0 of 12 left)",
     "details":{"quota":{"total":12,"used":12},"requestedDays":2}}
```

and the form shows _"Data yang dikirim tidak valid. Periksa kembali isian
Anda."_ The quota guard itself works correctly. But the frontend resolves copy
from the error CODE by design (CONTRACTS §0 — `message` is developer text), and
`ERR_VALIDATION` has no better copy to resolve to. Giving this its own code
(e.g. `ERR_LEAVE_QUOTA_EXCEEDED`) is a contract change and belongs with the
architect.

---

### 2d. The Surat Jalan create button is enabled when it cannot submit

`SjCreateForm`'s "Buat Surat Jalan" is never disabled, but `submit()` opens with
`if (!canSubmit) return;` — so when a required piece is missing (no request
ticked, no driver, no vehicle, or a frozen shipment on a vehicle without a
freezer) the button is pressed, nothing happens, no request is made and nothing
is said. The only clue is an inline error on the vehicle field, and only for
that one cause.

Creating a Surat Jalan **does work** — this session created `SJ/202609/0343`
through the form once defect #2 was fixed — but the simulation could not do it
reliably, and this is why: a failure to submit is indistinguishable from a dead
button. Disabling the action while `canSubmit` is false (as the voucher, waste
and receiving forms all do) would make the state legible.

### 2e. An unreachable SMTP host blocks the operations that notify

`tenant_email_settings` holds `host = smtp.example.com`, `is_enabled = true`
(set 2026-09-04, three days before this exercise). That host does not resolve,
and `EmailChannelService` has no timeout or circuit breaker in front of it — so
every operation that notifies somebody waits on DNS and connect before
finishing.

The backend log fills with

```
ERROR [EmailChannelService] Failed to send email to spv_bpp01_p@mimichicken.local:
      getaddrinfo ENOTFOUND smtp.example.com
```

and it is not cosmetic: **it currently fails 18 backend tests across 7 files**,
every one of them a live-DB spec that submits an approval, closes a shift or
posts a stock movement, and every one of them timing out at exactly 30s.
Proven by flipping `is_enabled` to false and re-running
`approvals.integration.spec.ts`: 2 timeouts became 45 passed. The setting was
restored to `true` afterwards, exactly as found.

Two things follow. Operationally, whoever configured that row should either
point it at a real relay or disable it. Structurally, a notification channel
that can hang for 30 seconds is on the critical path of an approval — a mail
server going down should not slow down the warehouse, so the send wants a short
timeout and a failure that is recorded rather than awaited.

## 3. What is working

Verified by doing it, as the person whose job it is:

**Head office** — dashboard and all seven reporting tabs; supplier create and
search; voucher batch minting; asset registration; hiring an employee; creating
a login; the audit trail recording all of it.

**Outlet** — raising a replenishment; approving it at the supervisor step;
reading stock on hand; clocking in with a selfie inside the geofence; recording
waste with photo evidence; returning damaged stock to the warehouse; logging a
petty-cash purchase; reading and saving the week's shift roster; receiving
screen loads.

**Gudang Pusat** — the front page with live counts; all seven warehouse areas;
approving the warehouse step of a replenishment (with the requester's NAME, not
a UUID); building, loading and dispatching a Surat Jalan.

**Driver** — the run appears on a phone-sized screen and can be worked through
to completion.

**Till** — opens on the right branch; refuses to open without a float; the shift
survives a reload; cash and QRIS sales complete; the shift closes against a
counted drawer. (See 2b for what this does NOT prove.)

**Kitchen** — the cook can read the stock floor, open Waste without tripping a
permission they do not hold, and clock in.

**Purchasing** — outlet requests listed with real item counts; converting one
into a PR; the PO form; supplier price history.

**Finance** — the payment verification queue; recording a payment; all six
finance tabs including the journal, chart of accounts, reports and fiscal
periods.

**HR** — all eight tabs; opening a payroll run; the leave queue.

**Everyone** — all seven personal surfaces; applying for leave; applying for a
kasbon; messaging head office.

**Elsewhere** — the manual, device topology, internal chat, the WhatsApp inbox.

Two things worth noting that are working quietly: the RBAC gates hold up under
a real walk (a Manager is correctly refused `purchasing.pr.create` while holding
`.approve`; a driver sees the delivery board but not the dispatcher tabs), and
the notification service is fanning out to the right people — the SMTP failures
in the log are `smtp.example.com`, the dev placeholder, not a wiring fault.

---

## 4. Notes for whoever runs this next

- **Warm the routes first.** Next dev compiles a route on first visit, and a
  cold `/dashboard` can exceed a 30s navigation budget. A cold run will show one
  or two spurious timeouts; CI builds for production and does not have this.
- **Bind-mounted source does not hot-reload on Windows.** Changes need
  `docker restart mimi-backend mimi-frontend` before the app is serving them.
  Two rounds of this run were spent measuring a stale bundle.
- **Do not let the simulation consume finite resources.** It filed leave against
  the same dates every run until the requests overlapped, and against the annual
  allowance until it hit 0 of 12 — both times reporting a working guard as a
  broken form. Leave dates are now unique per run; watch for the same shape
  anywhere else.
- **The run leaves data behind**, by design: `E2E-…` suppliers, employees, users
  and assets, `SIM…`-tagged waste, retur and petty cash, plus several stock
  opnames left in `counting` from the runs that could not complete one. Nothing
  is destructive; clean up when the demo data next gets reset.
