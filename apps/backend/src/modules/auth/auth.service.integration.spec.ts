/**
 * Live-DB integration suite for M01 `auth` (CONTRACTS.md §4.1, SYNC-PROTOCOL
 * §7). Every test below runs `AuthService` against the REAL `mimi_app` pool
 * (`test-support/live-db.ts`) — the same connection identity `DATABASE_POOL`
 * uses in production (D-21/D-22). No mocked pool, no fake client forwarding
 * to a prepared row: a passing test here means the query actually executed
 * under real Postgres privileges and real RLS policies.
 */
import { hash as bcryptHash } from 'bcrypt';
import { afterAll, describe, expect, it } from 'vitest';
import { assertSystemContext, SYSTEM_CENTRAL_ROLE, withSystemContext } from '../../common/database/system-context';
import { hashPin } from './pin-hash.util';
import {
  assignUserToLocation,
  closeTestPool,
  deleteTestDevice,
  deleteTestUser,
  fetchOneLocationId,
  getAppPool,
  getOwnerPool,
  insertTestDevice,
  insertTestUser,
  withRawAppConnection,
} from './test-support/live-db';
import { buildAuthService } from './test-support/service-factory';

const TEST_PASSWORD = 'CorrectHorseBattery9!';
const TEST_PIN = '135790';

afterAll(async () => {
  await closeTestPool();
});

describe('RLS regression — the exact failure mode this whole harness exists to catch', () => {
  it('a raw mimi_app connection with NO SET LOCAL ROLE app_user gets permission denied reading `users`', async () => {
    await expect(
      withRawAppConnection(async (client) => {
        await client.query('SELECT * FROM users LIMIT 1');
      }),
    ).rejects.toThrow(/permission denied/i);
  });

  it('the SAME connection, after the canonical assertSystemContext(), succeeds', async () => {
    const client = await getAppPool().connect();
    try {
      await client.query('BEGIN');
      await assertSystemContext(client, { role: SYSTEM_CENTRAL_ROLE });
      const res = await client.query('SELECT * FROM users LIMIT 1');
      expect(res.rowCount).toBeGreaterThan(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });

  /**
   * PROTECTS THE FIX, does not re-document the defect. Originally this test
   * asserted the pre-fix crash directly (`app.user_id` reverting to `''` —
   * not NULL — after a prior transaction on a RECYCLED pooled connection,
   * throwing `22P02` inside `app_is_self()`'s bare `IS NOT NULL` guard). W1-C
   * has since fixed `app_is_self()` itself
   * (`NULLIF(current_setting(...), '') IS NOT NULL`, migration 2xx), so that
   * assertion started failing FOR THE RIGHT REASON — the bug it pinned is
   * gone. Per the coordinator: invert it. The mechanism-level regression
   * (the raw GUC behavior, independent of any table/migration) is now
   * `common/database/system-context.live-db.regression.spec.ts`'s job — this
   * test instead protects THIS module's own wiring: that `login`/`verifyPin`
   * calling the canonical `assertSystemContext`/`withSystemContext` continues
   * to work correctly through the real `users_select` policy on exactly the
   * kind of connection every production `DATABASE_POOL` connection becomes
   * after its first authenticated request. It goes red again if either the
   * `NULLIF` guard OR the canonical sentinel default is ever reverted.
   */
  it('protects the fix: a RECYCLED connection (previously used by a real authenticated transaction) still reads `users` correctly via the canonical assertSystemContext/withSystemContext — never throws', async () => {
    const client = await getAppPool().connect();
    try {
      // Poison the connection exactly like RlsContextGuard + RlsCleanupInterceptor
      // do for one real request: a real user_id, then rollback.
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.role', 'kasir', true)`);
      await client.query(`SELECT set_config('app.user_id', '11111111-1111-1111-1111-111111111111', true)`);
      await client.query('ROLLBACK');

      // Same physical connection, a later unrelated transaction — this is
      // every connection in this app after serving one authenticated request.
      await client.query('BEGIN');
      await expect(
        assertSystemContext(client, { role: SYSTEM_CENTRAL_ROLE }).then(() => client.query('SELECT * FROM users LIMIT 1')),
      ).resolves.toMatchObject({ rowCount: expect.any(Number) });
      const direct = await client.query('SELECT * FROM users LIMIT 1');
      expect(direct.rowCount).toBeGreaterThan(0);
      await client.query('ROLLBACK');

      // withSystemContext (a fresh connection from the pool — may or may not
      // be the same physical one, doesn't matter: the assertion is about the
      // helper's own correctness under this history, not connection identity).
      const result = await withSystemContext(getAppPool(), { role: SYSTEM_CENTRAL_ROLE }, (c) => c.query('SELECT * FROM users LIMIT 1'));
      expect(result.rowCount).toBeGreaterThan(0);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});

describe('AuthService.login — live DB', () => {
  it('succeeds with the right password, issues tokens, and reports mustSetPin=true for a fresh user', async () => {
    const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
    const userId = await insertTestUser({ username: `w301-login-${Date.now()}`, name: 'Test Login User', roleKey: 'kasir', passwordHash });
    try {
      const service = buildAuthService(getAppPool());
      const res = await service.login(
        { username: (await withUsername(userId)), password: TEST_PASSWORD },
        { ipAddress: '127.0.0.1', userAgent: 'vitest' },
      );
      expect(res.accessToken).toBeTruthy();
      expect(res.refreshToken).toBeTruthy();
      expect(res.user.id).toBe(userId);
      expect(res.user.mustSetPin).toBe(true);
      expect(res.user.roleKey).toBe('kasir');
      expect(res.offlineCredentials).toBeUndefined(); // kasir holds no auth.offline_credential.mint
    } finally {
      await deleteTestUser(userId);
    }
  });

  it('rejects a wrong password with ERR_AUTH_INVALID_CREDENTIALS (401), without revealing which field was wrong', async () => {
    const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
    const userId = await insertTestUser({ username: `w301-badpw-${Date.now()}`, name: 'Test Bad Password', roleKey: 'kasir', passwordHash });
    try {
      const service = buildAuthService(getAppPool());
      const username = await withUsername(userId);
      await expect(service.login({ username, password: 'wrong-password' }, { ipAddress: null, userAgent: null })).rejects.toMatchObject({
        response: { code: 'ERR_AUTH_INVALID_CREDENTIALS' },
      });
    } finally {
      await deleteTestUser(userId);
    }
  });

  it('rejects an unknown username with the SAME error code as a wrong password (no username enumeration)', async () => {
    const service = buildAuthService(getAppPool());
    await expect(
      service.login({ username: `no-such-user-${Date.now()}`, password: 'whatever' }, { ipAddress: null, userAgent: null }),
    ).rejects.toMatchObject({ response: { code: 'ERR_AUTH_INVALID_CREDENTIALS' } });
  });

  it('mints an offline credential for a SUPERVISOR with a deviceId + PIN already set, capped by the void_refund escalation threshold; a KASIR gets none even with the same inputs', async () => {
    const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
    const pinHash = await hashPin(TEST_PIN);
    const locationId = await fetchOneLocationId('outlet');

    const supervisorId = await insertTestUser({
      username: `w301-spv-${Date.now()}`,
      name: 'Test Supervisor',
      roleKey: 'supervisor',
      passwordHash,
      pinHash,
    });
    const kasirId = await insertTestUser({
      username: `w301-ksr-${Date.now()}`,
      name: 'Test Kasir',
      roleKey: 'kasir',
      passwordHash,
      pinHash,
    });
    await assignUserToLocation(supervisorId, locationId);
    await assignUserToLocation(kasirId, locationId);
    const deviceId = await insertTestDevice(locationId);

    try {
      const service = buildAuthService(getAppPool());

      const spvRes = await service.login(
        { username: await withUsername(supervisorId), password: TEST_PASSWORD, deviceId },
        { ipAddress: null, userAgent: null },
      );
      expect(spvRes.offlineCredentials).toHaveLength(1);
      const cred = spvRes.offlineCredentials![0]!;
      expect(cred.scopes['void_refund.approve']).toBeDefined();
      expect(cred.scopes['replenishment.supervisor_approve']).toEqual({});
      expect(cred.scopes['waste.approve']).toEqual({});
      // §5.2's escalation threshold (seeded 200000.00, migration 069) is the supervisor's effective offline ceiling.
      expect(cred.scopes['void_refund.approve']?.maxIdr).toBe('200000.00');

      const ksrRes = await service.login(
        { username: await withUsername(kasirId), password: TEST_PASSWORD, deviceId },
        { ipAddress: null, userAgent: null },
      );
      expect(ksrRes.offlineCredentials).toBeUndefined();
    } finally {
      await deleteTestUser(supervisorId);
      await deleteTestUser(kasirId);
      await deleteTestDevice(deviceId);
    }
  });
});

describe('AuthService.refresh — live DB, token rotation', () => {
  it('rotates the refresh token and rejects the OLD one on reuse', async () => {
    const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
    const userId = await insertTestUser({ username: `w301-refresh-${Date.now()}`, name: 'Test Refresh User', roleKey: 'kasir', passwordHash });
    try {
      const service = buildAuthService(getAppPool());
      const login = await service.login({ username: await withUsername(userId), password: TEST_PASSWORD }, { ipAddress: null, userAgent: null });

      const rotated = await service.refresh({ refreshToken: login.refreshToken });
      expect(rotated.accessToken).toBeTruthy();
      expect(rotated.refreshToken).toBeTruthy();
      expect(rotated.refreshToken).not.toBe(login.refreshToken);

      // Old token is signature-valid (not yet expired) but no longer matches the rotated session's hash → rejected,
      // AND (reuse-detection) the whole session is revoked defensively — presenting a stale refresh token is
      // exactly what a stolen-and-replayed token looks like, so the entire chain dies, not just this one call.
      await expect(service.refresh({ refreshToken: login.refreshToken })).rejects.toMatchObject({
        response: { code: 'ERR_AUTH_TOKEN_INVALID' },
      });

      // The rotated token is ALSO now dead — reuse detection revoked the session it belonged to.
      await expect(service.refresh({ refreshToken: rotated.refreshToken })).rejects.toMatchObject({
        response: { code: 'ERR_AUTH_TOKEN_INVALID' },
      });
    } finally {
      await deleteTestUser(userId);
    }
  });

  it('the normal (non-adversarial) chain: rotated token keeps working across two consecutive refreshes', async () => {
    const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
    const userId = await insertTestUser({ username: `w301-refresh-chain-${Date.now()}`, name: 'Test Refresh Chain', roleKey: 'kasir', passwordHash });
    try {
      const service = buildAuthService(getAppPool());
      const login = await service.login({ username: await withUsername(userId), password: TEST_PASSWORD }, { ipAddress: null, userAgent: null });

      const first = await service.refresh({ refreshToken: login.refreshToken });
      const second = await service.refresh({ refreshToken: first.refreshToken });
      expect(second.accessToken).toBeTruthy();
      expect(second.refreshToken).not.toBe(first.refreshToken);
    } finally {
      await deleteTestUser(userId);
    }
  });

  it('rejects a garbage refresh token', async () => {
    const service = buildAuthService(getAppPool());
    await expect(service.refresh({ refreshToken: 'not-a-real-jwt' })).rejects.toMatchObject({ response: { code: 'ERR_AUTH_TOKEN_INVALID' } });
  });
});

describe('AuthService.verifyPin — live DB, cross-user read (FR-POS-03)', () => {
  it('a kasir-initiated call verifying a DIFFERENT (supervisor) user\'s PIN succeeds when correct', async () => {
    const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
    const pinHash = await hashPin(TEST_PIN);
    const supervisorId = await insertTestUser({ username: `w301-verifypin-${Date.now()}`, name: 'Test Verify Pin', roleKey: 'supervisor', passwordHash, pinHash });
    try {
      const service = buildAuthService(getAppPool());
      const res = await service.verifyPin({ userId: supervisorId, pin: TEST_PIN, context: 'pos_override' });
      expect(res.ok).toBe(true);
      expect(res.verifierToken).toBeTruthy();
    } finally {
      await deleteTestUser(supervisorId);
    }
  });

  it('rejects the wrong PIN for that same cross-user case', async () => {
    const passwordHash = await bcryptHash(TEST_PASSWORD, 10);
    const pinHash = await hashPin(TEST_PIN);
    const supervisorId = await insertTestUser({ username: `w301-verifypin-bad-${Date.now()}`, name: 'Test Verify Pin Bad', roleKey: 'supervisor', passwordHash, pinHash });
    try {
      const service = buildAuthService(getAppPool());
      await expect(service.verifyPin({ userId: supervisorId, pin: '000000', context: 'pos_override' })).rejects.toMatchObject({
        response: { code: 'ERR_AUTH_PIN_INVALID' },
      });
    } finally {
      await deleteTestUser(supervisorId);
    }
  });
});

/** Convenience: read back a test user's username from the owner pool (fixture-side lookup, not the code under test). */
async function withUsername(userId: string): Promise<string> {
  const res = await getOwnerPool().query<{ username: string }>('SELECT username FROM users WHERE id = $1', [userId]);
  return res.rows[0]!.username;
}
