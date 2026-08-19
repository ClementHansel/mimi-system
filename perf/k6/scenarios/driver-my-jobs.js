// GET /api/delivery/my-jobs — F13 driver app's pre-departure cache pull
// (SuratJalanService.myJobs, apps/backend/src/modules/delivery/services/
// surat-jalan.service.ts:119-142).
//
// THIS IS THE #1 N+1 FINDING IN THIS TICKET'S REPORT, WORST CASE — see
// perf/README.md. Per assigned SJ, `myJobs` runs `selectSuratJalanHeader`
// (1 query) then `buildSuratJalanFull` (queries.ts:306-315), which fires
// FOUR MORE queries in parallel (drops, lines, temp logs, seals) — 5 queries
// per Surat Jalan. A driver with even a modest multi-drop day (a handful of
// SJs) turns one app-open into 20-30+ queries. Concurrency here is bounded
// by the driver fleet (a handful of trucks, not 150 tablets), so this
// scenario is deliberately a LOW-VU, steady-state probe rather than a
// ramp to NFR-01's 150 — the number that matters here is query count and
// per-call latency, not raw throughput.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../lib/config.js';
import { login, authHeaders } from '../lib/auth.js';

export const options = {
  scenarios: {
    driver_my_jobs: {
      executor: 'constant-vus',
      vus: 5, // realistic fleet size on the road at once, not NFR-01's 150
      duration: '1m',
    },
  },
  thresholds: {
    // No written NFR covers this specific endpoint's latency (see file
    // header) — NFR-01's number is reused here only as a ceiling, not as a
    // claim that it was derived for this case.
    http_req_duration: ['p(95)<3000'],
    http_req_failed: ['rate<0.01'],
  },
};

export function setup() {
  const { accessToken } = login(BASE_URL, 'driver1');
  return { headers: authHeaders(accessToken) };
}

export default function (data) {
  const res = http.get(`${BASE_URL}/api/delivery/my-jobs`, {
    headers: data.headers,
    tags: { name: 'driver_my_jobs' },
  });
  check(res, { 'my-jobs: 200': (r) => r.status === 200 });
  sleep(3); // app-open cadence, not a poll loop
}
