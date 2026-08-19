// NFR-01 (docs/ACCEPTANCE.md §7): "150 concurrent users, < 3s". This is the
// gate script — it is the one currently evidenced by NOTHING, and W6-05's
// primary deliverable is making that "NONE" cell true or false with a real
// number.
//
// The five scenario files under scenarios/ each hammer ONE endpoint at the
// full 150 VUs to isolate that endpoint's own behavior. This file instead
// SPLITS 150 concurrent VUs across a traffic mix that approximates what the
// 20-outlet fleet actually does at once, because 150 real concurrent users
// are not 150 people all hammering the same button — they are cashiers
// (many, high-frequency), a couple of dispatchers, a couple of owners
// glancing at a dashboard, and a handful of drivers. The split below is a
// judgment call, not a measured traffic profile (none exists in this repo)
// — documented here so the next person can correct it from real data:
//
//   90 VUs (60%) — POS catalog read + sale create (the actual cashier loop)
//   30 VUs (20%) — POS catalog read only (idle tablets re-checking price list)
//   15 VUs (10%) — dashboard overview (owner/manager glance)
//   10 VUs ( 7%) — delivery list (dispatcher)
//    5 VUs ( 3%) — driver my-jobs
//
// Run: k6 run -e BASE_URL=http://localhost:4000 perf/k6/nfr01-150-concurrent.js
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, OUTLET_CODES, outletCodeForVu } from './lib/config.js';
import { login, authHeaders } from './lib/auth.js';
import { uuidv4 } from './lib/uuid.js';

const NFR01_P95_MS = 3000; // the one number the repo actually states.
const RAMP_UP = __ENV.RAMP_UP || '30s';
const HOLD = __ENV.HOLD || '2m';
const RAMP_DOWN = __ENV.RAMP_DOWN || '15s';

function stages(target) {
  return [
    { duration: RAMP_UP, target },
    { duration: HOLD, target },
    { duration: RAMP_DOWN, target: 0 },
  ];
}

export const options = {
  scenarios: {
    cashier_loop: {
      executor: 'ramping-vus',
      exec: 'cashierLoop',
      startVUs: 0,
      stages: stages(90),
    },
    idle_catalog_poll: {
      executor: 'ramping-vus',
      exec: 'catalogOnly',
      startVUs: 0,
      stages: stages(30),
    },
    owner_dashboard: {
      executor: 'ramping-vus',
      exec: 'dashboardOverview',
      startVUs: 0,
      stages: stages(15),
    },
    dispatcher_list: {
      executor: 'ramping-vus',
      exec: 'deliveryList',
      startVUs: 0,
      stages: stages(10),
    },
    driver_jobs: {
      executor: 'ramping-vus',
      exec: 'driverMyJobs',
      startVUs: 0,
      stages: stages(5),
    },
  },
  // ONE threshold, applied to the whole run — this is literally NFR-01's
  // sentence turned into a k6 threshold. Per-endpoint breakdowns are in the
  // individual scenarios/*.js scripts, not here.
  thresholds: {
    http_req_duration: [`p(95)<${NFR01_P95_MS}`],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const kasirTokens = {};
  for (const code of OUTLET_CODES.slice(0, 4)) {
    kasirTokens[code] = login(BASE_URL, `kasir1_${code.toLowerCase()}`).accessToken;
  }
  const ownerToken = login(BASE_URL, 'owner').accessToken;
  const dispatcherToken = login(BASE_URL, 'kepalagudang1').accessToken;
  const driverToken = login(BASE_URL, 'driver1').accessToken;

  // Bootstrap one open shift + a real product per pre-authenticated outlet,
  // same approach as scenarios/pos-sale-create.js — see that file for why.
  const shiftsByCode = {};
  for (const code of Object.keys(kasirTokens)) {
    const headers = authHeaders(kasirTokens[code]);
    const catalogRes = http.get(`${BASE_URL}/api/pos/catalog`, { headers });
    const product = JSON.parse(catalogRes.body).products[0];
    const meRes = http.get(`${BASE_URL}/api/auth/me`, { headers });
    const locationId = JSON.parse(meRes.body).locations[0].id;
    const currentRes = http.get(`${BASE_URL}/api/pos/shifts/current`, { headers });
    let shift = currentRes.status === 200 ? JSON.parse(currentRes.body) : null;
    if (!shift) {
      const openRes = http.post(
        `${BASE_URL}/api/pos/shifts/open`,
        JSON.stringify({ clientId: uuidv4(), locationId, openingCash: '500000.00' }),
        { headers },
      );
      shift = JSON.parse(openRes.body);
    }
    shiftsByCode[code] = { headers, product, shiftId: shift.id, locationId };
  }

  return {
    kasirTokens,
    shiftsByCode,
    ownerHeaders: authHeaders(ownerToken),
    dispatcherHeaders: authHeaders(dispatcherToken),
    driverHeaders: authHeaders(driverToken),
  };
}

function outletFor(data) {
  const codes = Object.keys(data.shiftsByCode);
  return data.shiftsByCode[codes[(__VU - 1) % codes.length]];
}

// ── The busy cashier: catalog check + one sale per iteration ───────────────
export function cashierLoop(data) {
  const o = outletFor(data);
  http.get(`${BASE_URL}/api/pos/catalog`, {
    headers: o.headers,
    tags: { name: 'pos_catalog_read' },
  });

  const body = {
    clientId: uuidv4(),
    shiftId: o.shiftId,
    locationId: o.locationId,
    occurredAt: new Date().toISOString(),
    lines: [{ productId: o.product.id, qty: '1.000', unitPrice: o.product.price }],
    payments: [{ method: 'cash', amount: o.product.price }],
  };
  const res = http.post(`${BASE_URL}/api/pos/sales`, JSON.stringify(body), {
    headers: o.headers,
    tags: { name: 'pos_sale_create' },
  });
  check(res, { 'sale: 200/201': (r) => r.status === 200 || r.status === 201 });
  sleep(1);
}

// ── An idle tablet, just re-checking the price list ─────────────────────
export function catalogOnly(data) {
  const o = outletFor(data);
  const res = http.get(`${BASE_URL}/api/pos/catalog`, {
    headers: o.headers,
    tags: { name: 'pos_catalog_read' },
  });
  check(res, { 'catalog: 200': (r) => r.status === 200 });
  sleep(2);
}

export function dashboardOverview(data) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);
  const res = http.get(`${BASE_URL}/api/dashboard/overview?from=${from}&to=${to}`, {
    headers: data.ownerHeaders,
    tags: { name: 'dashboard_overview' },
  });
  check(res, { 'overview: 200': (r) => r.status === 200 });
  sleep(2);
}

export function deliveryList(data) {
  const res = http.get(`${BASE_URL}/api/delivery/surat-jalan?page=1&pageSize=50`, {
    headers: data.dispatcherHeaders,
    tags: { name: 'delivery_list' },
  });
  check(res, { 'delivery list: 200': (r) => r.status === 200 });
  sleep(2);
}

export function driverMyJobs(data) {
  const res = http.get(`${BASE_URL}/api/delivery/my-jobs`, {
    headers: data.driverHeaders,
    tags: { name: 'driver_my_jobs' },
  });
  check(res, { 'my-jobs: 200': (r) => r.status === 200 });
  sleep(3);
}
