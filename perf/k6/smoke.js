// A tiny (1-2 VU) sanity check, NOT a load test. Run this first, once, to
// confirm the suite's assumptions (seed loaded, demo creds valid, base URL
// reachable) before running anything at NFR-01's 150 VUs — a broken
// assumption at 150 VUs just produces 150x the same failed request.
//
// Constraint (see perf/README.md): only ever point this at a LOCAL stack
// that is already running. Never at the shared VPS. Default BASE_URL is
// localhost:4000, so running this with no flags at all is always safe.
import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './lib/config.js';
import { login, authHeaders } from './lib/auth.js';

export const options = {
  vus: 1,
  iterations: 1,
};

export default function () {
  // NOTE: `/sync/v1/*` is deliberately a BARE path family (no `/api` prefix)
  // — see main.ts's `setGlobalPrefix` exclude list and its header comment.
  const health = http.get(`${BASE_URL}/sync/v1/health`);
  check(health, { 'sync health: 200': (r) => r.status === 200 });

  const { accessToken } = login(BASE_URL, 'owner');
  check(accessToken, { 'login: got a token': (t) => !!t });

  const catalog = http.get(`${BASE_URL}/api/pos/catalog`, { headers: authHeaders(accessToken) });
  check(catalog, {
    'catalog: 200': (r) => r.status === 200,
    'catalog: non-empty': (r) => {
      try {
        return JSON.parse(r.body).products.length > 0;
      } catch {
        return false;
      }
    },
  });

  const overview = http.get(`${BASE_URL}/api/dashboard/overview?from=2026-08-01&to=2026-08-19`, {
    headers: authHeaders(accessToken),
  });
  check(overview, { 'dashboard overview: 200': (r) => r.status === 200 });
}
