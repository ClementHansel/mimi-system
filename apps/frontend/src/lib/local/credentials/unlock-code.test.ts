import { createHmac } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { UNLOCK_MAX_ATTEMPTS, encodeUnlockCode, unlockCodeMessage } from '@mimi/shared';
import { PIN_MAX_ATTEMPTS } from '../constants';
import { createTestDatabase } from '../test-support/fixtures';
import {
  authorizeOffline,
  cacheCredential,
  encodeOfflineCredentialToken,
  getUnlockChallenge,
  isLockedOut,
  redeemUnlockCode,
} from './offline-credentials';
import type { PinVerifier } from './pin-verifier';
import type { OfflineCredentialClaims } from '../types';

/**
 * B-17 — the offline unlock channel, from the device's side.
 *
 * The assertion that matters most here is the LAST one: the code this device
 * accepts is computed by `node:crypto` the way the SERVER computes it, not by
 * the device's own helper. Two tiers deriving the same value through the same
 * shared message builder is the claim; a test where the device checks its own
 * arithmetic would not test it at all. This codebase has already shipped a
 * two-tier HMAC whose halves agreed in prose and disagreed in bytes.
 */

const K = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const CREDENTIAL_ID = 'cred-unlock-1';

function makeClaims(): OfflineCredentialClaims {
  return {
    credentialId: CREDENTIAL_ID,
    sub: 'supervisor-1',
    role: 'supervisor',
    locationIds: ['loc-1'],
    scopes: { 'void_refund.approve': { maxIdr: '500000.00' } },
    iat: new Date('2026-08-16T00:00:00.000Z').toISOString(),
    exp: new Date('2026-08-30T00:00:00.000Z').toISOString(),
    k: K.toString('base64'),
    pinVerifier: 'fake-argon2id-hash',
    selfieRequiredAboveIdr: '200000.00',
    ...({} as Record<string, never>),
  };
}

function fakeVerifier(expectedPin: string): PinVerifier {
  return { verify: async (pin) => pin === expectedPin };
}

/** What HEAD OFFICE computes, in the server's own primitive. */
function serverSideCode(challenge: string): string {
  const hex = createHmac('sha256', K)
    .update(unlockCodeMessage(CREDENTIAL_ID, challenge), 'utf8')
    .digest('hex');
  return encodeUnlockCode(hex);
}

describe('B-17 offline unlock code — device side', () => {
  let db: ReturnType<typeof createTestDatabase>;

  const baseInput = {
    credentialId: CREDENTIAL_ID,
    eventId: 'evt-1',
    entity: 'void_refunds',
    entityId: 'vr-1',
    op: 'approved_offline',
    amountIdr: '100000.00',
    occurredAt: new Date('2026-08-16T12:00:00.000Z').toISOString(),
    scopeKey: 'void_refund.approve',
  };

  /** Burns through the PIN ladder, advancing past each cooldown, until terminal. */
  async function lockItOut(): Promise<void> {
    let clock = new Date('2026-08-16T12:00:00.000Z').getTime();
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i += 1) {
      await authorizeOffline(
        db,
        { ...baseInput, pin: 'wrong' },
        fakeVerifier('123456'),
        new Date(clock).toISOString(),
      );
      clock += 5 * 60_000;
    }
  }

  beforeEach(async () => {
    db = createTestDatabase();
    const claims = makeClaims();
    await cacheCredential(db, {
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });
  });

  it('there is nothing to recover from until the credential is terminally locked', async () => {
    expect(await getUnlockChallenge(db, CREDENTIAL_ID)).toBeNull();
    const outcome = await redeemUnlockCode(db, CREDENTIAL_ID, 'ABCD1234');
    expect(outcome).toEqual({ ok: false, reason: 'not_locked', attemptsLeft: 0 });
  });

  it('minting the terminal lock also mints the challenge to read down the phone', async () => {
    await lockItOut();
    expect(await isLockedOut(db, CREDENTIAL_ID)).toBe(true);

    const challenge = await getUnlockChallenge(db, CREDENTIAL_ID);
    expect(challenge?.challenge).toMatch(/^\d{6}$/);
    expect(challenge?.attemptsLeft).toBe(UNLOCK_MAX_ATTEMPTS);
  });

  it('the challenge does not change between reads — the supervisor is mid-call', async () => {
    await lockItOut();
    const first = await getUnlockChallenge(db, CREDENTIAL_ID);
    const second = await getUnlockChallenge(db, CREDENTIAL_ID);
    expect(second?.challenge).toBe(first?.challenge);
  });

  it('ACCEPTS the code the SERVER computes, and brings the credential back with no connectivity', async () => {
    await lockItOut();
    const { challenge } = (await getUnlockChallenge(db, CREDENTIAL_ID))!;

    // Computed with node:crypto, exactly as `AuthService.issueOfflineUnlockCode`
    // does — this is the cross-tier assertion.
    const outcome = await redeemUnlockCode(db, CREDENTIAL_ID, serverSideCode(challenge));
    expect(outcome).toEqual({ ok: true });

    expect(await isLockedOut(db, CREDENTIAL_ID)).toBe(false);
    expect(await getUnlockChallenge(db, CREDENTIAL_ID)).toBeNull();

    // And the credential genuinely works again, offline, right now.
    const authorized = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
      new Date('2026-08-16T13:00:00.000Z').toISOString(),
    );
    expect(authorized.ok).toBe(true);
  });

  it('unlocking resets the PIN counter too, not just the lock flag', async () => {
    await lockItOut();
    const { challenge } = (await getUnlockChallenge(db, CREDENTIAL_ID))!;
    await redeemUnlockCode(db, CREDENTIAL_ID, serverSideCode(challenge));

    // If `failedAttempts` had been left at 5, the very next mistyped digit would
    // slam the credential straight back into a terminal lock — which is not what
    // "unlocked" means to someone who just spent a phone call getting here.
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: 'wrong' },
      fakeVerifier('123456'),
      new Date('2026-08-16T13:00:00.000Z').toISOString(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'pin_invalid' });
    expect(await isLockedOut(db, CREDENTIAL_ID)).toBe(false);
  });

  it('a code for a DIFFERENT challenge is inert — an old one cannot be replayed', async () => {
    await lockItOut();
    const stale = serverSideCode('000000');
    const { challenge } = (await getUnlockChallenge(db, CREDENTIAL_ID))!;
    // Guard against the 1-in-a-million case where the random challenge IS 000000.
    if (challenge === '000000') return;

    const outcome = await redeemUnlockCode(db, CREDENTIAL_ID, stale);
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toBe('invalid');
    expect(await isLockedOut(db, CREDENTIAL_ID)).toBe(true);
  });

  it('counts down wrong codes and then stops accepting any, right or wrong', async () => {
    await lockItOut();
    const { challenge } = (await getUnlockChallenge(db, CREDENTIAL_ID))!;

    for (let i = 1; i < UNLOCK_MAX_ATTEMPTS; i += 1) {
      const outcome = await redeemUnlockCode(db, CREDENTIAL_ID, 'ZZZZZZZZ');
      expect(outcome).toEqual({
        ok: false,
        reason: 'invalid',
        attemptsLeft: UNLOCK_MAX_ATTEMPTS - i,
      });
    }
    expect(await redeemUnlockCode(db, CREDENTIAL_ID, 'ZZZZZZZZ')).toEqual({
      ok: false,
      reason: 'attempts_exhausted',
      attemptsLeft: 0,
    });

    // Even the CORRECT code is refused now. The credential waits for the device
    // to come back online — a terminal state that is honest rather than infinite.
    expect(await redeemUnlockCode(db, CREDENTIAL_ID, serverSideCode(challenge))).toEqual({
      ok: false,
      reason: 'attempts_exhausted',
      attemptsLeft: 0,
    });
  });

  it('forgives case and hyphens, because this arrives by voice', async () => {
    await lockItOut();
    const { challenge } = (await getUnlockChallenge(db, CREDENTIAL_ID))!;
    const code = serverSideCode(challenge);

    const typed = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
    expect(await redeemUnlockCode(db, CREDENTIAL_ID, typed)).toEqual({ ok: true });
  });

  it('re-caching a credential clears any lock and its challenge', async () => {
    await lockItOut();
    expect(await isLockedOut(db, CREDENTIAL_ID)).toBe(true);

    // This is the ONLINE recovery path: the credential is re-issued and the
    // device caches it fresh. It must wipe the offline lock, or a supervisor
    // would still be locked out after head office fixed it properly.
    const claims = makeClaims();
    await cacheCredential(db, {
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });
    expect(await isLockedOut(db, CREDENTIAL_ID)).toBe(false);
    expect(await getUnlockChallenge(db, CREDENTIAL_ID)).toBeNull();
  });
});
