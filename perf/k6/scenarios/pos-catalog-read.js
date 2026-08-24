// GET /api/pos/catalog — every POS tablet's precache pull (FR-POS-01).
// Read-only, no per-device data (same response for every caller at every
// outlet today), so this is close to a pure "how fast can the backend answer
// its single most-hit read" measurement.
//
// NFR-01 is the only written-down target (150 concurrent users, < 3s) — see
// docs/ACCEPTANCE.md §7. There is no PER-ENDPOINT target in the repo, so the
// threshold below applies NFR-01's number to this one endpoint in isolation.
// If the owner wants a tighter per-endpoint budget, change PER_ENDPOINT_P95_MS
// below — it is the one number in this file that is not sourced from a doc.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL, outletCodeForVu } from '../lib/config.js';
import { login, authHeaders } from '../lib/auth.js';

const PER_ENDPOINT_P95_MS = 3000; // NFR-01's number, applied per-endpoint — see header.

export const options = {
  scenarios: {
    catalog_read: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 150 }, // ramp to NFR-01's 150 concurrent
        { duration: '2m', target: 150 }, // hold
        { duration: '15s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: [`p(95)<${PER_ENDPOINT_P95_MS}`],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  // One token per outlet's kasir, minted once — login itself is not the
  // thing under test here, and re-logging in every iteration would make the
  // catalog endpoint's own latency invisible under auth overhead.
  const tokensByCode = {};
  for (const code of ['BPP01', 'SMD01', 'BJM01', 'PTK01']) {
    const { accessToken } = login(BASE_URL, `kasir_${code.toLowerCase()}_p`);
    tokensByCode[code] = accessToken;
  }
  return { tokensByCode };
}

export default function (data) {
  const code = outletCodeForVu(__VU);
  // Fall back to one of the four logged-in codes if this VU's outlet wasn't
  // pre-authenticated in setup() (keeps the token map small and setup fast).
  const token =
    data.tokensByCode[code] ||
    data.tokensByCode.BPP01 ||
    data.tokensByCode.SMD01 ||
    data.tokensByCode.BJM01 ||
    data.tokensByCode.PTK01;

  const res = http.get(`${BASE_URL}/api/pos/catalog`, {
    headers: authHeaders(token),
    tags: { name: 'pos_catalog_read' },
  });
  check(res, {
    'catalog: 200': (r) => r.status === 200,
    'catalog: has products array': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).products);
      } catch {
        return false;
      }
    },
  });
  sleep(1); // a tablet precaches on open/reconnect, not in a tight loop
}
