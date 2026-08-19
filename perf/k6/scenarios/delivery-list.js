// GET /api/delivery/surat-jalan — the dispatcher's Surat Jalan list.
//
// THIS IS THE ENDPOINT BEHIND THE #1 N+1 FINDING IN THIS TICKET'S REPORT
// (see perf/README.md "N+1 findings"): `SuratJalanService.list()`
// (apps/backend/src/modules/delivery/services/surat-jalan.service.ts:100-111)
// runs one query to page the ids, then TWO more queries PER ROW
// (`selectSuratJalanHeader` + `buildSuratJalanSummary`, which itself queries
// `sj_drops`) via `queries.ts`. At the default pageSize (50) that is up to
// ~101 queries for one list call. This script exists to make that concrete
// and repeatable under load, not just point at the code — watch
// `pos_duration`/`http_req_duration` scale with `pageSize` and outlet count
// as evidence for the fix ticket.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from '../lib/config.js';
import { login, authHeaders } from '../lib/auth.js';

const PER_ENDPOINT_P95_MS = 3000; // NFR-01's number, applied per-endpoint — see pos-catalog-read.js header.

export const options = {
  scenarios: {
    delivery_list: {
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
  // kepala_gudang holds delivery.read and, per `ScopeService.kepalaGudangScope`,
  // sees the warehouse plus every outlet it has ever shipped to — realistically
  // the busiest legitimate caller of this list, busier than a single-outlet role.
  const { accessToken } = login(BASE_URL, 'kepalagudang1');
  return { headers: authHeaders(accessToken) };
}

export default function (data) {
  // pageSize is deliberately the DTO default (50) — see `ListSuratJalanQueryDto`
  // in dto/surat-jalan.dto.ts. Override with PAGE_SIZE to probe how the N+1
  // above scales (e.g. `k6 run -e PAGE_SIZE=100 ...`).
  const pageSize = __ENV.PAGE_SIZE || 50;
  const res = http.get(`${BASE_URL}/api/delivery/surat-jalan?page=1&pageSize=${pageSize}`, {
    headers: data.headers,
    tags: { name: 'delivery_list' },
  });
  check(res, {
    'delivery list: 200': (r) => r.status === 200,
    'delivery list: has rows': (r) => {
      try {
        return Array.isArray(JSON.parse(r.body).rows);
      } catch {
        return false;
      }
    },
  });
  sleep(2);
}
