# Mimi Chicken OS — Hardware Specification (W7-04)

**Owner request, 2026-08-23:** work out what hardware is needed for outlet, cashier, gudang, main office
and the driver's Android phone.

Every requirement below is derived from what the software actually does — the browser APIs it calls, the
work it does on-device, and what it must keep while offline. Where a requirement rules a device class out
entirely, that is stated as a **hard constraint**, because those are the ones that cost money to discover
late.

Quantities assume the current org: **20 outlets + 1 Gudang Pusat**, three shifts per outlet
(Pagi/Siang/Malam), crew of 4 per shift (Supervisor, Kasir, 2 × Juru Masak), 2 gudang staff and 2 drivers.

---

## 1. The four hard constraints

These decide the shopping list more than any spec number does.

**1.1 — Web Bluetooth for the thermal printer means Android or a desktop OS. Not iPad, not iPhone.**
`components/pos/receipt-printer.ts` drives the ESC/POS receipt printer over `navigator.bluetooth`. **iOS and
iPadOS do not implement Web Bluetooth in any browser** — including Chrome on iOS, which is Safari's engine
underneath. An iPad cannot print a nota. If the till must print, the till is Android, Windows or ChromeOS.

**1.2 — A secure context is required, and it now exists.** Service workers, camera and geolocation are all
gated behind HTTPS. The system is served at `https://150-109-15-108.sslip.io` with a real certificate
(B-14). Any device that cannot reach that hostname over TLS loses the offline shell, the camera and GPS.

**1.3 — PIN verification is memory-hard, on the device.** Offline approval verifies an argon2id hash at
`m=64MiB, t=3` (SYNC-PROTOCOL §7.2). Each verification allocates **64 MB** and takes roughly a second on
mid-range ARM. On a 2 GB tablet with a browser already holding the POS app, that is survivable but tight —
it is the single strongest argument for **4 GB RAM minimum** on any device that approves anything offline.

**1.4 — Offline evidence lives in IndexedDB until it syncs.** Wajib-foto photos for receiving, waste and
void approval are captured to canvas and held on-device. A day of outage at a busy outlet can accumulate a
few hundred MB. Devices need real storage headroom, not a nearly-full 16 GB phone.

---

## 2. Per-outlet (× 20)

### 2.1 Kasir — the till

The only device that must print, and the one that must keep selling through an outage.

| Requirement     | Minimum                   | Why                                                                 |
| --------------- | ------------------------- | ------------------------------------------------------------------- |
| Platform        | **Android 11+**           | Web Bluetooth (1.1). Chrome, not a vendor browser                   |
| RAM             | **4 GB**                  | argon2id at 64 MB per verification, alongside the app (1.3)         |
| Storage         | 64 GB, ≥16 GB free        | Offline outbox + photo evidence (1.4)                               |
| Screen          | 10", 1920×1200            | The POS grid is designed full-screen; 8" forces scrolling mid-order |
| Battery / power | Mains, always plugged     | A till is stationary; treat battery as a UPS, not a runtime budget  |
| Connectivity    | Wi-Fi 5 + **4G fallback** | RISK-02: branch internet is unreliable and this is the revenue path |

**Quantity: 1 per outlet = 20**, plus **2 spares** held centrally. A dead till stops revenue at that
branch; next-day courier from Balikpapan is cheaper than a lost trading day.

**Also required per outlet:**

- **Bluetooth thermal printer, 58 mm or 80 mm, ESC/POS.** 80 mm if the nota should carry item names
  comfortably. Must be BLE (Bluetooth 4.0+), not classic-SPP-only — Web Bluetooth speaks GATT.
- **Cash drawer** — printer-driven (RJ11 kick-out) is simplest; the app does not control it directly.

### 2.2 Supervisor — the outlet's own screen

Receiving, stock opname, waste, retur, petty cash, approvals. Camera-heavy (wajib foto) and it approves
things, so 1.3 applies.

| Requirement | Minimum                    | Why                                                     |
| ----------- | -------------------------- | ------------------------------------------------------- |
| Platform    | Android 11+ tablet         | Same fleet as the till keeps spares and training common |
| RAM         | **4 GB**                   | Offline approval (1.3)                                  |
| Storage     | 64 GB                      | Photo evidence before sync (1.4)                        |
| Camera      | **Rear, ≥8 MP, autofocus** | Wajib foto has to be legible as evidence, not a smudge  |
| Screen      | 8–10"                      | Carried around the store room, not desk-mounted         |
| Battery     | ≥6 h real use              | It moves with them through a shift                      |

**Quantity: 1 per outlet = 20**, plus **2 spares**.

> **A cheaper option worth considering:** the two cooks need no device at all — they hold no till and
> approve nothing. If supervisors are willing to share the till device outside peak hours, an outlet can run
> on **one** tablet. That halves the fleet to ~22 devices, at the cost of contention during receiving (which
> happens mid-morning, while the till is idle). My recommendation is still two per outlet: the wajib-foto
> flows are slow, and blocking the till while photographing a delivery is exactly the friction that gets
> processes skipped.

---

## 3. Gudang Pusat (× 1 site)

### 3.1 Warehouse operations terminal

Surat Jalan creation, route planning, PO receiving, opname across freezer/chiller/dry. Heaviest data
screens in the system and the ones that print.

| Requirement | Minimum                                 | Why                                                                              |
| ----------- | --------------------------------------- | -------------------------------------------------------------------------------- |
| Platform    | Windows 11 or ChromeOS, **Chrome/Edge** | Web Bluetooth for the Surat Jalan printer; large-screen work                     |
| CPU / RAM   | Modern i3 / Ryzen 3, **8 GB**           | Long delivery and stock lists, several tabs, a map                               |
| Screen      | **Dual 24"**                            | Surat Jalan on one, the stock or route list on the other                         |
| Printer     | **A4 laser** + the ESC/POS unit         | The Surat Jalan is the one LEGAL document (D-14); A4, in triplicate-style copies |

**Quantity: 2 terminals** — one per gudang staff member, both able to work a dispatch morning at once.

### 3.2 Cold-chain and floor

- **1 rugged Android tablet** for the floor: opname in the freezer, receiving at the dock. Same spec as
  §2.2, but **IP54 and rated to −20 °C** — a consumer tablet fails in a freezer, and freezer opname is a
  real recurring flow.
- Temperature probes are recorded through the app by a human today; no integration hardware is needed.

---

## 4. Main office

| Role                   | Device                             | Notes                                                              |
| ---------------------- | ---------------------------------- | ------------------------------------------------------------------ |
| Owner                  | Laptop, 16 GB, 14" 1080p           | Dashboards, approvals, everything                                  |
| Finance (1)            | Desktop/laptop 16 GB, **dual 24"** | Journal, payment ladder, xlsx exports side-by-side with the ledger |
| HR / Payroll (1)       | Laptop 8 GB                        | Payroll runs, attendance corrections, slip gaji                    |
| Managers (2, regional) | Laptop 8 GB + phone                | They travel; the phone covers approvals between branches           |

**Quantity: 5 computers.** Browser: Chrome or Edge, kept current — the app targets evergreen browsers and
uses `crypto.getRandomValues`, IndexedDB and modern CSS throughout.

**Also:** a small **UPS** for the office router and the finance machine. A payroll run interrupted
mid-write is recoverable, but avoiding it is cheaper than proving it.

---

## 5. Drivers — Android phone (× 2, + 1 spare)

The most demanding device per rupiah, because it is the only one that must do GPS, camera and maps in the
field, all day, sometimes with no signal.

| Requirement  | Minimum                               | Why                                                                          |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------- |
| Platform     | **Android 11+**, Chrome               | PWA install, service worker, Web APIs                                        |
| RAM          | **4 GB**                              | Leaflet map + offline job cache + camera buffer                              |
| Storage      | 128 GB                                | Photo + signature evidence per drop, held until sync (1.4)                   |
| **GPS**      | **Required — GNSS, not network-only** | Live truck tracking and the geofenced attendance check-in (200 m)            |
| Camera       | Rear ≥8 MP autofocus                  | Proof-of-delivery photo and the recipient's signature                        |
| Battery      | **≥5000 mAh**, + in-vehicle charger   | A full delivery run with GPS and screen on is the heaviest load in the fleet |
| Connectivity | 4G with a real data plan              | Route, sync and tracking                                                     |
| Protection   | Rugged case + vehicle mount           | It lives in a truck                                                          |

**Quantity: 2 (one per driver) + 1 spare = 3.**

> **GPS is not optional and not substitutable.** `driver` and the attendance geofence both call
> `navigator.geolocation`. A tablet with Wi-Fi-only positioning reports the last café it saw. If the budget
> forces a compromise, compromise on screen size, never on GNSS.

---

## 6. Shopping list and rough budget

| Item                                    | Qty | Unit (IDR, indicative) | Subtotal         |
| --------------------------------------- | --- | ---------------------- | ---------------- |
| Android tablet 10", 4 GB/64 GB (till)   | 22  | 2,500,000              | 55,000,000       |
| Android tablet 8–10", 4 GB/64 GB (spv)  | 22  | 2,200,000              | 48,400,000       |
| Bluetooth ESC/POS printer 80 mm         | 22  | 900,000                | 19,800,000       |
| Cash drawer                             | 20  | 700,000                | 14,000,000       |
| Rugged cold-rated tablet (gudang floor) | 1   | 6,000,000              | 6,000,000        |
| Gudang terminal + dual 24"              | 2   | 12,000,000             | 24,000,000       |
| A4 laser printer (gudang)               | 1   | 3,000,000              | 3,000,000        |
| Office laptops / desktops               | 5   | 12,000,000             | 60,000,000       |
| Office monitors (finance dual)          | 2   | 2,000,000              | 4,000,000        |
| Driver phone 4 GB/128 GB, 5000 mAh      | 3   | 3,000,000              | 9,000,000        |
| Rugged cases + vehicle mounts           | 3   | 500,000                | 1,500,000        |
| UPS (office)                            | 1   | 2,000,000              | 2,000,000        |
| 4G routers / dongles per outlet         | 20  | 800,000                | 16,000,000       |
| **Total**                               |     |                        | **~262,700,000** |

**Treat the money as indicative only.** Unit prices are placeholders for a vendor quote — I have no pricing
data and did not invent precision I do not have. What is defensible here is the **specification and the
quantities**; the rupiah column is a shape, not a quote.

**Recurring, not in the table:** 20 outlet data plans + 3 driver plans, and device replacement at roughly a
three-year cycle for the tablets.

---

## 7. What I would cut first, if the budget is tight

1. **Second tablet per outlet** (−22 units, ~48 M). Real cost is till contention during receiving. See the
   note in §2.2.
2. **Rugged cold-rated tablet** (−1, 6 M). The supervisor's tablet can do freezer opname in short bursts;
   expect a shorter life.
3. **Dual monitors for gudang** (−2 screens). Slower dispatch mornings, nothing broken.

**What I would not cut:** driver GNSS phones, 4 GB RAM anywhere that approves offline, 4G fallback at the
outlets, and the printers. Each of those turns a working feature off rather than making it slower.

---

## 8. Open questions for the vendor conversation

- **Android version support** — the fleet should be on one Android major version, and one that will still
  receive Chrome updates in three years.
- **Device management** — 45+ devices across four cities needs a story for locking them to the app and
  pushing updates. Nothing in this system provides that; an MDM is a separate purchase.
- **Printer model must be tested before bulk purchase.** ESC/POS is a family, not a standard, and Web
  Bluetooth GATT support varies by firmware. **Buy one, prove it against the app, then buy twenty-one.**
  `components/pos/receipt-printer.ts` builds the byte stream; that is where a mismatch will show.
