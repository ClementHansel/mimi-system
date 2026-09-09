# Client report, 2026-09-08 — "we approved the outlet's request and there is no way to create the Surat Jalan"

Reported after a session on **Monday 2026-09-07**: an outlet request was raised
and approved, and the Surat Jalan could not be built because "the list is gone
and not displayed".

---

## 1. What they actually hit, and why it is already gone

The Surat Jalan picker asked the API for replenishment requests in status
`approved` **only**. Gudang's approval queue offers exactly one button on a row
it has just approved — **"Mulai Pemrosesan"** — and pressing it moves the
request to `processing`. From that moment the request was invisible to the
picker, permanently: `approved → processing → shipped` is the documented order,
and picking the stock made the request unshippable.

That is defect #8 of `docs/FUNCTIONAL-TEST-2026-09-07.md`, fixed in `2675950`
(committed 2026-09-08 00:24, i.e. **after** the client's session) — the picker
now fetches both statuses. Verified live: production's own delivery bundle
requests `queue/warehouse?status=approved` _and_ `…?status=processing`.

`2675950` also fixed the other way this flow died — `SjCreateForm` sent
`unitId: l.itemId`, an item id into a column with a foreign key to `units`, so
every create failed on SQLSTATE 23503 and showed «Data ini masih terpakai di
dokumen lain». The unit is now derived from `items.base_unit_id` server-side.

**So the reported symptom is fixed and deployed.** Everything below is what was
still wrong underneath it.

### 1a. Confirmed against production — and there was no Monday request

Read-only queries on `mimi-prod` (owner-authorised, 2026-09-08 ~23:00 WITA):

- **No `replenishment_requests` row has `created_at` on 2026-09-07 at all.** The
  client raised nothing on Monday. What they were trying to ship was an EARLIER
  request — almost certainly **`RR/202609/0004`**, raised 2026-09-02, which has
  been sitting in **`processing`** ever since with `sj_id IS NULL`. That is this
  bug exactly: it reached `processing`, and the picker only asked for
  `approved`, so it was invisible from that moment on. It could not be shipped
  and it could not be found. (The identification is an inference from status and
  date; the statuses and the absence of a Monday row are facts.)
- **Not one Surat Jalan has ever been created through the app on production.**
  All 157 `surat_jalan` rows are seed data, numbered `SJ-YYYYMMDD-XXX-NN`; not a
  single row carries the app's own `SJ/YYYYMM/nnnn` document number, and every
  replenishment request in the database has `sj_id IS NULL`. Between the
  `status=approved`-only picker and the `unitId` FK crash, this flow had a 0%
  success rate in production until last night.
- **The client is walking the flow again tonight.** `RR/202609/0005`, `0006` and
  `0007` were raised between 21:59 and 22:53, and `0007` moved
  `awaiting_approval → approved → processing` while these queries were running.
  It got past the exact point that used to be a dead end, which is the fix
  working in their hands.
- **`0005` and `0006` are waiting on Gudang, not on a bug.** Both have
  `approval_steps` step 1 `supervisor` = approved, step 2 `kepala_gudang` =
  **pending**. The SJ picker correctly does not offer them: the outlet-side
  approval is step 1 of two, and until a Kepala Gudang approves at
  `/warehouse/approvals` the request is not shippable. This is worth saying to
  the client plainly — "we approved it" can mean step 1 only, and the screen
  that completes the chain belongs to a different role.

---

## 2. Fixed here

### 2a. The picker read one page of fifty, oldest first — so the newest approved request would have vanished again

`listApprovedRequests` sent no `page`/`pageSize`, taking the endpoint's
defaults: page 1, `pageSize` 50, `ORDER BY submitted_at ASC NULLS LAST`. That
order is right for the queue the endpoint was written for — Gudang's approval
list is FIFO work — and exactly wrong for this one.

A request only leaves `approved`/`processing` when its Surat Jalan is
dispatched, so the open set is a **backlog that grows**. The first time it
passed fifty rows, every newly approved request would have sorted past the cut
and simply not appeared — producing the client's exact complaint, from a
completely different cause, with nothing on screen to say so. This box already
holds 16 open requests; four outlets requesting daily reach fifty in weeks.

The picker now pages to the end of both statuses (`pageSize=200`, the
endpoint's own `@Max`) and sorts **newest first**, because the request a
dispatcher is looking for is the one they just approved. The server's ordering
is untouched.

### 2b. Any failed fetch rendered as "there are no approved requests"

All three of the dialog's fetches ended in `.catch(() => {})`. An expired
token, a 403, a 500, a dropped connection — `requests` stayed `[]` and the form
printed «Belum ada permintaan yang disetujui dan siap dikirim». A screen calmly
telling a dispatcher that the request they had just approved does not exist,
with nothing to distinguish that from an empty warehouse queue, no console
trace, and no retry short of closing and reopening the dialog.

This also means **the client's report could not be diagnosed from what they
saw** — the message they read was the same either way.

Now: in-flight renders as loading; a failed request queue replaces the form with
the real error and a **Coba Lagi** button; a failed driver/vehicle list only
gets a banner (the picker is still real and worth showing); and only a completed
fetch is allowed to say the queue is empty.

### 2c. The frozen/dry truck rule was never actually applied

`SjCreateForm`'s own doc comment claims mixing frozen and dry goods is
"structurally impossible to build" because the picker filters requests by the
chosen `shipmentType`. It was not filtering anything: §4.9's
`ReplenishmentLine` **did not carry `storageType`**, so every line read
`undefined`, the filter's "unknown storage type is compatible" fallback fired
for all of them, and **both truck tabs listed every open request**.

Proven on this box before the fix: `RR/202609/0132` (one line, Air Mineral
Botol, `dry`) was selectable on the _frozen_ truck, and
`POST /delivery/surat-jalan` answered

```
400 ERR_SHIPMENT_TYPE_MIX — Air Mineral Botol is 'dry' and cannot travel on a
'frozen' Surat Jalan (allowed: frozen, chilled) — FR-LOG-02
```

so this was a live second way to be unable to create a Surat Jalan: pick the
wrong tab, fill in the whole document, get refused.

The field is now on the line (contract + `findLines` + `findLinesForRequests`),
and an _undeclared_ storage type is treated as incompatible rather than waved
through. Requests that do not fit the chosen truck still **render**, disabled,
carrying «Tidak ada barang yang cocok dengan tipe pengiriman ini» — visible and
explained, never silently dropped.

Why it went unnoticed: `SjCreateForm`'s unit tests set `storageType` in every
fixture, so a green suite proved nothing about the real response.

### 2d. The create button refused without saying what was missing

`docs/FUNCTIONAL-TEST-2026-09-07.md` §2d called this "the button is never
disabled". That is the wrong way round — `disabled={!canSubmit}` has been on it
since the first commit. The actual defect is that nothing named the unmet
prerequisite: the inline vehicle error covered one cause of four, so a
dispatcher with three boxes filled in read a greyed-out button as a broken one.
It now lists what is still needed, derived from the same expression that gates
the button.

---

## 3. Found, NOT fixed — flagged

### 3a. A request already on a Surat Jalan is still offered for a second one

**FIXED on 2026-09-09**, per-line rather than per-request — see the commit
"Track Surat Jalan fulfilment per request LINE". The note below is kept because
it records why the obvious fix was the wrong one.

`create()` links the request (`replenishment_requests.sj_id`) but leaves its
status at `approved`; only marking the SJ **ready** moves it to `processing`.
Between those two steps the request is still in the picker, and `setSjLink` is
`WHERE sj_id IS NULL`, so a second SJ links nothing while still shipping the
same goods. `RR/202608/0004` on this box is `approved` with
`sjId = SJ/202609/0343`.

Not fixed by filtering out `sjId != null`, because that is wrong twice over: a
request whose Surat Jalan was **cancelled** would become unshippable forever
(`cancel()` never clears `sj_id`) — the very bug this report is about,
reintroduced — and a mixed frozen/dry request legitimately needs TWO Surat
Jalan, so "this request already has one" is not an error at all. The unit that
works is the LINE: `ReplenishmentLine.qtyCommitted` sums what live (non-
cancelled) Surat Jalan already carry, the picker offers the remainder, and
`create()`/`update()` refuse an over-commit.

### 3a-bis. The pending-approvals inbox cap (CORRECTION)

Reported here first as "the approvals inbox has the same defect as the SJ
picker". **That was overstated, and the record is worth correcting.** The inbox
paginates properly with an accurate total, and its oldest-first ordering is
right for what it is — an approval queue is FIFO work, so the longest-waiting
item belongs on page one. That is the opposite of the SJ picker, where the
dispatcher wants the request they have just approved. A local test failure
attributed to it turned out to have an unrelated cause (the request was still
`submitted`, its step-1 approval never having landed).

The one real sharp edge: `findPendingCandidates` caps the pre-filter fetch at
`PENDING_CANDIDATE_CAP` (2000) rows, oldest-first, and past that the NEWEST
pending steps are dropped before pagination — absent from every page while
`total` quietly agrees. Production holds 24, so it is a distant condition; but
it would have arrived invisibly. Fixed 2026-09-09 by fetching one row past the
cap and logging at ERROR when it is hit. Not redesigned: eligibility is resolved
per row in the service, so an exact total requires scanning every candidate
anyway, and raising the cap is a decision to take with numbers in hand.

### 3b. `submitted` requests are invisible to everyone but the outlet

`listWarehouseQueue` covers `awaiting_approval`/`approved`/`processing`. A
request sitting in `submitted` is waiting on its own **Supervisor**, by design —
but if approval mode for `REPLENISHMENT_REQUEST` is ever set to `auto`/`off`
(D-23, Owner-only), `submit()` still writes `status = 'submitted'` and nothing
advances the row, so it would be stuck where no warehouse screen can see it.
This box has `approval.mode` unset for this document type (so: `manual`, and
this cannot bite today), and 15 rows in `submitted`. Worth confirming with the
Owner that nobody has flipped it on production.

### 3c. The SMTP host is still hanging every operation that notifies

Unchanged from `docs/FUNCTIONAL-TEST-2026-09-07.md` §2e:
`tenant_email_settings.host = smtp.example.com`, `is_enabled = true`, no
timeout in front of it. Still filling the backend log, still on the critical
path of an approval.

---

## 4. How this was verified

- Backend, live DB: `replenishment` 33 passed, `delivery` 73 passed. The new
  test walks the full outlet → supervisor → Gudang chain and then asserts every
  line reports its real `items.storage_type` in the detail read, the office list
  **and** the warehouse queue — the three separate SELECTs that have drifted
  apart before.
- Whole backend suite: **1464 passed, 21 failed across 9 files** — all of them
  the §3c SMTP hang, and none of them these changes. The evidence, because one
  of the nine is `test/cross-kernel/replenishment.integration.spec.ts` and that
  name deserves more than an assurance:
  - it fails with `Test timed out in 30000ms` / `Hook timed out in 30000ms` and
    no assertion failure at all — the signature of waiting on DNS, not of a
    wrong value;
  - reverting `replenishment.repository.ts` and `replenishment.service.ts` to
    HEAD and re-running it **times out identically**, so the failure predates
    this work;
  - the other eight (`approvals`, `payroll`, `pos-*` ×3, `asset-lifecycle`,
    `stock-opname`) never read a replenishment line, and the two failing
    `approvals` cases are literally "the approver gets a notification" and "the
    requester is notified WITH the reason";
  - and two consecutive full runs of the SAME code disagreed — 25 failures
    across 9 files, then 23 across 10 — which only a race can do.
- Frontend: 963 tests / 133 files passed, plus the new specs. New coverage for
  the paging and ordering of the picker's source, the dialog's three load
  states, and the create button naming its unmet prerequisites.
- `@mimi/shared`: 338 passed.
- Real UI, Playwright against the dev stack as `gudang1`: a request approved
  minutes earlier appeared **at the top** of the picker, enabled on the cold
  truck and disabled (with a reason) on the ambient one, and `SJ/202609/0397`
  was created from it with zero failing API calls.

**For whoever reads a red backend suite next:**
`docs/FUNCTIONAL-TEST-2026-09-07.md` §2e records the SMTP damage as "18 tests
across 7 files". It is now 21–25 across 9–10 and moves between runs, so that
count is **not** a usable fingerprint for "nothing new is broken". Run the
module you touched on its own, and treat a bare 30s timeout with no assertion
failure as §3c until proven otherwise.
