# Mimi Chicken — Three-Tier Sync Protocol

**Status:** Wave 0 contract · **Owner:** architect (Wave 0B) · **Version:** 1.4
**v1.4 amendment (owner decision):** the offline approval credential is **unsigned in v1** — `base64url(JSON.stringify(claims))`, no Ed25519 — settling the code-vs-prose divergence both implementing agents flagged; §7.2 now carries the security reasoning (the server-side stored-row re-verification is the real control; a device-local signature does not raise the §7.1 skill floor) and the forward seam. §7.3's binding computation is now normative: joiner = **U+2016 `'‖'` (not ASCII `'|'`)**, `amountIdr` normalized to `''` by the caller — the two encoding divergences that would have failed every §7.4 check 2, pinned by cross-tier known-answer fixtures and §9 T-15 (x).
**v1.3 amendment:** §4.6 heartbeat storage corrected to `{usedMb, quotaMb}` (CONTRACTS §7.2 and W2-E's shipped code agree; this document's unit-less `{used, quota}` was the outlier). **Heartbeat field names settled the same way — shipped code wins:** `at`, `queueDepth`, `batteryPct` (CONTRACTS §7.2 ≡ W2-E runtime); the newly-frozen `SyncHeartbeatMessage`'s `ts`/`outboxDepth`/`battery` are the outliers this time and their three-name correction is routed to W1-B — W3-10 must build ingest against the settled names, not the pre-correction type. §4/§5.5 now reference the frozen wire types (`SyncHealthResponse`, `SyncDeliverMessage`, `SyncHeartbeatMessage`/`SyncHeartbeatAck`, `SyncChecksumMessage`, `SyncBootstrapRequest`/`SyncBootstrapPage`) **by name instead of restating their fields** — restatements drift, references cannot. Bootstrap page content resolved (events-shaped pages; synthetic-vs-real row semantics specified in §4.6). `cursorExpired` adopted as the hello-ack flag spelling (needs its one-line optional-field addition to `SyncHelloAck`).
**v1.1 amendment:** classified the D-18 statutory-payroll tables and the D-19 `cash_variance_proposals` table (all class X, matching CONTRACTS §2.9 NOT-SyncEntity set); §5.5 R7 names its D-19 output; §7.6 exclusion list and §8 row 27 extended accordingly. No wire-protocol change.
**v1.2 amendment (interop fix):** every wire example and literal field name now uses the **camelCase names of `@mimi/sync-protocol`'s frozen types** — earlier versions showed snake_case, and W2-F/W2-D built opposite readings from prose vs. types. The wire-naming rule is stated at the top of §2. Also: `sync:checksum` adopted as the R2 message name (W2-D), and §3.4's enforcement order corrected to class-before-op-vocabulary (W2-D finding — empty-op classes must reject as `authority_violation`, not `malformed`). Postgres columns remain snake_case in CONTRACTS DDL; semantics unchanged.
**Binding on:** W1-B (`packages/sync-protocol` — this document as executable data), W2-D (cloud sync engine, `backend/src/kernel/sync`), W2-E (device local runtime, `frontend/src/lib/local`), W2-F (branch node, `apps/branch-node`), and every Wave 3–5 module that mutates data (collision rule 6: *every mutation emits a sync event*).
**Locked decisions honored:** D-12 (three tiers, one protocol), D-13 (topology/heartbeat), D-16 (balances never synced), D-17 (offline authorization provisional), D-05 (`location_id` scoping, single tenant), D-11 (Asia/Makassar), D-18 (statutory payroll optional, online-only), D-19 (cash variance auto-proposes, never auto-deducts, never offline-authorizable).
**Companion:** `docs/CONTRACTS.md` owns DDL, enums, and endpoint shapes. Entity names here are the exact table names of BUILD-PLAN §4.1; where §4.1 abbreviates (`_lines`), this document uses the expansion `<parent-singular>_lines` (e.g. `replenishment_request_lines`, `stock_opname_lines`, `goods_receipt_lines`, `petty_cash_lines`, `payroll_runs`, `payroll_lines`). CONTRACTS.md must use the same expansions.

**The one-paragraph summary.** Every replicated change in the system is an append-only, idempotent **event** — a business fact with a client-minted UUID. Facts flow **up** from where they happened (device → node → cloud) and decisions/master data flow **down** (cloud → node → device). The protocol between any two adjacent tiers is identical (D-12). Nothing mutable is ever synced: state at every tier is a **local projection** of the fact stream, recomputed by the same pure functions in `packages/sync-protocol` / `packages/shared`. Stock balances are the flagship case (D-16): they are never on the wire, only derived. Conflicts are therefore rare by construction; the ones that remain (§5) are detected at apply time on the cloud and routed to human queues, never silently merged.

---

## §1 Tier model

### 1.1 The three tiers

| | Tier 1 — Device | Tier 2 — Branch node (OPTIONAL) | Tier 3 — Cloud VPS |
|---|---|---|---|
| **Runtime** | PWA (Next 15) + service worker + IndexedDB (`idb`) | Node 22 service + embedded Postgres 16 on the outlet LAN | NestJS + Postgres 16, canonical |
| **Examples** | POS tablet, driver phone, employee phone (F11), outlet laptop | One mini-PC per outlet, where the client has bought one | The VPS |
| **Network posture** | Talks HTTPS/socket.io to exactly one upstream at a time | **One outbound socket.io connection to cloud. Never an inbound WAN port.** Serves LAN devices on a local HTTPS listener. | Terminates all sockets; public |
| **Stores** | (a) durable **outbox** of locally-originated events, (b) read cache: master-data projection + own-location operational events (14-day window), (c) local projections (stock per area, open shift, open documents), (d) cached offline credentials (§7), (e) per-upstream cursors | (a) full event log for its location (90-day window) + global master data, (b) **relay outbox** of device events not yet cloud-confirmed, (c) local projections for LAN fan-out, (d) per-device cursors for the devices it serves | (a) canonical `sync_events` log (partitioned, kept forever), (b) canonical relational state (the ~95 tables), (c) per-subscriber `sync_cursors`, (d) `sync_conflicts`, `offline_authorizations` |
| **Allowed to decide** | Capture of facts: complete a sale, record attendance, count opname lines, receive an SJ drop, record waste/petty cash, submit a request. Offline-**provisional** approvals only within a valid cached credential (§7). Local receipt numbering (§1.5). | **Nothing of business.** Envelope validation, durable store-and-forward, LAN fan-out of events between sibling devices, LAN discovery (mDNS/SSDP/TCP probe), its own heartbeat/telemetry. Payloads are opaque to the node except a whitelisted projection set (§1.4). | Everything canonical: authority enforcement (§3), business validation, online approvals, payment verification, document numbering for cloud-born documents, projections (stock ledger via `StockLedgerService`, GL posting), conflict detection, reconciliation jobs, credential minting/revocation. |
| **Never does** | Edit master data offline; decide anything in a cloud-only scope (§3 class M/X); trust its own clock (§6) | Originate business documents (it has no UI); rewrite or renumber relayed events; open inbound WAN ports; store photo binaries | Trust `occurredAt`; overwrite a fact; silently resolve a conflict |

**Tier 2 is optional (RISK-P5).** Every statement in this document holds with the node absent: a device whose location has no paired node simply has `upstream = cloud` at all times, and `accepted` ≡ `confirmed` (§4.3). No message, field, or state below exists only when a node is present, except the node-specific ones explicitly marked *(node only)*. Implementation agents must not code any path that assumes a node exists.

### 1.2 Topology and roles

```
                    ┌─────────────── Tier 3: CLOUD (canonical) ───────────────┐
                    │  sync_events (forever) · projections · conflicts · GL   │
                    └───────▲──────────────────────────────▲──────────────────┘
                            │ socket.io /sync (outbound     │ socket.io /sync
                            │ from node) + HTTPS fallback   │ + HTTPS fallback
              ┌─────────────┴───────────┐                   │
              │ Tier 2: BRANCH NODE     │                   │
              │ (optional, per outlet)  │            ┌──────┴───────┐
              │ relay + LAN fan-out     │            │ Tier 1 device│  ← outlet with NO node:
              └─────────────▲───────────┘            │ (POS tablet) │    device talks to cloud
                            │ socket.io /sync         └──────────────┘    directly
                            │ over LAN HTTPS
              ┌─────────────┴───────────┐
              │ Tier 1 devices          │
              │ POS tablets · driver &  │
              │ employee phones · laptop│
              └─────────────────────────┘
```

In every adjacent pair there is a **downstream** (client: initiates the connection, pushes its origin events, pulls its subscription) and an **upstream** (server: accepts pushes, serves pulls, issues acks). A branch node plays *both* roles simultaneously: downstream toward cloud, upstream toward its LAN devices. The message set (§4) is identical in both pairings — that is the operative meaning of D-12. `packages/sync-protocol` exports one set of message types used by all three agents.

### 1.3 Upstream selection (device side)

A device knows at most two upstream candidates, in preference order:

1. **Paired node URL** — learned from cloud at pairing time (the cloud holds `branch_nodes.lan_url` per location) and cached in IndexedDB. Not discovered via mDNS: browsers cannot do mDNS. If the location has no node, this candidate is absent.
2. **Cloud URL** — the app origin.

Selection algorithm (runs in the W2-E runtime):

- A candidate is **healthy** if `GET <base>/sync/v1/health` answers within **3 s** with a `SyncHealthResponse` whose `ok` is true and whose `protocolV` is compatible (§4.8).
- On startup and on any connectivity change event, probe candidates in preference order; connect the sync channel to the first healthy one.
- **Fail away** from the current upstream only after **3 consecutive failures** spanning ≥ 10 s (a single dropped request must not cause a switch).
- **Fail back** to the higher-preference candidate (the node) only after it has been continuously healthy for **60 s** (hysteresis; prevents flapping on a struggling mini-PC).
- Exactly **one** sync upstream at a time. Push and pull always use the same upstream. Cursor bookkeeping per upstream is independent (§4.5), and event-id idempotency makes a switch safe mid-stream: anything double-delivered across the switch deduplicates.
- The choice governs the **sync channel only**. Ordinary REST API calls (dashboards, admin screens) always target the cloud and simply fail offline; the app's online/offline UI state is derived from *cloud* reachability, and a separate `SyncStatusPill` state shows *upstream* reachability (`synced / syncing / queued(n) / offline`).

**LAN HTTPS reality (binding on W2-F + W1-A).** A PWA served from an HTTPS origin cannot call a plain-HTTP LAN address (mixed content). Therefore the node's LAN listener MUST be HTTPS with a certificate browsers accept. Mechanism: each node gets a public DNS name `<node-id>.node.<app-domain>` whose A record points at its **LAN** IP; the cloud performs DNS-01 ACME issuance for that name and delivers cert+key to the node over the paired socket (rotated at 60 days; ≥ 30-day validity runway survives long cloud outages). Residual risk: consumer routers with DNS-rebind protection may refuse to resolve a public name to a private IP — the install runbook (W7-02) must include the router allowlist step, and the device runtime treats a node that never becomes healthy as absent (graceful degradation to cloud-direct).

### 1.4 What the node applies vs. relays opaquely

The node stores and forwards **all** events verbatim (§4.4) but *applies* (projects into its local Postgres for LAN fan-out and local aggregates) only a whitelist:

| Applied by node | Why |
|---|---|
| All master-data pull events (§3 class M) | Serve catalog/config to LAN devices when cloud is down |
| `sales`, `pos_shifts`, `void_refunds`, `online_orders` | Intra-outlet visibility: second tablet sees first tablet's shift/sales |
| `sj_drops` receipts, `goods_receipts`, `waste_records`, `stock_opname*`, `stock_adjustments`, `returns` | Node-local derived stock view per storage area (same pure projector as device/cloud) |
| `replenishment_requests` + decisions | Outlet staff see request status on any device |
| `attendance` | Supervisor sees today's check-ins on LAN |

Everything else (payload versions it does not understand included) is **opaque store-and-forward**: the node never rejects an event for payload reasons, only for envelope reasons (§4.4). This keeps node deploys off the critical path of schema evolution — only cloud and device app versions must understand payloads.

### 1.5 Identity, numbering, and origin rules

- **`originDeviceId` identifies one durable local store (one installation).** A wiped/reinstalled PWA or a re-imaged node registers as a **new** device id and its `clientSeq` restarts at 1. The device registry (M21) links successive installations of the same physical device for display; the sync layer never reuses an origin id. This removes the need for epoch columns and makes `(originDeviceId, clientSeq)` eternally unique. *(Coordination note for CONTRACTS.md: `devices` needs a `replaces_device_id` or physical-identity grouping for the registry UI; sync only needs the id.)*
- The **node is also an origin** (its discovery/telemetry events). `originDeviceId` for node-born events is the node's registry id; `originTier = 'node'`. Cloud-born events (master-data edits, decisions) use `originTier = 'cloud'` and the well-known origin id `00000000-0000-0000-0000-0000000000c1` with a cloud-maintained `clientSeq` sequence — the cloud is just another (privileged) origin, so one apply path serves all three tiers.
- **Human-facing document numbers.** Cloud-born documents (surat jalan, PO) are numbered by the cloud sequence at creation — no offline issue arises. Device-born printed documents (POS receipts) use an **origin-scoped number** `<outlet-code>/<device-code>/<shift-seq>` assigned locally and **final** — a printed nota is never renumbered on sync (renumbering a printed receipt is itself a fraud surface). Global reporting keys off `eventId`/`sale id`, never off receipt numbers.
- **Actor vs. transport.** Sync transport authenticates the *device* (long-lived device credential minted at pairing/registration — M01/M21). The *actor* (user) travels in the event envelope meta and is re-verified by the cloud at apply time (§7 for the offline-approval case). This split is what lets a device with an expired user JWT still drain its outbox, and lets the node accept device pushes while the cloud is unreachable.

---

## §2 Event shape

> **Wire naming rule — read this before writing any codec, in any tier.**
> The wire uses the **camelCase field names of `@mimi/sync-protocol`'s frozen types** (`SyncEventEnvelope`, `SyncPushBatch`, `SyncPushAck`, `SyncHelloRequest`/`SyncHelloAck`, `SyncScope`, `SyncPullResult`, `SyncPayload`): `eventId`, `originTier`, `clientSeq`, `acceptedThrough`, `confirmedThrough`, … Every JSON example in this document shows the wire form. Postgres columns in CONTRACTS.md's DDL are the snake_case equivalents (`eventId` ↔ `event_id`); that mapping is mechanical and total, and the conversion happens at each tier's own DB boundary — **never on the wire**.
> **The only wire-vs-type difference in the entire protocol: `clientSeq` is `bigint` in memory and travels as a DECIMAL STRING on the wire** (JSON has no bigint). Convert exclusively via the package's `parseClientSeq` / `formatClientSeq` — never hand-roll `String(seq)` / `BigInt(str)` at a call site.
> Enum-like **values** are data, not field names, and stay exactly as written: entity names (`sj_drops`), ops (`approved_offline`), reject codes (`authority_violation`), statuses (`pending_verification`), permission keys (`pos.cash_variance.approve`), settings keys.

### 2.1 The `sync_events` row

One shape at every tier (IndexedDB object store on device, PG table on node and cloud — cloud's is block `120–129`, canonical DDL in CONTRACTS.md). Field names below are the wire/type names; the PG columns are their snake_case twins per the rule above:

| Field | Type | Written by | Semantics |
|---|---|---|---|
| `eventId` | `UUID` (v7) PK | origin | **The idempotency key.** Minted once, before first transmission (§2.2). Never regenerated, never reused. Upstreams enforce uniqueness; a duplicate arrival is acked as accepted and discarded. |
| `originTier` | `'device' \| 'node' \| 'cloud'` | origin | Which tier minted it. |
| `originDeviceId` | `UUID` | origin | Installation id per §1.5. With `clientSeq`, forms the ordering key. |
| `locationId` | `UUID \| null` | origin | Scope (D-05). `null` = global (master data visible to all subscribers). Device-born events always carry the device's paired location; cloud rejects a mismatch (`authority_violation`). |
| `entity` | `TEXT` | origin | **Exact table name from BUILD-PLAN §4.1** (= `SyncEntity` enum in `packages/shared`). E.g. `sales`, `sj_drops`, `attendance`. Entity values keep their snake_case table spelling — they are data. |
| `entityId` | `UUID` | origin | Client-minted id of the business record the fact is about (the sale id, the sj_drop id, …). For child-embedding events this is the *parent* id. |
| `op` | `TEXT` | origin | Past-tense fact verb from the per-entity vocabulary in §3.3 (`completed`, `received`, `approved_offline`, …). `(entity, op)` selects the payload schema. |
| `payload` | `JSONB` | origin | Versioned envelope, §2.3. Hard cap **256 KB**; photo/signature binaries are never inline (§4.7). |
| `clientSeq` | `BIGINT` column; `bigint` in memory; **decimal string on the wire** | origin | **Gapless, monotonic per origin**, assigned from a local counter in the same durable transaction as the event (§2.2). PG index: `UNIQUE (origin_device_id, client_seq)`. The ordering authority (§6). Wire conversion only via `parseClientSeq`/`formatClientSeq`. |
| `occurredAt` | `TIMESTAMPTZ` | origin | Device wall clock, offset-corrected per §6.2. **Advisory** — display and business-date assignment, never ordering. |
| `receivedAt` | `TIMESTAMPTZ` | each tier locally | Stamped by the tier that owns this copy of the row when it durably stored it. The cloud's `receivedAt` is *the* canonical receipt time. Not carried on the wire. |
| `relayReceivedAt` | `TIMESTAMPTZ \| null` | first non-origin tier | Stamped by the **first** upstream that durably stored the event (node when present, else equals cloud `receivedAt`). Carried on the wire once set; the cloud persists it. This is the earliest *server-grade* timestamp and the defensibility bound for attendance/shift-close (§6.4). |
| `relayedViaNodeId` | `UUID \| null` | cloud | Which node relayed it (observability; `null` for device-direct or cloud-born). |
| `actorUserId` | `UUID` | origin | Who did it. Duplicated from meta into a column at cloud for indexing/audit. |
| `schemaV` | `SMALLINT` | origin | Copy of `payload.v` for cheap filtering. |

Cloud-only bookkeeping columns (`applied_at`, `apply_status ∈ ('applied','quarantined','superseded','pending_dependency')`, `batch_id → sync_batches`) are W2-D's to define in CONTRACTS.md; they are not protocol surface.

### 2.2 Idempotency-key derivation — the atomic outbox rule

A retried write is provably the same event because the id is bound to the action **before** any transmission is possible:

1. When the user commits an action (taps *Bayar*, *Terima*, *Simpan hitungan*), the W2-E runtime executes **one IndexedDB transaction** that atomically: (a) mints `eventId = uuidv7()`, (b) increments the durable per-device `clientSeq` counter and assigns it, (c) writes the event row to the `outbox` store, and (d) applies the local projection (e.g. marks the sale completed locally). Commit of this transaction *is* the acceptance of the action. If it fails (quota, crash), the action visibly did not happen — the UI must not print a receipt or show success (§9 T-08, T-09).
2. Every transmission, first or retried, **reads the event from the outbox**. There is no code path that re-mints an id for the same action. Transport-level retries resend byte-identical events; only `batchId` (transport wrapper, §4) differs.
3. **Double-tap guard:** interactive flows bind the id even earlier — the cart/draft record gets its `entityId` (and, at commit, its `eventId`) so that two rapid submits of one draft race on the same IndexedDB key and cannot enqueue twice. Submitting a *new* identical-looking action after a completed one is a new fact by design (two identical sales are legal).
4. Uniqueness is enforced upstream twice: the PG constraints `PRIMARY KEY (event_id)` (idempotency) and `UNIQUE (origin_device_id, client_seq)` (outbox-corruption detector). An arrival whose `eventId` is new but whose `(originDeviceId, clientSeq)` pair is taken indicates a corrupted/cloned local store → permanent reject `seq_conflict`, quarantine, alert (§4.4) — never silent overwrite.
5. UUIDv7 is required (time-ordered: keeps the cloud PK index append-mostly). Consumers must not *parse* meaning out of the id.

### 2.3 Payload envelope and versioning

```jsonc
{
  "v": 1,                          // schema version of (entity, op), integer
  "data": { /* the fact */ },      // shape defined per (entity, op) in packages/sync-protocol
  "meta": {                        // = SyncPayloadMeta in @mimi/sync-protocol
    "actorUserId": "…",            // required on every event
    "actorRole": "kasir",          // role at the time of action (informative; cloud re-checks)
    "appVersion": "1.4.2",
    "deviceLabel": "Kasir 1",      // informative
    "clockOffsetMs": -1250,        // last measured offset vs upstream at stamping time (§6.2)
    "rawDeviceTime": "…",          // uncorrected wall clock at capture (§6.2)
    "authorization": { … }         // OfflineAuthorizationMeta; present iff offline-provisional approval, §7.3
  }
}
```

Versioning rules (binding on W1-B, who owns the schema registry in `packages/sync-protocol`):

- `v` is scoped **per `(entity, op)` pair**, starting at 1.
- **Additive-only within a version**: new optional fields may appear without a bump; every consumer MUST ignore unknown fields and MUST preserve them when re-serializing (nodes relay verbatim anyway).
- A breaking change (field removal, meaning change, type change) requires either a **new `op` name** (preferred — old facts remain replayable forever) or a `v` bump with a **translator registered at the cloud** (`v(n) → v(n+1)` pure function; the canonical log keeps the original, projections use the translated form).
- **Deploy order:** cloud understands new versions first, devices second, nodes never need to (opaque relay, §1.4). The cloud MUST accept all versions ever shipped; a device receiving a pulled event with `v` above its supported range applies what it can or, if the entity is projection-critical (master data), surfaces the "update app" banner — it never discards the event from its cache.
- Fact payloads are **complete documents**, not row diffs: `sales.completed` embeds its `sale_lines` and `sale_payments`; `stock_opname.area_counted` embeds the count lines for one storage area. The receiving tier's projector explodes children into rows transactionally. This is what makes one event = one atomically-appliable business fact, and it is why child tables in §3 are marked *embedded*.

---

## §3 Authority matrix

### 3.1 How to read it

- **Class** — governs the default rules:
  - **M — Master data.** Cloud-authoritative. Pull-only. **Read-only offline, no exceptions**: a device MUST NOT emit events for these entities; the cloud sync engine rejects any such push as `authority_violation` (permanent). Conflict: impossible (single writer).
  - **F — Operational fact.** Authoritative at the origin location, append-only, **push-only**. The cloud can refuse to *apply* (quarantine) but never edits a fact. Conflict: impossible at the row level (dedupe by `eventId`); *semantic* duplicates are detected at apply time per the rules column.
  - **B — Bidirectional document.** Created/acted-on at the edge (push), decided/advanced at the cloud (pull). The document state machine lives in CONTRACTS.md; sync moves its transition events both ways. Conflict: decision events can race — resolved per §5.3 (*online > offline-provisional; else first-at-cloud wins; material divergence → conflict queue*).
  - **D — Derived. Never on the wire.** Each tier recomputes from the fact stream with the shared pure projector. This is D-16 generalized: it covers `stock_balances` AND `stock_movements` AND GL. Divergence between tiers is detected by checksum probes (§5.5 R2) and raises a reconciliation exception — never a sync.
  - **X — Cloud-only.** Exists only at Tier 3; reachable exclusively through online APIs; never in any subscription scope. Offline, the owning UI surface is blocked (§8).
  - **T — Telemetry.** Push, loss-tolerant, latest-wins, outside the durable outbox (own lightweight channel, §4.6). Not idempotency-tracked.
- **Direction** — `pull` (cloud→down), `push` (origin→up), `push↑ / decision↓` (class B), `—` (never on wire).
- **Pull scope** — what a *device* subscription receives (§4.2); a *node* receives the superset "global M + everything for its location". `global` = all subscribers; `own location` = rows/events with the subscriber's `locationId`; `assigned` = dynamic per-user scope evaluated at fan-out; `projected` = field-filtered per §3.2; `none` = not in device scope.

### 3.2 Sensitive-field projections (binding on W2-D fan-out)

Pull payloads for these entities are **re-projected** before leaving the cloud — the canonical row is never shipped whole:

| Entity | Device receives | Never leaves cloud |
|---|---|---|
| `users` | id, name, role, active, location ids, **PIN verifier hash** (argon2id; for offline unlock of users assigned to that location — M01 offline credential minting) | password hash, email/phone, session data |
| `employees` | id, name, position, location, active (roster for supervisor/attendance views) | salary config, bank/KTP/personal data, loan state |
| `suppliers` / `supplier_items` / `supplier_price_history` | **nothing** (class X — FR-SUP-06 role-locked pricing; purchasing surfaces are online-only) | everything |
| `locations` | own location full; all others: id, name, city (directory for SJ display) | costing/config of other locations |
| `notifications` | only rows addressed to users of the subscribing device's location | others' notifications |

### 3.3 The matrix — all §4.1 tables (+ the D-18/D-19 amendment tables per CONTRACTS Amendments 1–2)

Op vocabularies listed as `entity.op`; for a *pushable* entity these are the only ops the cloud accepts (anything else → `malformed`). Never-pushable classes (M/X/D/T) reject as `authority_violation` before any op check — §3.4 step 2. *(embedded)* = no events of its own; travels inside its parent's payload (§2.3). Payload field names shown in `{…}` are wire names (camelCase, §2 rule).

**Group 1 — Identity, org, config (block 001–009)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `locations` | M | Cloud | pull | global, projected | `created`, `updated`, `deactivated`. No conflict possible. |
| `storage_areas` | M | Cloud | pull | own location | `created`, `updated`, `deactivated` (D-15 areas + temp ranges; devices need them for opname/receiving UI). |
| `users` | M | Cloud | pull | own location, projected | `created`, `updated`, `deactivated`, `pin_rotated`. Offline edit forbidden. |
| `roles` | M | Cloud | pull | global | `updated`. |
| `permissions` | M | Cloud | pull | global | `updated`. |
| `role_permissions` | M | Cloud | pull | global | `updated`. Local RBAC gating offline uses this cache; cloud remains the enforcement authority on apply. |
| `user_locations` | M | Cloud | pull | own location | `assigned`, `revoked`. |
| `sessions` | X | Cloud | — | none | Auth artifact. Never synced. |
| `audit_log` | X | Cloud | — | none | Written by the `@Audited()` interceptor when events are **applied** at cloud (device-born facts get their audit rows at apply time, actor = `actorUserId`, with `offline_authorized` visibility). Never synced down. |
| `attachments` | F* | Origin | side-channel | own location (metadata) | Metadata row rides inside the owning event's payload as `attachmentRef {sha256, size, mime, kind}`; the binary travels the §4.7 side-channel. Duplicate upload of same sha256 is a no-op. |
| `notifications` | — | Cloud | pull | addressed, projected | `issued`, `read` (read-marks push up as `notifications.read_marked` facts — the one exception; loss-tolerated). Best-effort; not part of state convergence. |
| `settings` | M | Cloud | pull | global | `updated` (thresholds, geofence radius, cold-chain limits — devices need them offline). |

**Group 2 — Catalog (block 010–019)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `item_categories` | M | Cloud | pull | global | `created`, `updated`, `deactivated`. |
| `units` | M | Cloud | pull | global | same. |
| `unit_conversions` | M | Cloud | pull | global | same. |
| `items` | M | Cloud | pull | global | same. |
| `products` | M | Cloud | pull | global | `created`, `updated`, `deactivated`, `price_changed`. A sale captured against a price that changed mid-offline is **valid as sold** — see `sales` rule + §5.5 R4. |
| `recipes` | M | Cloud | pull | global | `updated` (BOM; devices derive FR-POS-06 usage estimates locally). |
| `recipe_lines` | M | Cloud | pull | global | *(embedded in `recipes.updated`)*. |
| `suppliers` | X | Cloud | — | none | Role-locked (FR-SUP-06). Online surfaces only. |
| `supplier_items` | X | Cloud | — | none | same. |
| `supplier_price_history` | X | Cloud | — | none | same. |

**Group 3 — Stock (block 020–029). D-16 territory — read twice.**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `stock_balances` | **D** | Derived at every tier | **— NEVER SYNCED** | — | Each tier computes balance per `(location_id, storage_area_id, item_id)` from applied facts via the shared projector (cloud's projector is `StockLedgerService`, D-07). Divergence → §5.5 R1/R2 reconciliation exception, **never an overwrite** in either direction. |
| `stock_movements` | **D** | Derived at every tier | **— never synced** | — | Movements are *outputs* of applying facts (a receipt, a sale's recipe consumption, an approved adjustment), produced identically at each tier by the same pure function. Syncing them would double-apply. Cloud's rows (written by `StockLedgerService`) are canonical for reporting. |
| `min_stock_rules` | M | Cloud | pull | own location | `updated`. Low-stock detection runs at cloud; device may pre-warn from cache. |
| `stock_opname` | F/B | Origin location | push↑ / decision↓ | own location | Push: `opened`, `area_counted` (embeds that area's lines), `submitted`, `cancelled`. Pull: `approved`, `rejected` (cloud decisions; supervisor offline approval NOT allowed for opname — counting is offline, adjudication is online-only). Conflict: duplicate count for same `(opname_id, storage_area_id, item_id)` from different events → §5.2 C1 conflict queue. |
| `stock_opname_lines` | F | Origin location | *(embedded)* | — | Inside `area_counted`. |
| `stock_adjustments` | B→pull | **Cloud only decides** | pull | own location | `posted` (cloud-born, after opname/manual approval). Devices/nodes apply it to their derived stock. Never device-born: an offline "adjustment" does not exist — count facts do. |
| `stock_reconciliations` | X | Cloud | — | none | Output of §5.5 jobs; viewed in F12 online. |

**Group 4 — Replenishment & logistics (block 030–039)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `replenishment_requests` | B | Outlet creates; upstream decides | push↑ / decision↓ | own location | Push: `submitted` (embeds lines), `cancelled`, `supervisor_approved` / `supervisor_approved_offline` (§7), `supervisor_rejected`. Pull: `warehouse_approved`, `warehouse_rejected`, `amended` (with reason — FR-LOG-13), `fulfillment_started`, `shipped`, `completed`. **Decision always wins over request-side edits; online decision always wins over offline-provisional (§5.3).** |
| `replenishment_request_lines` | B | as parent | *(embedded)* | — | Inside `submitted` / `amended`. |
| `surat_jalan` | B | **Cloud (warehouse) creates** | pull; receipt/driver facts push | own location + driver-assigned | Pull: `issued` (full document: drops, lines, seals), `updated`, `cancelled`. SJ numbers are cloud-assigned at issue — no offline numbering problem exists. |
| `sj_drops` | B | Cloud creates; outlet receives; driver progresses | push↑ (facts) / pull↓ (doc) | own location + driver-assigned | Push (driver): `departed`, `arrived`. Push (outlet): `received` — the receiving fact: per-line received qty, discrepancy notes, photo ref (FR-LOG-15 wajib), signature ref, seal check, temp reading. **Discrepancy is data, not conflict** (BUILD-PLAN sketch, locked). Conflict: **second `received` for the same `sj_drop_id`** → §5.2 C2: first-at-cloud applies, second quarantined to conflict queue; stock effect posted once. |
| `sj_lines` | B | Cloud | *(embedded)* | — | Inside `issued`; received qtys inside `received`. |
| `sj_temperature_logs` | F | Origin (driver device / warehouse at load) | push | driver-assigned + own location | `logged {dropId?, point: load\|drop, tempC}`. Append-only; cold-chain breach evaluation is a cloud rule (settings-driven) feeding notifications, not a conflict. |
| `sj_seals` | B | Cloud (applied at load) | pull; verification inside `received` | own location + driver-assigned | `applied` (cloud-born). Drop-side seal verification is a field of `sj_drops.received`. Mismatch = data (exception report), not conflict. |
| `drivers` | M | Cloud | pull | assigned (own record) + referenced via SJ payload denormalization | `created`, `updated`, `deactivated`. |
| `vehicles` | M | Cloud | pull | referenced via SJ payload | same. |
| `goods_receipts` | F | Origin location | push | own location | `recorded` (embeds lines; photo wajib) — **used for supplier-direct-to-outlet receiving only** (PRD 8.6.1). SJ receiving is `sj_drops.received`; PO receiving is `po_receipts` (class X). Cloud may materialize unified receipt rows from all three for reporting — a projection, not a sync concern. Conflict: duplicate receipt suspicion → §5.5 R5 exception, not auto-reject. |
| `goods_receipt_lines` | F | Origin | *(embedded)* | — | Inside `recorded`. |
| `shipment_types` | M | Cloud | pull | global | `updated` (frozen/dry split config, FR-LOG-02). |

**Group 5 — Purchasing & petty cash (block 040–049)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `purchase_requests` | X | Cloud | — | none | Warehouse/purchasing laptops, online-only surfaces (F05/F06). |
| `purchase_orders` | X | Cloud | — | none | same. PO numbers cloud-assigned. |
| `po_lines` | X | Cloud | — | none | same. |
| `po_receipts` | X | Cloud | — | none | Warehouse receiving is an online act (HQ connectivity assumed; see §8 rationale). |
| `petty_cash` | B | Outlet records; finance verifies | push↑ / decision↓ | own location | Push: `recorded` (embeds lines; bukti foto + barang foto wajib). Pull: `verified`, `rejected` (finance, online-only — never offline-approvable, §7.6). |
| `petty_cash_lines` | B | as parent | *(embedded)* | — | Inside `recorded`. |

**Group 6 — POS (block 050–059)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `pos_shifts` | F | Origin device | push | own location | `opened {openingFloat}`, `closed {countedCash, declaredTotals}`. A shift belongs to `(device, cashier)` — two tablets cannot open "the same" shift, so no cross-device conflict exists by construction. Cloud recomputes expected totals from that shift's sales; variance vs declared → §5.5 R7 exception (kasir selisih), not a conflict. |
| `sales` | F | Origin device | push | own location *(for node fan-out; devices ignore others' sales except shift views)* | `completed` — one event per sale, embeds `sale_lines` + `sale_payments`. **No conflict possible**: dedupe by `eventId`. Sold-at price is contractual fact even if catalog changed mid-offline; price variance beyond tolerance → R4 exception report, never rejection. Cancellation before completion is local-only (no event); after completion it is a `void_refunds` flow. |
| `sale_lines` | F | Origin | *(embedded)* | — | Inside `completed`. |
| `sale_payments` | F/B | Origin records; finance advances status | *(embedded)* + decision↓ | own location | Recorded inside `completed` with `status = paid (cash) \| pending_verification (QRIS static/transfer)`. Status transitions (`payment_verifications`) are cloud-born pulls. |
| `void_refunds` | B | Origin requests; supervisor decides (D-17-eligible) | push↑ / decision↓ | own location | Push: `requested`, `approved_offline` (§7 — credential + PIN (+ selfie ≥ threshold)), `executed {cashReturned}`. Pull/push: `approved` (online), `rejected`. Conflict: offline+online double decision → §5.2 C3. `executed` without surviving approval → finance exception queue (§7.5). |
| `online_orders` | F | Origin device | push | own location | `recorded` (order id, platform, gross, discounts, platform fee, net received, status, date — FR-POS-07), `status_updated`. Duplicate platform-order-id across devices → R5 exception (informative), both facts kept. |
| `cash_variance_proposals` | X | Cloud | — | none | **Cloud-born** at apply of `pos_shifts.closed` when R7 finds a drawer shortfall beyond `settings pos.cash_variance_propose_above` (D-19, CONTRACTS Amendment 2): a *pending* payroll-deduction proposal. Decided **online only** (`pos.cash_variance.approve`; reason required on approve and reject), explicitly **not** in §7.6 offline scopes, never auto-deducted. Never on the wire — a device push is `authority_violation`; the kasir learns of the proposal via `notifications` pull, not via this entity. |

**Group 7 — HR & payroll (block 060–069)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `employees` | M | Cloud | pull | own location, projected (§3.2) | `created`, `updated`, `deactivated`. |
| `employments` | X | Cloud | — | none | Salary-bearing. Online only. |
| `work_shifts` | M | Cloud | pull | own location | `updated` (shift templates). |
| `shift_assignments` | M | Cloud | pull | own location | `assigned`, `changed`, `removed`. Supervisor edits schedules **online only** (laptop surface F08); devices display cache. |
| `attendance` | F | Origin device (employee phone) | push | own location | `checked_in {gps, geofenceOk, selfieRef}` (FR-HR-01), `checked_out {…}`. Geofence pre-validated locally against cached outlet coords; cloud re-validates. Conflicts: literal retry dedupes; overlapping/second check-in same day → §5.2 C4 HR exception. Clock defensibility per §6.4. |
| `leave_requests` | B | Employee submits; HR/supervisor decides | push↑ / decision↓ | own user | Push: `submitted`, `cancelled`. Pull: `approved`, `rejected`. Decisions online-only (not in §7.6 offline scopes). |
| `salary_components` | X | Cloud | — | none | Online only. |
| `employee_loans` | X | Cloud | — | none | Online only (kasbon lifecycle is finance's). |
| `payroll_periods` | X | Cloud | — | none | Online only. |
| `payroll_runs` | X | Cloud | — | none | Online only. |
| `payroll_lines` | X | Cloud | — | none | Online only. Slip gaji delivery is n8n/notification, not sync. |
| `bpjs_configs` | X | Cloud | — | none | Statutory config (D-18, CONTRACTS Amendment 1): effective-dated BPJS programme rates. Online surfaces only, gated by the D-18 settings flag; a device push is `authority_violation`. |
| `pph21_ter_rates` | X | Cloud | — | none | PPh21 TER monthly withholding brackets (D-18). Same rule. |
| `pph21_ptkp` | X | Cloud | — | none | PTKP codes → TER category mapping (D-18). Same rule. |
| `pph21_article17_brackets` | X | Cloud | — | none | Annual Art. 17 progressive brackets — December true-up (D-18). Same rule. |
| `employee_tax_profiles` | X | Cloud | — | none | Per-employee tax/BPJS profile (D-18). Salary-adjacent: never device-cached, same stance as §3.2 `employees` exclusions. |

*CONTRACTS-level detail tables of X-class parents (`employee_salary_components`, `employee_loan_payments`) are class X by inheritance — a child of an entity that never travels the wire never travels it either. They are listed here for completeness, not as new classifications.*

**Group 8 — Assets (block 070–079)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `assets` | M | Cloud | pull | own location | `created`, `updated`, `retired` (PIC needs the asset list offline, F09 mobile). |
| `maintenance_schedules` | M | Cloud | pull | own location | `updated`. Reminders are cloud-generated notifications. |
| `maintenance_jobs` | B | Cloud schedules; PIC executes | push↑ (execution) / pull↓ (job) | own location | Pull: `created` (due job). Push: `completed {photoRef (FR-PMS-04), notes, cost?}`. Verification (`verified`) is an online supervisor act. |
| `service_history` | D | Cloud-derived from `maintenance_jobs` facts | pull (read view) | own location | Projection; devices may cache for display. No independent ops. |

**Group 9 — Waste & returns (block 080–089)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `waste_records` | B | Origin reports; supervisor/kepala-gudang approves (D-17-eligible for outlet supervisor step) | push↑ / decision↓ | own location | Push: `reported {reason, qty, condition, photoRef (FR-WST-01 wajib)}`, `approved_offline` (§7, outlet scope only). Pull: `approved`, `rejected`. Stock effect derives **only after approval** (strict: an unapproved waste report moves nothing). Conflict: double decision → C3. |
| `returns` | B | Outlet→gudang: outlet submits, gudang receives. Gudang→supplier: cloud-only | push↑ / decision↓ (outlet leg); X (supplier leg) | own location | Push (outlet): `submitted {lines, photoRef}`, `shipped_back`. Pull: `approved`, `rejected`, `received_at_warehouse`. Supplier-leg ops are cloud-born only. |
| `return_lines` | B | as parent | *(embedded)* | — | Inside `submitted` / `received_at_warehouse`. |

**Group 10 — Accounting (block 090–099)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `chart_of_accounts` | X | Cloud | — | none | GL never leaves cloud. |
| `fiscal_periods` | X | Cloud | — | none | same. |
| `journal_entries` | **D**/X | Cloud-derived (posting-rule engine over applied facts) | — | none | Posted only at cloud, only from **applied** events — an event in quarantine posts nothing (§5.1 invariant). |
| `journal_lines` | D/X | Cloud | — | none | same. |
| `posting_rules` | X | Cloud | — | none | Declarative config (D-04). |
| `payment_verifications` | B→pull | **Cloud (finance) only decides** | pull | own location (status echoes) | `verified`, `paid`, `rejected` — pulled so POS/outlet can show payment status. Never offline-decidable (§7.6). |

**Group 11 — Reporting (block 100–109)**

| Entity | Class | Authority | Direction | Pull scope | Rule |
|---|---|---|---|---|---|
| reporting rollups / materialized views | X | Cloud | — | none | Rebuilt from canonical state; never synced. Node computes its own outlet-local aggregates from its applied events for the LAN mini-dashboard (§8). |

**Group 12 — Devices & topology (block 110–119)**

| Entity | Class | Authority | Direction | Pull scope (device) | Ops / conflict rule |
|---|---|---|---|---|---|
| `devices` | B | Device self-registers; cloud owns registry state | push↑ (`registered`, `profile_updated`) / pull↓ (`paired`, `renamed`, `retired`, `revoked`) | own device + own location (topology display) | Registration handshake detail is M21's (CONTRACTS.md §topology). `revoked` pulled to a device = kill switch: it must stop pushing and wipe credentials. |
| `branch_nodes` | B | Node registers via pairing token; cloud owns state | push↑ (`registered`) / pull↓ (`paired`, `config_updated`, `cert_rotated`, `revoked`) | none (nodes only) | Node config (LAN URL, cert) rides here. |
| `device_heartbeats` | **T** | Origin | push (lossy channel §4.6) | none | 30 s cadence (node), 60 s (device, when awake). Wire shape: `SyncHeartbeatMessage` ≡ CONTRACTS §7.2 `DeviceHeartbeat` (`at`, `queueDepth`, `quarantineDepth`, `pullLag`, `storage {usedMb, quotaMb}`, `clockOffsetMs`, `appVersion`, `batteryPct?`, …) — feeds D-13 topology + F12. Loss-tolerant; cloud keeps rollups. Staleness sweep is cloud-side (M21). |
| `device_events` | F + cloud-born | Origin (incidents) + cloud (transitions) | push↑ + pull↓ (own location, for topology UI) | own location | Push: `storage_warning`, `storage_full`, `quarantine_added`, `clock_suspect`, `credential_denied`. Cloud-born: `went_online`, `went_offline`, `stale`. |
| `pairing_tokens` | X | Cloud | — | none | Minted online, presented once over the pairing API; never in the event stream. |
| `discovered_devices` | F | **Node** origin | push | none (viewed in F12 online) | `discovered`, `updated`, `disappeared` (mDNS/SSDP/ONVIF/TCP probe results, ported pattern). Absent entirely when no node — F12 degrades to app-session devices (D-13). |

**Group 13 — Sync infrastructure (block 120–129)**

| Entity | Class | Authority | Direction | Pull scope | Rule |
|---|---|---|---|---|---|
| `sync_events` | — | Each tier owns its copy | *is the wire* | per subscription | The log itself. Cloud copy is canonical and eternal (monthly partitions); node keeps 90 days; device keeps outbox-until-confirmed + 14-day applied window. |
| `sync_cursors` | — | Local to each upstream | — | — | Per-subscriber high-water marks (§4.5). Never synced; reconstructible from `sync_events`. |
| `sync_batches` | — | Local | — | — | Transport observability (batch id, counts, timings, result). Never synced. |
| `sync_conflicts` | X | Cloud | — | none | Every §5 conflict lands here with full both-sides payloads; F12 conflict queue reads it online. |
| `offline_authorizations` | B | Cloud mints; device reports use | push↑ (`used`) / pull↓ (`revoked` CRL) | own location (CRL only) | **Credential material itself never travels the event stream** — issuance is an authenticated API response at login (§7.2). The event stream carries only usage facts and revocations. |

### 3.4 Enforcement (binding on W2-D)

The authority matrix ships as **executable data** in `packages/sync-protocol` (W1-B): `AUTHORITY[entity] = {class, direction, ops, offlineWritable, pullScope, embedded}`. The cloud ingest pipeline enforces, in order — **the class check runs before the op-vocabulary check, always**:

1. Envelope well-formed and `entity` known → else `malformed` (§4.4).
2. **Class/direction legal for the pusher's tier** → else `authority_violation`, permanent reject. This step consults the entity's *class alone*, so it also catches every entity whose `ops` list is empty: class `M`, `X`, `D`, and `T` entities (`stock_balances`, `stock_movements`, `journal_entries`, `journal_lines`, `audit_log`, `device_heartbeats`, …) pushed from below MUST reject as `authority_violation`, never `malformed` — D-16/D-16a name these rejections specifically, and an empty op vocabulary must not fall through to step 3. *(Normative ordering; v1.1's op-first wording was a bug found by W2-D.)*
3. `op` in the entity's vocabulary and payload `v` supported → else `malformed` / `payload_version_unsupported`, quarantine-with-alert (§4.4).
4. `locationId` matches the origin device's paired location (from the registry, not from the event) → else `authority_violation`.
5. `actorUserId` had the required permission at `occurredAt` per cloud RBAC — failure is **not** a sync reject: the event is applied to the log but the *business apply* is refused and routed per §5/§7 (facts about the physical world are recorded even when unauthorized — that is the fraud-visibility stance of OBJ-03).
6. Class-B decision precedence per §5.3.

Nodes enforce only step 1 (envelope well-formed) and step 4 (location match) — everything else is cloud's, so a compromised node can never widen authority (it holds no decision power to abuse).

---

## §4 Push and pull

### 4.1 Channels

- **Primary:** socket.io namespace **`/sync`** on the upstream (cloud exposes it publicly; node exposes it on its LAN HTTPS listener). Connection pattern is the proven AIRE bridge shape: downstream initiates, `transports: ['polling', 'websocket']` (polling-first — WebSocket-only churns behind branch routers), `auth: {token: <device credential>}`.
- **HTTP fallback** (same base path, same JSON bodies as the socket messages; for degraded networks, curl-testing, and the service worker's background-sync retries):
  - `GET  /sync/v1/health` → `SyncHealthResponse {ok, protocolV, serverTime, tier: 'cloud'|'node'}`
  - `POST /sync/v1/hello` → handshake (same body/reply as `sync:hello`)
  - `POST /sync/v1/push` → same as `sync:push` / reply `sync:push:ack`
  - `GET  /sync/v1/pull?cursor=&limit=` → same as `sync:pull:result`
  - `POST /sync/v1/bootstrap` → §4.6
  - `PUT  /sync/v1/attachments/:sha256` → §4.7 *(cloud only; nodes do not store binaries)*
- Transport auth is the **device credential** (§1.5): a long-lived secret minted at registration, sent as `auth.token` (socket) / `Authorization: Bearer` (HTTP). The node validates device credentials against its replicated `devices` cache so LAN sync works with cloud down; the cloud validates node connections by pairing token exactly like AIRE's `/bridge` gateway.

### 4.2 Handshake — `sync:hello`

Sent by the downstream immediately after connect; nothing else is valid before its ack.

```jsonc
// downstream → upstream (SyncHelloRequest)
{
  "protocolV": 1,
  "subscriberId": "…",                  // device id or node id
  "subscriberTier": "device" | "node",
  "locationIds": ["…"],                 // must match registry; upstream verifies, never trusts
  "pullCursor": 184223,                 // last applied cursor AT THIS upstream (§4.5); 0 = never synced
  "outboxDepth": 12,                    // queued events (telemetry)
  "appVersion": "1.4.2",
  "deviceTime": "2026-08-17T09:31:02.113+08:00"    // for offset measurement (§6.2)
}
// upstream → downstream: sync:hello:ack (SyncHelloAck)
{
  "ok": true,
  "protocolV": 1,                       // the negotiated (min of both) version
  "serverTime": "…",                    // §6.2 offset anchor
  "resumeCursor": 184223,               // upstream's view; downstream MUST resume here
  "confirmedThrough": { "<originDeviceId>": 5521 },   // cloud-durable high-water for this subscriber's origins (§4.3)
  "scope": { … }                        // SyncScope — the subscription the upstream will serve (below)
}
```

The **scope filter** is computed by the upstream from its registry (never from the client's claim). Canonical shape (`SyncScope`), exported from `packages/sync-protocol`:

```jsonc
{
  "globalMaster": true,                        // all class-M events whose locationId is null
  "locationIds": ["<outlet-uuid>"],            // class M/F/B events scoped to these locations
  "assigned": { "driverUserId": "…" },         // dynamic scopes (SJ assigned to this driver), evaluated per event at fan-out
  "projectionRole": "pos_device" | "driver_device" | "employee_device" | "node",
  "excludeOrigin": "<subscriber's own id>"     // upstream SHOULD skip echoing the subscriber's own events; downstream MUST dedupe regardless
}
```

`projectionRole` selects the §3.2 field filters and trims entities the device class never needs (an employee phone gets master data + own attendance/leave echoes only — not the outlet's sales stream).

### 4.3 Push (downstream → upstream)

```jsonc
// sync:push (SyncPushBatch)
{
  "batchId": "uuid",                    // transport-scoped; NOT the idempotency key
  "sentAt": "…",
  "events": [ { …§2.1 wire fields; clientSeq as a decimal string… } ]   // ≤ 200 events AND ≤ 1 MB serialized, in clientSeq order per origin
}
// sync:push:ack (SyncPushAck)
{
  "batchId": "uuid",
  "acceptedThrough": { "<originId>": 5533 },    // durably stored AT THIS UPSTREAM, gapless through this seq
  "confirmedThrough": { "<originId>": 5521 },   // durably stored AT CLOUD (== acceptedThrough when upstream IS cloud)
  "rejected": [ { "eventId": "…", "code": "authority_violation", "detail": "…" } ],
  "resendFrom": { "<originId>": 5480 }          // present iff a gap was detected (§4.4)
}
```

Rules:

- A batch may carry events from **multiple origins** (a node relays all its devices), each origin's events in ascending `clientSeq`. A device's batches carry only its own origin.
- The upstream stores events **transactionally per batch** (all-or-none within one origin's contiguous run; distinct origins are independent) and acks only after durable commit (`fsync`/WAL). An ack is a promise the events cannot be lost by that tier.
- **Two-level acknowledgement (the NFR-06 load-bearing rule).** `accepted` = this upstream has it durably. `confirmed` = the **cloud** has it durably. A device prunes an outbox event **only at confirmed**. When the upstream is the cloud, the levels coincide. When the upstream is a node, the node relays upward and learns cloud confirmation from its own push-acks; it disseminates `confirmedThrough` to its devices on every subsequent ack, heartbeat-ack, and hello-ack. Consequence: **total node loss (disk death) loses nothing** — devices still hold everything unconfirmed and re-push it cloud-direct after failover; `eventId` dedupe absorbs the overlap with whatever the node had already relayed. *(This is deliberate redundancy, not waste — do not "optimize" it away.)*
- Node relay is **verbatim**: origin fields, `eventId`, `clientSeq`, payload untouched; the node adds only `relayReceivedAt` (first-server timestamp, §2.1) and its own id for `relayedViaNodeId`.
- Retry: unacked batches are re-sent with exponential backoff **1s → 2s → 4s → … cap 5 min, ±20 % jitter**, forever (the outbox is durable; there is no give-up). A re-sent batch mints a new `batchId` but carries byte-identical events. Push resumes automatically on `connect` and on service-worker `sync` events.
- In-flight limit: **one** outstanding push batch per upstream connection (simple, ordered, sufficient — see throughput note in §9 T-13 preamble).

### 4.4 Ordering, gaps, rejects, poison events

- **Apply order:** the upstream applies each origin's events strictly in `clientSeq` order. Different origins are independent (no cross-origin ordering exists or is needed — cross-device causality is handled by conflict rules, not sequencing).
- **Gap handling:** if a batch starts beyond the upstream's gapless high-water for that origin (e.g. holds 5480, batch starts at 5490), the upstream durably stores the out-of-order run as `pending_dependency` but does **not** apply it, and returns `resendFrom: 5481`. The downstream must resend from there (its outbox still has everything unconfirmed, so it can — see two-level ack). Gaps persisting > 60 min raise §5.5 R9 (possible data loss / cloned store) to F12. Gaps are expected transiently during upstream failover; they self-heal because the device re-pushes everything unconfirmed to the new upstream.
- **Reject codes.** Permanent (never resend; downstream moves the event to its local `outbox_quarantine` store and advances past it): `authority_violation` (§3.4 steps 2/4 — includes any push of a never-pushable class, checked before op vocabulary), `malformed` (envelope invalid, unknown entity, or unknown op on a *pushable* entity), `seq_conflict` (§2.2 rule 4 — also fires `device_events.quarantine_added` and freezes the origin pending support), `payload_version_unsupported` *(cloud only; means a deploy-order bug — alerts ops)*. Transient (resend after backoff): `retry_later` (upstream overloaded/storage pressure), `gap_wait` (implied by `resendFrom`).
- **Rejected ≠ lost.** A permanently rejected event still advances `acceptedThrough`/`confirmedThrough` (it is dead, not missing), is written to cloud `sync_conflicts` with class `poison`, and surfaces in the F12 conflict queue. The device keeps its quarantine copy for support. The queue **never blocks behind a poison event.**
- **Dependent events:** an event referencing an `entityId` whose creating fact is quarantined (e.g. `void_refunds.requested` for a poisoned sale) parks as `pending_dependency` for 24 h, then converts to a conflict-queue entry linked to the poison parent.
- **Apply-crash safety:** if the upstream's *projector* (not ingest) throws on an applied event, the event stays in the log with `apply_status='quarantined'`, ops is alerted, and the projector skips it — same F12 surface. Log ingest and projection are separate stages precisely so a projector bug cannot reject facts.

### 4.5 Pull (upstream → downstream)

- Every upstream maintains a **local, gapless server sequence** (PG column `server_seq`, BIGSERIAL) over its own `sync_events` copy in arrival order. Pull cursors are positions in *that upstream's* sequence. **Cursors are per-upstream and non-transferable**: a device keeps `{cloud: cursor, node: cursor}` independently; on upstream switch it resumes the target's own cursor. Overlap re-delivery across a switch is expected and harmless (`eventId` dedupe at apply).
- Catch-up: `sync:pull {cursor, limit ≤ 500}` → `sync:pull:result {events, nextCursor, hasMore}` (`SyncPullResult`, ≤ 2 MB per page), repeated while `hasMore`. Live mode: once caught up, the upstream pushes `sync:deliver` (`SyncDeliverMessage {events, nextCursor}` — no `hasMore`: a live feed, not a paginated walk) proactively over the socket as matching events arrive.
- The downstream applies a pulled page **atomically with its cursor advance** (one IndexedDB / PG transaction: apply projections + store applied event ids for the 14-day dedupe window + write cursor). Crash mid-page re-pulls the page; dedupe absorbs it. Cursor regressions are legal at any time; skips are never legal.
- Fan-out filtering happens **at the serving upstream** per the hello-ack scope: the cloud filters + projects (§3.2) per subscriber; a node serves its devices from its local store with the same filter code from `packages/sync-protocol` (its store already contains only its location + global master data, so node-side filtering is mostly projection-role trimming).
- Deletion/compaction: devices prune applied operational events beyond 14 days (projections stay; e.g. derived stock does not reset); master-data projections are kept whole. Nodes prune at 90 days. A subscriber returning after longer than its upstream's retention (or than the upstream's cursor memory) is answered with `cursorExpired: true` in `hello:ack` (an optional `SyncHelloAck` field) → it must re-**bootstrap** (§4.6).

### 4.6 Bootstrap and telemetry

- **Bootstrap** (new device, wiped device, `cursorExpired`, or node first-pair): `POST /sync/v1/bootstrap` with **`SyncBootstrapRequest {scope}`** (scope recomputed by the upstream, never trusted) → chunked **`SyncBootstrapPage`** rows `{snapshotId, page, hasMore, startingCursor, events}`. **Page content is `SyncEventEnvelope[]` — architect decision, resolving the ambiguity flagged in the frozen type's docstring:** every tier has exactly one apply path (the same projector fold as live pull; §9's replay properties cover bootstrap pages unchanged), and no second pre-projected row format exists. A page mixes two kinds of rows: **(a) verbatim real events** — the scope's recent operational history (14-day window) — which enter the local log and dedupe window normally; **(b) synthetic state-carrying events** for master data and open documents (`originTier: 'cloud'`, the entity's `updated`/`issued`-style op, the full current document as payload — legal because §2.3 payloads are complete documents; `eventId` freshly minted per snapshot). Synthetic rows are **projection food only**: never appended to the local log, never entered into the dedupe window, never pushed — the bootstrap channel itself is the marker; no envelope flag exists or is needed. The downstream loads all pages, sets its pull cursor to `startingCursor` **once, after the last page** (not per page), then switches to incremental pull — anything that landed during the load arrives through that pull exactly once (pages are frozen at snapshot start; the cursor starts there too). Pages are deterministic per `(snapshotId, page)` so an interrupted bootstrap resumes, not restarts. **Bootstrap never replays full history** — history lives only at cloud.
- **Heartbeat channel** (class T): `sync:heartbeat` carries **`SyncHeartbeatMessage`**, acked with **`SyncHeartbeatAck {confirmedThrough, serverTime}`** — every 30 s (node) / 60 s (device while awake). **Field authority: CONTRACTS §7.2's `DeviceHeartbeat`, which W2-E's shipped runtime already emits** — notably `at`, `queueDepth` (outbox events not yet cloud-confirmed; the same quantity `SyncHelloRequest.outboxDepth` reports at connect — the two names are each locked by shipped artifacts, do not "harmonize" either side), `quarantineDepth`, `pullLag`, **`storage: {usedMb, quotaMb}`** *(v1.3 fix — this document's unit-less `{used, quota}` was the outlier)*, `clockOffsetMs`, `appVersion`, `batteryPct?`. Node heartbeats additionally carry `deviceSummaries` (node-only): the aggregated LAN view, so F12 sees LAN devices even when only the node has WAN. Fire-and-forget; heartbeats are NOT sync events (no outbox, no dedupe, no `eventId`/`clientSeq`; loss is fine).

### 4.7 Attachment side-channel (photos, signatures)

Binary evidence (wajib foto: FR-LOG-15, FR-WST-01, petty cash, FR-HR-01 selfies, FR-PMS-04, SJ drop photos/signatures; §7 approval selfies) never rides the event stream:

1. At capture, the device compresses (≤ ~200 KB target, EXIF stripped except capture time), computes `sha256`, stores the blob in a local `attachments` store, and embeds `attachmentRef {sha256, size, mime, kind}` in the owning event's payload. The **event pushes immediately** — it never waits for the binary.
2. A separate durable **binary outbox** uploads blobs **cloud-direct** (`PUT /sync/v1/attachments/:sha256`, resumable, authenticated by device credential) whenever WAN is available. Nodes do not store or relay binaries (LAN-only periods queue binaries on-device; cap: 200 MB or 500 blobs, oldest-first eviction *only after* cloud-confirmed upload — evidence pending upload is never evicted; at the cap, evidence-requiring actions are **blocked** with an explicit storage error, §8/§9 T-09).
3. Cloud verifies sha256, stores to MinIO via `StorageService`, marks the reference resolved. Same-sha256 re-upload is a no-op (natural idempotency).
4. An applied event whose *required* `attachmentRef` stays unresolved past **24 h** raises §5.5 R3 → exception queue. The business fact stands; the missing evidence is the exception.

### 4.8 Protocol versioning

`protocolV` (integer) covers message shapes and semantics of this section; payload `v` (§2.3) covers business schemas. Handshake negotiates `min(mine, yours)`; an upstream MUST support the previous protocol version for ≥ one fleet-update cycle (nodes self-update, D-13/W5-07, but tablets lag). Health responses expose `protocolV` so the §1.3 probe can refuse an incompatible upstream (treat as unhealthy → fall through to cloud).

---

## §5 Conflict and reconciliation

### 5.1 Design stance

Append-only + single-writer-per-fact makes classic "two edits to one row" impossible. What remains is **semantic duplication and decision races** — two true facts that cannot both take business effect. The invariants:

1. **Facts are never deleted or edited** — a losing fact is marked `superseded`/`quarantined` and kept.
2. **Business effect is applied exactly once** — projections (stock, GL) key off the *winning* event; a conflict routes the loser away **before** projection. An event in quarantine posts no stock movement and no journal entry.
3. **Every conflict lands on a human queue with both sides attached** (`sync_conflicts` row: both event ids, full payloads, detection rule, suggested action). Nothing auto-merges silently.
4. Conflict detection runs **at cloud apply time** (the only place with the total picture), plus §5.5 sweep jobs as safety nets. Nodes and devices never adjudicate; they at most *display* local suspicion (e.g. a device seeing a sibling's count for its area via node fan-out may warn the user preemptively — UX nicety, W2-E optional).

### 5.2 The enumerated conflicts

| # | Conflict | Detection (cloud, at apply) | Resolution | Human surface |
|---|---|---|---|---|
| **C1** | **Same opname line counted twice** — two `stock_opname.area_counted` events (different devices/origins) both cover `(opname_id, storage_area_id, item_id)` | Uniqueness probe on count-line key within the opname session at projection | Neither count auto-wins. Both retained; line flagged `disputed`; opname cannot be `submitted→approved` while disputes open. Resolver (outlet leader/supervisor) picks a count or orders a recount **in the opname UI**; choice is a new fact (`stock_opname.line_resolved {chosenEventId, reason}`) | **F04** opname screen (resolution) + F12 conflict queue (visibility) |
| **C2** | **Surat jalan drop received twice** — second `sj_drops.received` for the same `sj_drop_id` | Projection guard: drop already in `received` state | **First-at-cloud** applies (stock effect posted once). Second → `sync_conflicts (duplicate_receipt)`, no stock effect, outlet leader notified. If payloads *differ materially* (qtys/photos), the conflict entry says so — that is a fraud signal, not noise | F12 conflict queue + notification to outlet leader & warehouse |
| **C3** | **Approval decided both offline and online** (void/refund, replenishment supervisor step, waste) — an `approved_offline` and a cloud-side `approved`/`rejected` for the same document | Decision-event collision on the document's approval step | Precedence: **(1) any online decision beats any offline-provisional decision, regardless of arrival or occurred-at order** (D-17: offline is provisional by definition); **(2) between two same-mode decisions, first-at-cloud wins**; loser marked `superseded`. Same-outcome duplicates merge silently (both recorded, one effective, no queue entry). **Divergent outcomes** (approve vs reject) → conflict entry; if the losing (offline-approved) decision already had physical effect — cash refunded, goods handed over — the document routes to the **finance exception queue** with `physicalEffectSuspected = true` (§7.5 takes over) | F12 conflict queue; finance queue (F07) when money/goods moved |
| **C4** | **Duplicate/overlapping attendance** — second `checked_in` without `checked_out`, or overlapping intervals for one employee | Interval overlap check per employee per day | Both facts kept; later one flagged `overlap_suspect`; payroll consumes the HR-resolved view only | HR exception list (F08); payroll blocks on unresolved overlaps for that employee |
| **C5** | **Movement application would drive a derived balance negative** (e.g. offline sales + waste against the same stock; receipt correction) | `StockLedgerService` fact-mode posting detects `balance < 0` per `(location, area, item)` | **The fact still applies** (the chicken was really sold — rejecting the event would be inventing data). Balance goes negative, `stock_reconciliations` exception `negative_balance` opens, min-stock alerts suppress for that item (they'd be nonsense), and the outlet is prompted to opname that area. **Interactive/online strict-mode requests still hard-reject** (warehouse can't issue what it doesn't have) — see architect note below | F12 exception queue + F04 prompt ("hitung ulang area X") |
| **C6** | **Same physical inbound recorded twice via different flows** — `sj_drops.received` *and* a `goods_receipts.recorded` covering the same delivery | R5 sweep: same location + overlapping items + window heuristic | No auto-reversal (stock was projected from both — a real double count). Exception with both documents; resolution is a supervised `stock_adjustments.posted` (cloud decision) citing the exception | F12 exception queue → warehouse/supervisor |
| **C7** | **Offline approval fails re-verification** (§7.4) | Credential/scope/expiry/binding check at apply | Approval state → `verification_failed`; document + full evidence to finance exception queue; downstream effects flagged, not auto-reversed (§7.5) | Finance queue (F07) + F12 |
| **C8** | **Duplicate platform order** — two `online_orders.recorded` with the same `(platform, platformOrderId)` | Uniqueness probe | Both kept; second flagged; revenue reports use first; exception for review (typo vs double-entry) | F12 exception queue |
| **C9** | **Poison / seq-conflict events** (§4.4) | Ingest validation | Quarantine; origin frozen on `seq_conflict` until support clears (possible cloned store = fraud vector) | F12 conflict queue, `poison` class |

*(C1, C2, C3, C5 are the four the build plan names; the rest close the remaining holes found in the flows.)*

**Architect-review note (stock ledger dual mode).** C5 forces a W2-A contract amendment: `StockLedgerService.post(tx, movements, mode)` where `mode = 'strict'` (interactive callers — reject on negative, current G2 property) or `mode = 'fact'` (sync apply — post and open an exception on negative). The Wave-2 property "balance ≡ sum of movements, always" is unchanged; "non-negative unless adjustment" holds for strict mode only. Without this split, replaying legitimate offline sales would be rejected, which violates NFR-06. Flagged in my report.

### 5.3 Class-B decision precedence (normative summary)

For any approval-carrying document (`void_refunds`, `replenishment_requests` supervisor step, `waste_records`, `stock_opname` adjudication):

```
effective_decision =
  1. latest ONLINE decision by an authorized actor           (cloud-verified at action time)
  2. else: first-at-cloud OFFLINE-provisional decision that PASSES re-verification (§7.4)
  3. else: none (document stays pending)
```

An online decision arriving *after* an offline one has taken effect supersedes it prospectively; if physical effect already occurred under the superseded decision, C3's finance-queue path handles the cleanup. Decisions are themselves events — superseding never rewrites history, it appends.

### 5.4 The two queue surfaces (F12 contract)

- **Conflict queue** — rows of `sync_conflicts`: C1, C2, C3-divergent, C9. API shape (camelCase per §2 rule): `{conflictId, class, entity, entityId, locationId, winnerEventId?, loserEventId, detectedAt, status: open|resolved, resolutionEventId?, assigneeRole}`. Resolution always happens in the owning domain UI (opname in F04, refunds in F07…); F12 links there. Every resolution is a new sync event — the conflict log itself is append-only.
- **Exception queue** — outputs of reconciliation jobs (below) + C5/C6/C8: `{exceptionId, job, class, locationId, subject refs, measured vs expected, openedAt, status}`. Finance-money items (C7, §7.5, R7 variances above threshold) additionally fan into the finance queue in F07.

### 5.5 Reconciliation jobs (cloud, W2-D owns the runner; schedule in Asia/Makassar)

| Job | Runs | Compares | Output |
|---|---|---|---|
| **R1 — Balance recompute** | Nightly 02:00 full; incremental after every applied batch (touched keys only) | `stock_balances` (D-07 projector output) vs. from-scratch fold of applied facts per `(location, area, item)` | Mismatch = **projector bug** (both are cloud-side): sev-1 alert to ops, exception row. This is the D-16 canary. |
| **R2 — Tier checksum probe** | On each device/node daily **`sync:checksum`** message (**`SyncChecksumMessage`** — W2-D's name, adopted; telemetry channel like `sync:heartbeat`, §4.6) — sent once per day-close: `{locationId, asOfCursor, areaHashes}` where `areaHashes` maps storage-area id → that area's derived-balance checksum (the shared package's `computeAreaBalanceChecksums` returns exactly this shape) | Edge-derived balance hash per area vs. cloud-derived for the same fact horizon (`asOfCursor` = the origin's last-applied cursor, so cloud compares at the same point in the stream) | Divergence → exception `tier_divergence` + device flagged in F12; remedy = device re-bootstrap (§4.6), never a balance push |
| **R3 — Evidence SLA** | Hourly | Applied events with required-but-unresolved `attachmentRef` older than 24 h | Exception per event; repeat offenders (device with chronic unuploaded evidence) flagged in topology |
| **R4 — Price variance** | Nightly | `sale_lines` unit price vs. catalog price effective at `occurredAt` | Variance beyond `settings.price_variance_tolerance` → exception report (fraud signal: stale-catalog selling) |
| **R5 — Duplicate inbound / duplicate platform orders** | Nightly | C6 and C8 heuristics over the day's receipts/orders | Exceptions as above |
| **R6 — Offline-authorization re-verification** | Immediate, at apply of any `*_offline` decision (§7.4); nightly sweep as safety net for missed hooks | Credential validity, binding, scope, limits | C7 path |
| **R7 — Shift close recompute** | At apply of `pos_shifts.closed` | Declared totals & counted cash vs. cloud-computed totals of that shift's applied sales/payments/refunds | Variance beyond tolerance → finance exception (kasir selisih). A **shortfall** beyond `pos.cash_variance_propose_above` additionally materializes a `cash_variance_proposals` row (D-19: pending payroll-deduction proposal — decided online only with mandatory reason, never auto-deducted, never offline-authorizable per §7.6; §3 group 6) |
| **R8 — SJ completeness** | Hourly | Drops `departed` > N h (per-route setting) with no `received`; SJs `issued` > 24 h with no departure | Operational alert (notification), escalating to exception at 2×N |
| **R9 — Sequence-gap sweep** | Hourly | Origins whose gapless high-water trails their max seen seq by > 60 min (§4.4) | Exception `possible_data_loss`; device prompted to full re-push; if the origin also tripped `seq_conflict` → support/fraud escalation |
| **R10 — Cursor/retention guard** | Daily | Subscribers whose cursor lag exceeds retention horizons (device 14 d, node 90 d) | Force `cursorExpired` → re-bootstrap on next hello; F12 stale-subscriber flag |

---

## §6 Clock skew and ordering

### 6.1 The rule

**Ordering authority is `clientSeq` per origin. Wall clocks never order anything.** `occurredAt` is advisory (display, business-date assignment, credential-expiry evaluation); `receivedAt` is the canonical server receipt; `relayReceivedAt` is the earliest server-grade bound. There is no cross-origin ordering — concurrency between origins is resolved by §5 rules, not by timestamps.

### 6.2 Offset measurement and stamping

- Every `hello:ack`, heartbeat ack, and push ack carries `serverTime`. The downstream computes `offset = serverTime − deviceNow − rtt/2` (simple NTP-lite; smoothed EWMA over last 5 samples) and persists it.
- When stamping `occurredAt`, the device applies its **last-known offset** and records both the corrected value and `meta.rawDeviceTime` + `meta.clockOffsetMs` (the offset used and its age). Events created deep offline carry the pre-outage offset — imperfect, bounded, and honest about it.
- Nodes run NTP (part of the node image, W2-F) and are treated as server-grade clocks; `relayReceivedAt` from a node is trusted the way cloud `receivedAt` is.

### 6.3 Skewed-device policy

- |offset| > **2 min**: persistent UI banner ("jam perangkat tidak akurat"), `device_events.clock_suspect` emitted, topology flag in F12. Sync continues — skew never blocks the pipe.
- |offset| > **24 h** or `occurredAt` in the future relative to the stamping tier's receipt (`occurredAt > relayReceivedAt + 5 min` grace): every affected event is tagged `time_suspect = true` at cloud apply. Facts still apply; time-sensitive *interpretations* degrade per 6.4.
- Devices with no successful time sync in 7 days are flagged stale-clock in topology; their new time-sensitive facts auto-tag `time_suspect`.

### 6.4 Defensible time for attendance and shift close (FR-HR-01)

For any event, define **`defensibleAt` = `occurredAt` clamped to the window `[relayReceivedAt − maxOfflineWindow, relayReceivedAt]`** (where `relayReceivedAt` falls back to cloud `receivedAt` when no node relayed; `maxOfflineWindow` = the `settings.max_offline_window` value, default 24 h).

- **Attendance:** lateness/overtime computes from `occurredAt` when the event is not `time_suspect` and `occurredAt ≤ relayReceivedAt` (a claim of "I checked in at 08:00" that reached a server at 08:00:05, or a node at 08:01, is defensible). If `time_suspect` or the claim precedes any server sighting by more than `maxOfflineWindow`, payroll uses `defensibleAt`, marks the row `time_disputed`, and it joins the C4 HR review list. An adversarial clock can therefore never *manufacture* punctuality beyond what a server timestamp brackets, and honest long-offline check-ins (WAN dead all shift, no node) degrade to review rather than auto-penalty.
- **Shift close:** totals are computed from the shift's event *set* (all sales with `clientSeq` between `opened` and `closed` of that origin) — `clientSeq` bracketing, immune to clock lies. Business-date assignment uses `occurredAt` in Asia/Makassar unless `time_suspect`, else `defensibleAt`; a shift spanning the date boundary belongs to its opening date (rule shared with CONTRACTS.md reporting section).
- **Offline credential expiry (§7.4):** a credential is **provably valid** for an event when `relayReceivedAt ≤ exp` — the action happened no later than its first server sighting, which is inside the validity window, so no clock claim is involved at all. When `occurredAt ≤ exp < relayReceivedAt` (the claim is in-window but the first sighting is after expiry), validity is **unprovable**: the approval routes to the finance exception queue as `unprovable_expiry` (§7.4 outcome 3) rather than being trusted or hard-failed. A backdated clock therefore buys an adversary a finance review, never an auto-pass; an honest approval that simply synced late lands in the same review with its selfie and supervisor-notification evidence to clear it.

---

## §7 Offline authorization (D-17)

### 7.1 Threat model — design against this, not around it

The adversary is a **cashier who fully controls the tablet**: can read IndexedDB, replay network traffic, uninstall/reinstall, set the clock, and knows every UI flow. The supervisor's credential is cached on that same shared tablet (the supervisor walks over and approves on the kasir's device — that is the PRD's physical reality). Therefore:

- Nothing cached on the device is treated as secret from the cashier. Security comes from (a) what the **cloud can verify after the fact**, (b) **evidence the adversary cannot cheaply fake** (approver selfie), (c) **tamper-evident telemetry** whose *absence* is itself a signal, and (d) **guaranteed post-hoc human review** of everything that fails or evades verification.
- An offline approval is **never final**. It is a provisional grant that lets operations continue (a refund can't wait 6 hours for WAN) and is re-adjudicated at cloud. D-17 verbatim.

### 7.2 The cached credential

- **Minting (M01):** whenever a user with offline-eligible approval permissions (§7.6) authenticates online on any device at their location, the cloud mints (or refreshes) an **offline approval credential** and returns it in the session response — **over the authenticated API, never through the sync event stream** (events persist at every tier; credentials must not).
- **Shape (v1: deliberately unsigned — decision, not oversight):** `base64url(JSON.stringify(claims))`, no signature. Claims:

```jsonc
{
  "credentialId": "uuid",
  "sub": "<approver user id>",
  "role": "supervisor_cabang",
  "locationIds": ["<outlet>"],
  "scopes": { "void_refund.approve": {"maxIdr": 500000},      // scope KEYS are permission-key values — unchanged
              "replenishment.supervisor_approve": {},
              "waste.approve": {"maxIdr": 1000000} },
  "iat": "…", "exp": "…",                   // TTL: settings.offline_credential_ttl, default 24 h
  "k": "<32-byte per-issuance binding secret>",
  "pinVerifier": "<argon2id hash of approver PIN>",    // memory-hard: m=64MiB, t=3, p=1
  "selfieRequiredAboveIdr": 200000          // from settings
}
```

**Why unsigned is sound here** (owner decision settling the code-vs-prose divergence — both implementing agents built it unsigned and flagged it; this supersedes v1.0–v1.3's "Ed25519-signed" wording). A reader finding an unsigned credential in a fraud-control system should not assume oversight:

1. **The real control is server-side and never trusts the token.** §7.4 re-verifies every offline authorization against the cloud's **own stored `offline_authorizations` row** — checks 1 and 2 use the cloud's stored issuance record and stored `k`, never anything the token asserts about itself. A locally forged or edited token cannot make the cloud accept anything; on the device, the token is a local UX gate, nothing more.
2. **A signature would not raise the §7.1 skill floor.** It stops a cashier editing the stored token in devtools, but not one patching the running page's JavaScript — the verifier and its public key would live in the same adversary-controlled bundle. Comparable skill floors; it narrows the attack class by one variant rather than closing it.
3. **The genuine residual risk is unaffected by signing.** Cash physically leaving the drawer before detection (RISK-S2) is handled by provisional authorization, mandatory re-verification, and unwind-to-receivable (§7.4/§7.5) — none of which depend on on-device token integrity.
4. **The mitigation that would actually prevent rather than detect** is approver-owned-device signing (the supervisor's own phone signs via a QR handshake) — an open PM decision under RISK-S2, and it would make token signing redundant anyway.

**Forward seam:** the device runtime already exposes `verifyCredentialSignature` as an injectable no-op (`apps/frontend/src/lib/local/credentials/signature-verifier.ts`), and the backend's minting path is the single attach point (`apps/backend/src/modules/auth/offline-credential-token.util.ts`) — adding signatures later, or the QR-handshake path, is a wire-in, not a rewrite.

- **Storage:** the device stores credentials for every eligible approver of its paired location, replaced on each refresh. TTL is deliberately short — a supervisor who hasn't been online anywhere in 24 h has no offline approval power (the fallback is: no approval, action blocked; see §8).
- **Revocation:** `offline_authorizations.revoked` events (CRL of `credentialId`s) ride the master-data pull; devices MUST check the CRL before honoring a credential. Revocation while fully offline is acknowledged as impossible — bounded by the TTL, which is the reason the TTL is short. User deactivation auto-revokes all their credentials.

### 7.3 Recording an offline approval

UI flow on the (adversarial) device: approver selects their name → enters PIN (verified locally against `pinVerifier`; **5 attempts then hard lockout of that credential on this device**, every attempt — success and failure — enqueued as `device_events` telemetry) → if `amount ≥ selfieRequiredAboveIdr`: front-camera selfie captured (attachment side-channel §4.7) → approval event committed atomically (§2.2).

The approval event (`<entity>.approved_offline`) carries in `meta.authorization` (`OfflineAuthorizationMeta`):

```jsonc
{
  "credentialId": "…",
  "approverUserId": "…",
  "binding": HMAC_SHA256(k, event_id ‖ entity ‖ entity_id ‖ op ‖ amount_idr ‖ occurred_at),
  "pinAttemptsBeforeSuccess": 1,
  "amountIdr": "150000.00",                 // the approved amount (Money)
  "selfieRef": { "sha256": "…", "size": 0, "mime": "…" }   // required iff amount ≥ threshold
}
```

**Binding computation (normative — this exact encoding diverged twice across tiers; the fixture is the law):**

- The MAC'd message is the UTF-8 bytes of the six field **values** — `eventId`, `entity`, `entityId`, `op`, `amountIdr`, `occurredAt` — with **exactly one `'‖'` (U+2016 DOUBLE VERTICAL LINE, UTF-8 bytes `E2 80 96`) between consecutive fields**. The joiner is a literal separator that is part of the MAC'd message. It is **not** ASCII `'|'` (U+007C) and not mathematical concatenation notation — the two tiers diverged on precisely this reading, and every offline approval would have failed §7.4 check 2.
- The encoding is unambiguous by construction: no field can contain U+2016 (UUIDs, ASCII entity/op names, a decimal Money string, an ISO timestamp).
- **`amountIdr` is normalized to the empty string `''` by the CALLER when the action carries no amount.** The HMAC helper does no coalescing — passing `null`/`undefined` through is a caller bug, and this asymmetry also caused a tier divergence.
- `binding` = hex-encoded `HMAC_SHA256(k, message)`. Byte-exactness (including hex case) is pinned by the **shared known-answer fixture in both tiers' test suites — implement against the fixture, not against this prose.**
- The formula's snake spelling above and in the shipped `types.ts` comment (`event_id ‖ entity ‖ …`) denotes these same values and is kept verbatim on both sides — do not "modernize" one without the other.

and the row-level flag **`offline_authorized = true`** — set by every tier's projection, visible in every audit view, forever (a verified-later approval keeps the flag; verification adds a state, it never launders provenance).

The **binding HMAC** proves the recorder possessed `k` *for this exact action* — a credential id copied from a shoulder-surfed screen cannot sign new actions, and one leaked binding cannot be replayed onto a different document/amount. It does **not** prove the approver was present (the cashier's device holds `k` too — §7.1). Presence evidence is the PIN telemetry + selfie + the supervisor-notification loop in §7.4.

### 7.4 Re-verification at cloud (runs at apply, R6 as sweep)

Checks, in order — first failure decides the class:

| # | Check | On failure |
|---|---|---|
| 1 | `credentialId` exists in `offline_authorizations`, was minted by cloud for this `sub` | **failed** (forged/unknown → fraud alert, not just queue) |
| 2 | Binding HMAC recomputes over the event's own fields with the stored `k` | **failed** (tampered action) |
| 3 | Credential not revoked with revocation effective before `relayReceivedAt` | **failed** |
| 4 | Expiry: `relayReceivedAt ≤ exp` → provable. Else if `occurredAt ≤ exp` → **unprovable** (§6.4). Else | **failed** (claim itself out of window) |
| 5 | Scope covers `(entity, op)`; amount ≤ `maxIdr` for the scope | **failed** |
| 6 | Approver was active + still held the role/location at `defensibleAt` | **failed** |
| 7 | Selfie present when amount ≥ threshold; PIN telemetry for this approval exists and is sane (attempts present, no lockout-bypass pattern) | **degraded** — treated as unprovable |
| 8 | Volume sanity: approvals under this credential within its TTL ≤ `settings.offline_approval_volume_cap` (default 20) | **degraded** — excess ones unprovable, pattern alert |

Outcomes:

1. **Verified** — approval becomes effective per §5.3 precedence (still subordinate to any online decision), keeps `offline_authorized = true`. The approver receives a push/WA notification: *"Anda menyetujui [X] secara offline di [device] pada [time] — bukan Anda? Laporkan."* — the dispute loop is part of the control; disputes reopen the case as **failed**.
2. **Failed** — approval state → `verification_failed`; it confers nothing (§5.3 treats it as absent). Document + both payloads + evidence → **finance exception queue**.
3. **Unprovable** (expiry window, missing selfie/telemetry, volume cap) — approval stands **provisionally-flagged** (operations already acted on it); case → finance exception queue for a human verdict: *uphold* (converts to verified, reason recorded) or *reject* (converts to failed).

### 7.5 What the finance exception queue receives, and unwinding

Queue entry (F07, mirrored in F12; camelCase per §2 rule): `{caseId, class: offline_auth_failed | offline_auth_unprovable, document (entity, entityId, amount), approvalEventId, credentialId, approver, device, outlet, occurredAt / relayReceivedAt / defensibleAt, evidence: {selfieRef?, pinTelemetry, notificationDispute?}, physicalEffectSuspected: bool, status}`.

On a **reject** verdict where physical effect already happened (cash refunded, goods released, waste discarded):

- The fact is **not deleted** (§5.1). Finance records a `*.verification_rejected` decision event; the projector books the loss to a **receivable/claims account** against the responsible parties (posting rule in CONTRACTS.md §posting-rules), which finance may route to payroll deduction (kasbon-style, POUT-09) or write off — an explicit human decision either way.
- The involved credential is revoked; the device gets a topology fraud flag; repeated cases per device/approver surface as a pattern report (SM-02 measurement input).

### 7.6 Offline-eligible scopes — closed list

**Eligible (D-17 applies):** `void_refund.approve` (APR-02), `replenishment.supervisor_approve` (the *outlet supervisor* step only), `waste.approve` (outlet step only). Each with per-scope IDR caps from settings.

**Never offline** (attempting them offline is UI-blocked and cloud-rejected as `authority_violation`): payment verification (FR-ACCT), PO/purchase approvals, stock adjustment posting, opname adjudication, **cash-variance proposal decisions (D-19 — a wage-deduction decision must never ride a cached credential; CONTRACTS §5.9 agrees)**, payroll anything (D-18 statutory configuration included), master-data edits, warehouse-side replenishment approval, user/role changes, credential minting itself. This list is enforced from `packages/sync-protocol` authority data, not by UI convention.

---

## §8 Tier-degradation matrix

Legend — **A** allowed (full function) · **P** allowed-provisional (works now, re-verified/finalized at cloud; user sees a "provisional/queued" state) · **D** degraded (works with reduced data freshness/scope; banner states it) · **B** blocked (greyed out with the stated reason).
Columns: **(a) Online** — device ⇄ cloud reachable (node present or not — indistinguishable to the user). **(b) LAN-node** — WAN down, paired node reachable: intra-outlet fan-out works, cloud decisions don't arrive. **(c) Isolated** — no upstream at all (no node exists, or node also down): device is alone with its cache + outbox.

This table is the **frontend contract for greying out** (F02/F04/F11/F13 especially) and the node/runtime contract for what must work where. If a surface agent finds an action not listed, file it with the architect — do not invent a row.

| # | Action (actor) | (a) Online | (b) LAN-node | (c) Isolated | Rules & reasons |
|---|---|---|---|---|---|
| 1 | **Sell — cash** (Kasir, F02) | **A** | **A** | **A** | Fully local capture (D-02). Requires an open local shift + catalog cache. Receipt prints locally (§1.5 numbering). Isolated: sale not visible to other tablets until reconnect. |
| 2 | **Sell — QRIS (static) / transfer** (Kasir) | **A** (payment `pending_verification`) | **A** (same) | **A** (same) | PRD's own flow is Pending → Verified → Paid (FR-ACCT-03); the *sale* is never blocked. Finance verifies against mutasi later. UI must show "pembayaran belum terverifikasi" identically in all three states — verification is asynchronous even online. |
| 3 | **Void / refund** (Kasir + Supervisor) | **A** (online supervisor auth) | **P** — offline credential + PIN (+ selfie ≥ threshold), §7 | **P** — same as (b) | Blocked in (b)/(c) if no unexpired cached credential for an eligible approver at this outlet (TTL 24 h) → UI states: "perlu koneksi atau supervisor dengan kredensial aktif". Never kasir-only (FR-POS-03). |
| 4 | **Receive goods — supplier-direct at outlet** (Leader/Staff, F04) | **A** | **P** (fact queued; photo wajib captured; stock effect local-derived, canonical on sync) | **P** same | `goods_receipts.recorded`. Photo capture is mandatory in every state; if the binary outbox is at cap → **B** with storage error (§4.7). |
| 5 | **Receive goods — PO at warehouse** (Kepala Gudang, F05) | **A** | **B** | **B** | Class X (§3 group 5): PO receiving needs supplier/PO/pricing data that is deliberately never cached (FR-SUP-06). Warehouse is HQ with wired WAN; accepting this gap is cheaper than syncing role-locked pricing to edge devices. |
| 6 | **Receive a surat jalan drop** (Leader/Staff, F04) | **A** | **P** | **P** | `sj_drops.received` with qty/discrepancy/photo/signature/seal/temp. Requires the SJ to be in local cache — it will be if the device was online/LAN any time after SJ issue (pull scope: own location). A device that never saw the SJ can still record a **blind receipt** (`goods_receipts.recorded` flagged `unmatched_delivery`) → R5/C6 reconciles it. Discrepancy is data, not conflict. |
| 7 | **Driver drop workflow** (Driver, F13) | **A** | n/a (driver is on the road; LAN irrelevant) | **P** — depart/arrive/temp/seal/photo/signature all capture offline | **Prerequisite:** driver device must pull its assigned SJs while online *before departure* — the F13 UI must hard-warn on departing with a stale/empty SJ cache. All road events queue and push on any connectivity. |
| 8 | **Stock opname — count** (Leader/Staff, F04) | **A** | **A** — multi-device counting; node fan-out lets devices see each other's `area_counted` and warn on C1 overlap live | **A** — single-device counting; C1 risk detected at cloud only | Counting is always local (`opened`, `area_counted`, `submitted`). |
| 9 | **Stock opname — adjudicate/adjust** (Supervisor/Kepala Gudang) | **A** | **B** | **B** | Adjudication + `stock_adjustments.posted` are cloud-only decisions (§3 group 3): adjustments move stock and are deliberately excluded from §7.6 offline scopes. |
| 10 | **Attendance check-in/out** (any employee, F11) | **A** | **A** (via node; `relayReceivedAt` gives server-grade time bound, §6.4) | **P** — queued; time defensibility degrades to `defensibleAt` window; `time_suspect` possible | GPS + selfie captured locally; geofence pre-checked against cached coords, re-verified at cloud. Requires the employee to have logged in on that device while online at least once (offline unlock via cached PIN verifier, §3.2 `users`). |
| 11 | **Create replenishment request** (Leader, F04) | **A** (live usage-based suggestion) | **P** — submit queued; suggestion from cached usage (may be stale, banner says so) | **P** same | `submitted` queues; supervisor step may proceed per row 12; warehouse decision requires cloud. |
| 12 | **Approve a request — outlet supervisor step** (Supervisor) | **A** | **P** (§7 credential) | **P** (§7 credential) | Subject to §5.3 precedence: a later online decision supersedes. |
| 13 | **Approve — warehouse/manager step** (Kepala Gudang/Manager) | **A** | **B** | **B** | Not in §7.6 eligible scopes; these actors work at HQ surfaces (F05/F03). |
| 14 | **Verify payment** (Finance, F07) | **A** | **B** | **B** | Finance-critical, explicitly excluded from offline scopes (§7.6). Fraud surface OBJ-03. |
| 15 | **View dashboard** (Owner/Manager, F03) | **A** (realtime) | **B** — cross-outlet aggregates need cloud. (On outlet devices, a node-served *outlet-local* mini-dashboard is **D**: own outlet's today-figures from node projections) | **D** — stale last-synced tiles with timestamp banner, read-only | The owner's dashboard is honest about staleness; it never renders cached numbers without their as-of time. |
| 16 | **Open/close POS shift** (Kasir, F02) | **A** | **A** | **A** | Local facts; close totals recomputed at cloud (R7) — UI shows "laporan shift final setelah tersinkron". |
| 17 | **Record GoFood/ShopeeFood order** (Kasir, F02) | **A** | **A** | **A** | Manual entry (FR-POS-05/07); duplicate platform-order ids reconcile via C8. |
| 18 | **Petty cash entry** (Leader, F04) | **A** | **P** (verification later, finance-online) | **P** | Photos wajib; same storage-cap rule as row 4. |
| 19 | **Record waste** (Staff, F04) | **A** | **P** — report + outlet-supervisor offline approval possible (§7.6); stock effect only after approval | **P** same | Gudang-side waste approval is online-only. |
| 20 | **Stock view per area** (Leader/Kasir) | **A** (canonical) | **D** — derived from node/device fact horizon; label "per data lokal" | **D** — device-local derivation only | D-16: what you see offline is a *derivation*, never a synced balance; the UI must carry the as-of cursor label. |
| 21 | **Master data edit** (Admin/Manager, F10) | **A** | **B** | **B** | Class M is read-only offline, no exceptions (§3.1). |
| 22 | **Approve leave / edit shift schedule** (Supervisor/HR, F08) | **A** | **B** | **B** | `shift_assignments` cloud-authoritative; leave decisions online-only (§7.6). |
| 23 | **Payroll operations** (HR/Finance) | **A** | **B** | **B** | Class X throughout. |
| 24 | **Maintenance job completion + photo** (PIC, F09) | **A** | **P** | **P** | `maintenance_jobs.completed` queues; verification online. |
| 25 | **Topology / sync health view** (Owner/IT, F12) | **A** | **B** (node's own local `/health` page shows node+LAN status for on-site troubleshooting) | **B** | F12 is a cloud surface by nature. |
| 26 | **Login** | **A** | **D** — offline unlock with cached PIN verifier for users previously seen on this device; new users need cloud | **D** same | Session semantics in CONTRACTS.md (M01); sync transport is device-authenticated regardless (§1.5). |
| 27 | **Decide a cash-variance proposal** (Supervisor/Manager/Owner — approval inbox) | **A** | **B** | **B** | D-19: proposals are cloud-born at shift-close apply (R7) and decided online only, reason required on approve and reject; deliberately outside §7.6 offline scopes. Blocked states show "keputusan selisih kas memerlukan koneksi" — this is by design, not a degradation to work around. |

Reading the columns as a product statement: **selling, receiving, counting, attendance, and evidence capture never stop; decisions and money-finalization always converge on the cloud.** That is D-12 + D-17 in one sentence, and every UI banner should communicate which side of that line the user is standing on.

---

## §9 Test obligations

Binding on **Gate G2** (W2-D/E/F harnesses) and **Wave 6 W6-02** (adversarial suite), with §7 items shared with **W6-03**. Property tests use `fast-check` against the pure projector/authority code in `packages/sync-protocol`; scenario tests run the real three processes (`SIMULATE=true` node, fake-backend device runtime, cloud in test mode). "State checksum" below = the deterministic hash of all projected state for a scope (exported by `packages/sync-protocol` for exactly this purpose; also used by R2).

### 9.1 Properties (G2 — these ARE the design, per RISK-P3)

- **T-01 Idempotent, order-insensitive convergence (the master property).** ∀ generated set of valid events from ≤ 5 origins: partition arbitrarily into batches, deliver each batch **1–5 times** in **any interleaving** (per-origin order preserved within the §4.4 gap rules) → final cloud state checksum identical to single-ordered delivery; every projection row count identical; `sync_conflicts` content identical (same conflicts detected, same winners — winner selection must depend on arrival order **only** where §5 says "first-at-cloud", and the property fixes arrival order per run, so re-runs of the same delivery schedule are bit-identical).
- **T-02 Balance ≡ fold of facts (D-16).** ∀ fact streams: cloud `stock_balances` = from-scratch fold; device-derived = node-derived = cloud-derived at the same cursor horizon (three implementations, one shared function — test pins them together). Includes negative-balance cases (C5 applies fact, opens exception).
- **T-03 Gapless-seq safety.** ∀ streams with injected gaps/reorders: nothing applies past a hole; `resendFrom` names the hole; filling it applies everything; a permanently rejected event advances the high-water; a `seq_conflict` (same seq, different `eventId`) freezes the origin and quarantines — never overwrites.
- **T-04 Two-level ack (NFR-06 core).** ∀ schedules of {device push → node accept → node relay → cloud confirm} with node crash-loss injected between accept and relay: device retains until `confirmed`; after failover-to-cloud and re-push, cloud state = no-loss reference run; zero duplicates applied.
- **T-05 Authority enforcement.** ∀ (entity, op, origin tier, location claim): pushes violating §3 are rejected with the exact §4.4 code; no `M/X/D/T`-class entity ever accepts an upward push, **and each such push rejects as `authority_violation`, never `malformed` — the §3.4 step-order regression (class check before op vocabulary; empty `ops` lists must not fall through)**; location spoofing rejected; every legal (class, direction) pair accepted. Table-driven from the same `AUTHORITY` data the engine runs on — the test fails if code and matrix drift. Wire-codec leg: round-trip every message type through JSON at each tier boundary — field names must match the frozen `@mimi/sync-protocol` types and `clientSeq` must survive as a decimal string > `Number.MAX_SAFE_INTEGER` (the v1.1 interop break, pinned forever).

### 9.2 Scenario obligations (G2 offline harness + W6-02 adversarial)

- **T-06 24 h offline, bulk sync.** 1 outlet, 2 tablets, 24 h of generated activity (≈ 600 events: sales, shift open/close, attendance, opname, receipts, 1 offline void) fully isolated → reconnect → *(G2 bar: 50 queued sales survive outage + reconnect with zero loss/dup)* → full suite bar: everything drains within 5 min; cloud checksum = reference; exactly the expected C-conflicts and R7 variances; no others.
- **T-07 Two tablets diverging in one outlet.** Both isolated (no node), overlapping activity incl. C1 double-count of one `(area, item)` and C2 double-receipt of one drop → both reconnect in both orders (A-then-B / B-then-A) → same conflicts detected regardless of order; first-at-cloud winner rule observed; stock effect posted exactly once; F12 queue shows exactly 2 open conflicts.
- **T-08 Tab closed / crash mid-write.** Kill the PWA at every await-point of the §2.2 commit transaction (fault-injection harness): after reload, either the sale exists locally **with** its outbox event (and prints), or neither exists (and the cart draft is restored) — no third state, ever. Same for pulled-page apply vs cursor advance (§4.5).
- **T-09 Storage full.** Drive IndexedDB to quota during a sale burst + photo capture: outbox writes get priority (cache eviction first, §4.7 order); when the outbox itself cannot commit, the sale is **refused loudly** (no receipt, explicit error, `device_events.storage_full` queued when possible) — a receipt must never exist for an event that isn't durably queued. Binary cap: evidence-requiring actions block at cap; non-evidence actions continue.
- **T-10 Duplicate submit.** Double-tap/replay on every mutating flow (UI level and direct outbox level) → one event, one apply; §2.2 rule 3 draft-binding verified per surface.
- **T-11 Node down while devices up.** Mid-stream node kill: devices fail over ≤ 30 s (3-failure rule §1.3), resume push/pull against cloud with their cloud cursors, re-deliver overlap harmlessly; node restart → devices fail back only after 60 s healthy; no event lost/duplicated across two full flap cycles (checksum vs reference).
- **T-12 Cloud down while node up (LAN island).** 3 devices + node, WAN cut 8 h: sales visible cross-tablet via node fan-out ≤ 5 s; offline void with cached credential works; opname C1 pre-warning fires on LAN; WAN restore → node drains relay outbox; `confirmedThrough` propagates; devices prune outboxes; cloud checksum = reference; R6 re-verifies the void (outcome: verified). Repeat with node killed *before* WAN restore (its relay outbox lost) → devices re-push cloud-direct after node marked unhealthy; **zero loss** (T-04 in vivo).
- **T-13 Clock skew.** Device at +3 h, −3 h, and +30 h: attendance and shift close produce `time_suspect`/`defensibleAt` behavior per §6.3/§6.4 exactly; credential expiry table §7.4 row 4 verified for provable/unprovable/failed on skewed claims; business-date assignment stable. *(Throughput sanity for W6-05 rides this rig: 20 outlets × 1 day backlog ≈ 12 k events must drain < 10 min at one in-flight batch per origin — comfortable at 200-event batches, but measure it.)*
- **T-14 Poison + dependency.** Inject malformed / authority-violating / version-unsupported events mid-queue: queue never stalls; quarantine + F12 rows appear; dependent event (`void` of quarantined sale) parks then escalates per §4.4; `seq_conflict` freezes only its origin.
- **T-15 Adversarial offline authorization (with W6-03).** (i) Forged credential (self-minted) → §7.4-1 **failed** + fraud alert. (ii) Real credential, tampered amount (binding HMAC broken) → failed. (iii) Replayed binding onto a different document → failed. (iv) Expired credential + backdated clock → **unprovable**, finance queue, never auto-pass (§6.4). (v) Missing selfie above threshold → unprovable. (vi) PIN brute-force: lockout at 5, telemetry rows present; telemetry-stripped replay (attempt events deleted from outbox) → §7.4-7 degraded + pattern alert. (vii) Volume cap breach → excess unprovable. (viii) Verified-path happy case: supervisor notification fires, dispute flow reopens as failed. (ix) Offline-approve + online-reject race → C3: online wins, physical-effect case lands in finance queue with `physicalEffectSuspected`. (x) **Binding-encoding known-answer:** both tiers reproduce the shared fixture byte-for-byte — U+2016 joiner (not ASCII `'|'`) and caller-side `amountIdr → ''` normalization, the two real divergences, pinned forever (§7.3). (xi) **Edited local token:** raise `maxIdr` / extend `exp` in the stored unsigned claims on the adversarial device → the local gate may pass on that device, but §7.4 checks 4/5 evaluate against the cloud's stored row → **failed**/**unprovable** per the table — the test that proves the v1.4 unsigned-token stance (the token is UX; the stored row is the control).
- **T-16 Bootstrap equivalence.** Fresh device bootstraps (§4.6) while the outlet keeps transacting; interrupted-and-resumed bootstrap included → its state checksum equals a device that lived through history, at the same cursor; then both stay equal through 1 h of live traffic.
- **T-17 Sync fuzz (G2 gate item).** Randomized interleaved batches from 3 origins (device×2 + node), random duplication ×1–5, random transient rejects injected → single converged cloud state; repeat 500 runs seeded; any divergence shrinks to a minimal counterexample (fast-check) and is a **gate-blocking** defect. This is the RISK-P3 fallback-ladder decision input at G2: if T-17 cannot be made green, the ladder drops to device-local-only before Wave 3 fan-out.

Every test above must assert on **state checksums and queue contents**, not on "no error was thrown" — silent divergence is the failure mode this protocol exists to prevent.

---

*End of SYNC-PROTOCOL.md v1.4. Amendments go through the architect (collision rule 7): propose → this document changes → integrator broadcasts. Code never leads this contract.*
