import { createHmac, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodeUnlockCode, RoleKey, unlockCodeMessage } from '@mimi/shared';
import { encryptBindingSecret, encKeyFromConfig } from '../../kernel/sync/binding-crypto';
import type { JwtAccessPayload } from '../../common/jwt/jwt-payload.interface';
import { buildAuthService, buildConfigService } from './test-support/service-factory';
import {
  closeTestPool,
  fetchOneUserId,
  getAppPool,
  getOwnerPool,
  withRollback,
} from './test-support/live-db';

/**
 * B-17 — the SERVER half of the offline unlock channel (owner Q7).
 *
 * Two things are worth proving here and nothing else is:
 *
 *  1. The code this mints is the one the DEVICE will accept. Asserted against a
 *     digest computed inline, not against the service's own helper — the same
 *     discipline the §7.3 binding fixture adopted after a two-tier HMAC shipped
 *     with two different joiner characters and failed silently.
 *  2. The authority rule actually bites. `auth.lockout.clear` gets a caller to
 *     the method; the STRICT rank comparison is what decides it, and a peer must
 *     be refused (owner Q6 — otherwise two supervisors unlock each other all day).
 *
 * The device's matching half lives in
 * `apps/frontend/src/lib/local/credentials/unlock-code.test.ts`.
 */

const hasDb = Boolean(process.env.DATABASE_URL);
const K = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');

let supervisorId: string;
let kasirId: string;
let managerId: string;

/** Inserts a credential over the OWNER pool — `offline_credentials` is self-only, so the harness cannot use the app pool. */
async function insertCredential(userId: string, roleKey: string): Promise<string> {
  const credentialId = randomUUID();
  const enc = encryptBindingSecret(K, encKeyFromConfig(buildConfigService()));
  await getOwnerPool().query(
    `INSERT INTO offline_credentials
       (credential_id, user_id, role_key, location_ids, scopes, binding_secret_enc,
        pin_verifier, expires_at)
     VALUES ($1, $2, $3, '{}'::uuid[], '{}'::jsonb, $4, 'fake-argon2id', NOW() + INTERVAL '1 day')`,
    [credentialId, userId, roleKey, enc],
  );
  return credentialId;
}

async function deleteCredential(credentialId: string): Promise<void> {
  await getOwnerPool().query(`DELETE FROM offline_credentials WHERE credential_id = $1`, [
    credentialId,
  ]);
}

function caller(userId: string, roleKey: RoleKey): JwtAccessPayload {
  return { sub: userId, roleKey, locationIds: [] } as unknown as JwtAccessPayload;
}

/** What the DEVICE will compute, spelled out rather than borrowed from the service. */
function expectedCode(credentialId: string, challenge: string): string {
  const hex = createHmac('sha256', K)
    .update(unlockCodeMessage(credentialId, challenge), 'utf8')
    .digest('hex');
  return encodeUnlockCode(hex);
}

beforeAll(async () => {
  if (!hasDb) return;
  supervisorId = (await fetchOneUserId('supervisor')).id;
  kasirId = (await fetchOneUserId('kasir')).id;
  managerId = (await fetchOneUserId('manager')).id;
});

afterAll(async () => {
  if (!hasDb) return;
  await closeTestPool();
});

describe.skipIf(!hasDb)('B-17 offline unlock code — live DB', () => {
  it('mints exactly the code the device will accept for that challenge', async () => {
    const credentialId = await insertCredential(supervisorId, 'supervisor');
    try {
      await withRollback(
        async (client) => {
          const service = buildAuthService(getAppPool());
          const res = await service.issueOfflineUnlockCode(
            credentialId,
            { challenge: '481920' },
            caller(managerId, RoleKey.MANAGER),
            client,
          );
          expect(res.code).toBe(expectedCode(credentialId, '481920'));
          expect(res.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
        },
        { userId: managerId, roleKey: 'manager' },
      );
    } finally {
      await deleteCredential(credentialId);
    }
  }, 30_000);

  it('a different challenge produces a different code — an old one cannot be replayed', async () => {
    const credentialId = await insertCredential(supervisorId, 'supervisor');
    try {
      await withRollback(
        async (client) => {
          const service = buildAuthService(getAppPool());
          const a = await service.issueOfflineUnlockCode(
            credentialId,
            { challenge: '111111' },
            caller(managerId, RoleKey.MANAGER),
            client,
          );
          const b = await service.issueOfflineUnlockCode(
            credentialId,
            { challenge: '222222' },
            caller(managerId, RoleKey.MANAGER),
            client,
          );
          expect(a.code).not.toBe(b.code);
        },
        { userId: managerId, roleKey: 'manager' },
      );
    } finally {
      await deleteCredential(credentialId);
    }
  }, 30_000);

  it('refuses a caller who does not STRICTLY outrank the credential holder', async () => {
    const credentialId = await insertCredential(supervisorId, 'supervisor');
    try {
      await withRollback(
        async (client) => {
          const service = buildAuthService(getAppPool());
          // Supervisor vs supervisor: equal rank, refused. This is what stops
          // two supervisors unlocking each other indefinitely (owner Q6).
          await expect(
            service.issueOfflineUnlockCode(
              credentialId,
              { challenge: '481920' },
              caller(supervisorId, RoleKey.SUPERVISOR),
              client,
            ),
          ).rejects.toMatchObject({ response: { code: 'ERR_FORBIDDEN' } });
        },
        { userId: supervisorId, roleKey: 'supervisor' },
      );
    } finally {
      await deleteCredential(credentialId);
    }
  }, 30_000);

  it('a supervisor CAN unlock a kasir — the rank rule permits as well as refuses', async () => {
    const credentialId = await insertCredential(kasirId, 'kasir');
    try {
      await withRollback(
        async (client) => {
          const service = buildAuthService(getAppPool());
          const res = await service.issueOfflineUnlockCode(
            credentialId,
            { challenge: '481920' },
            caller(supervisorId, RoleKey.SUPERVISOR),
            client,
          );
          expect(res.code).toBe(expectedCode(credentialId, '481920'));
        },
        { userId: supervisorId, roleKey: 'supervisor' },
      );
    } finally {
      await deleteCredential(credentialId);
    }
  }, 30_000);

  it('refuses a REVOKED credential — unlocking one would resurrect an authorization someone killed', async () => {
    const credentialId = await insertCredential(supervisorId, 'supervisor');
    await getOwnerPool().query(
      `UPDATE offline_credentials SET revoked_at = NOW() WHERE credential_id = $1`,
      [credentialId],
    );
    try {
      await withRollback(
        async (client) => {
          const service = buildAuthService(getAppPool());
          // Migration 206's function filters nothing, so this is the service's
          // own check — and it must be a refusal, not a 404, so head office is
          // told the credential exists and was deliberately killed.
          await expect(
            service.issueOfflineUnlockCode(
              credentialId,
              { challenge: '481920' },
              caller(managerId, RoleKey.MANAGER),
              client,
            ),
          ).rejects.toMatchObject({ response: { code: 'ERR_FORBIDDEN' } });
        },
        { userId: managerId, roleKey: 'manager' },
      );
    } finally {
      await deleteCredential(credentialId);
    }
  }, 30_000);

  it('reads a credential belonging to SOMEONE ELSE, which a plain SELECT could not do', async () => {
    // The point of this test is the RLS boundary, not the code. `offline_creden
    // tials` is `app_is_self(user_id)` with no central arm (migration 126), so a
    // manager querying a supervisor's row directly gets ZERO rows — silently.
    // Going through migration 206's SECURITY DEFINER function is what makes the
    // whole feature possible, and this asserts the difference.
    const credentialId = await insertCredential(supervisorId, 'supervisor');
    try {
      await withRollback(
        async (client) => {
          const direct = await client.query(
            `SELECT credential_id FROM offline_credentials WHERE credential_id = $1`,
            [credentialId],
          );
          expect(direct.rowCount).toBe(0);

          const viaFunction = await client.query(
            `SELECT user_id FROM app_offline_credential_for_verification($1)`,
            [credentialId],
          );
          expect(viaFunction.rowCount).toBe(1);
        },
        { userId: managerId, roleKey: 'manager' },
      );
    } finally {
      await deleteCredential(credentialId);
    }
  }, 30_000);

  it('the definer function still cannot hand back a PIN verifier', async () => {
    const credentialId = await insertCredential(supervisorId, 'supervisor');
    try {
      await withRollback(
        async (client) => {
          // The single most important property of choosing a narrow function
          // over a policy arm: no central role can take away an argon2id hash of
          // somebody's PIN and grind it offline. That would have been a step
          // back toward B-15, the blocker this work just closed.
          await expect(
            client.query(`SELECT pin_verifier FROM app_offline_credential_for_verification($1)`, [
              credentialId,
            ]),
          ).rejects.toThrow(/pin_verifier/i);
        },
        { userId: managerId, roleKey: 'manager' },
      );
    } finally {
      await deleteCredential(credentialId);
    }
  }, 30_000);
});
