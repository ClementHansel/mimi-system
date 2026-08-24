// Shared login helper for every k6 scenario in this suite.
//
// Demo credentials come straight from `database/seed.ts` (`DEMO_PASSWORD =
// 'password123'`, `kasir_<code>_<shift>` / `driver<n>` / `owner` usernames) — see
// that file if the seed shape ever changes. Nothing here is a secret; it is
// the same fixed demo password the seed prints to its own console log.
import http from 'k6/http';
import { check } from 'k6';

const DEMO_PASSWORD = 'password123';

/**
 * POST /api/auth/login and return `{ accessToken, roleKey }`.
 * Throws (fails the iteration loudly, via `check`) rather than silently
 * returning an empty token — a perf run against a broken auth path should
 * show up as a wall of check failures, not as suspiciously-fast 401s.
 */
export function login(baseUrl, username) {
  const res = http.post(
    `${baseUrl}/api/auth/login`,
    JSON.stringify({ username, password: DEMO_PASSWORD }),
    { headers: { 'Content-Type': 'application/json' }, tags: { name: 'auth_login' } },
  );
  const ok = check(res, {
    'login: 200': (r) => r.status === 200,
    'login: has accessToken': (r) => {
      try {
        return !!JSON.parse(r.body).accessToken;
      } catch {
        return false;
      }
    },
  });
  if (!ok) {
    throw new Error(`login failed for ${username}: ${res.status} ${res.body}`);
  }
  const body = JSON.parse(res.body);
  return { accessToken: body.accessToken, roleKey: body.user ? body.user.roleKey : undefined };
}

export function authHeaders(token) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}
