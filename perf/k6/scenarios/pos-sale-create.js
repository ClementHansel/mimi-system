// POST /api/pos/sales — the write path FR-POS-04/06 hangs off, and the
// single highest-consequence hot endpoint in the system: every cash-register
// transaction across 20 outlets goes through `PosSaleService.applySaleFact`
// (apps/backend/src/modules/pos/services/pos-sale.service.ts), which inserts
// `sales` + N `sale_lines` + N `sale_payments`, updates the shift totals, and
// posts a recipe-usage stock movement — all inside one transaction.
//
// NFR-01 (docs/ACCEPTANCE.md §7): 150 concurrent users, < 3s. That is the
// ONLY written target; PER_ENDPOINT_P95_MS below applies it to this one
// endpoint, same convention as the other scenario scripts in this suite.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, OUTLET_CODES, outletCodeForVu } from '../lib/config.js';
import { login, authHeaders } from '../lib/auth.js';
import { uuidv4 } from '../lib/uuid.js';

const PER_ENDPOINT_P95_MS = 3000;

export const options = {
  scenarios: {
    sale_create: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 150 },
        { duration: '2m', target: 150 },
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: [`p(95)<${PER_ENDPOINT_P95_MS}`],
    http_req_failed: ['rate<0.01'],
  },
};

/** One session per outlet: login, ensure an open shift, grab a real product to sell. */
function bootstrapOutlet(code) {
  const { accessToken } = login(BASE_URL, `kasir1_${code.toLowerCase()}`);
  const headers = authHeaders(accessToken);

  const catalogRes = http.get(`${BASE_URL}/api/pos/catalog`, { headers });
  const product = JSON.parse(catalogRes.body).products[0];
  if (!product) throw new Error(`no active product in catalog for ${code} — seed not loaded?`);

  const currentRes = http.get(`${BASE_URL}/api/pos/shifts/current`, { headers });
  let shift = currentRes.status === 200 ? JSON.parse(currentRes.body) : null;

  if (!shift) {
    // locationId is required by OpenShiftDto but this script never learned it directly —
    // `GET /api/pos/shifts/current` with no filter plus the 409-on-conflict open() call
    // below is what actually needs it, so resolve it via `GET /api/auth/me` (issues no
    // extra dependency: every login already returns `user.locations`).
    const meRes = http.get(`${BASE_URL}/api/auth/me`, { headers });
    const me = JSON.parse(meRes.body);
    const locationId = me.locations && me.locations[0] && me.locations[0].id;
    if (!locationId) throw new Error(`kasir1_${code.toLowerCase()} has no assigned location`);

    const openRes = http.post(
      `${BASE_URL}/api/pos/shifts/open`,
      JSON.stringify({ clientId: uuidv4(), locationId, openingCash: '500000.00' }),
      { headers },
    );
    if (openRes.status !== 200 && openRes.status !== 201) {
      throw new Error(`shift open failed for ${code}: ${openRes.status} ${openRes.body}`);
    }
    shift = JSON.parse(openRes.body);
  }

  return { headers, shiftId: shift.id, locationId: shift.locationId, product };
}

export function setup() {
  // Bootstrapping 20 outlets' shifts up front keeps the timed request in the
  // default() function to exactly one thing: POST /pos/sales.
  const outlets = {};
  for (const code of OUTLET_CODES) {
    outlets[code] = bootstrapOutlet(code);
  }
  return { outlets };
}

export default function (data) {
  const code = outletCodeForVu(__VU);
  const o = data.outlets[code];

  const qty = '1.000';
  const unitPrice = o.product.price;
  const body = {
    clientId: uuidv4(), // fresh every call — a real sale, not a replay
    shiftId: o.shiftId,
    locationId: o.locationId,
    occurredAt: new Date().toISOString(),
    lines: [{ productId: o.product.id, qty, unitPrice }],
    payments: [{ method: 'cash', amount: unitPrice }],
  };

  const res = http.post(`${BASE_URL}/api/pos/sales`, JSON.stringify(body), {
    headers: o.headers,
    tags: { name: 'pos_sale_create' },
  });
  check(res, {
    'sale: 200/201': (r) => r.status === 200 || r.status === 201,
  });
  sleep(1); // one sale per second per till is already a busy cashier
}
