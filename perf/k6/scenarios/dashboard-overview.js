// GET /api/dashboard/overview — FR-DASH-01, the owner/manager landing tile.
// Backed entirely by `mv_sales_daily` (a materialized view refreshed on a
// schedule, `dashboard/matview-refresh.service.ts`) plus one live aggregate
// over `sales`/`sale_lines`/`recipes` for the COGS estimate
// (`overview.service.ts`'s `estimateCogs`) — see that file for why this is
// NOT N+1 (single aggregate query, no per-row loop) but IS a real join across
// four tables with no covering index dedicated to it (see perf/README.md's
// index-review section).
//
// Lower expected concurrency than POS (this is a laptop/dashboard surface,
// not a per-outlet tablet), but still folded under NFR-01's one stated
// number since nothing narrower is written down anywhere in the repo.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../lib/config.js';
import { login, authHeaders } from '../lib/auth.js';

const PER_ENDPOINT_P95_MS = 3000;

export const options = {
  scenarios: {
    dashboard_overview: {
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

export function setup() {
  // `owner` is a CENTRAL role (common/scope/scope.service.ts) — unrestricted
  // locationScope, so this exercises the worst-case (all-outlets) aggregate,
  // not one outlet's slice.
  const { accessToken } = login(BASE_URL, 'owner');
  return { headers: authHeaders(accessToken) };
}

export default function (data) {
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 29 * 86_400_000).toISOString().slice(0, 10);

  const res = http.get(`${BASE_URL}/api/dashboard/overview?from=${from}&to=${to}`, {
    headers: data.headers,
    tags: { name: 'dashboard_overview' },
  });
  check(res, {
    'overview: 200': (r) => r.status === 200,
    'overview: has revenue': (r) => {
      try {
        return typeof JSON.parse(r.body).revenue === 'string';
      } catch {
        return false;
      }
    },
  });
  sleep(2); // a dashboard polls/refreshes, it does not hammer
}
