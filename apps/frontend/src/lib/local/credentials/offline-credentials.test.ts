import { describe, expect, it, beforeEach } from 'vitest';
import { createTestDatabase } from '../test-support/fixtures';
import {
  cacheCredential,
  authorizeOffline,
  applyCrlRevocationWithinTx,
  computeBindingHmac,
  encodeOfflineCredentialToken,
  isLockedOut,
  remainingCooldownMs,
} from './offline-credentials';
import type { PinVerifier } from './pin-verifier';
import type { OfflineCredentialClaims } from '../types';
import { PIN_BACKOFF_MS_BY_FAILURE_COUNT, PIN_MAX_ATTEMPTS } from '../constants';

function makeClaims(overrides: Partial<OfflineCredentialClaims> = {}): OfflineCredentialClaims {
  return {
    credentialId: 'cred-1',
    sub: 'supervisor-1',
    role: 'supervisor',
    locationIds: ['loc-1'],
    scopes: { 'void_refund.approve': { maxIdr: '500000.00' } },
    iat: new Date('2026-08-16T00:00:00.000Z').toISOString(),
    exp: new Date('2026-08-17T00:00:00.000Z').toISOString(),
    k: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'),
    pinVerifier: 'fake-argon2id-hash',
    selfieRequiredAboveIdr: '200000.00',
    ...overrides,
  };
}

function fakeVerifier(expectedPin: string): PinVerifier {
  return { verify: async (pin) => pin === expectedPin };
}

describe('offline-credentials (D-17 / SYNC-PROTOCOL §7)', () => {
  let db: ReturnType<typeof createTestDatabase>;

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

  const baseInput = {
    credentialId: 'cred-1',
    eventId: 'evt-1',
    entity: 'void_refunds',
    entityId: 'vr-1',
    op: 'approved_offline',
    amountIdr: '100000.00',
    occurredAt: new Date('2026-08-16T12:00:00.000Z').toISOString(),
    scopeKey: 'void_refund.approve',
  };

  it('succeeds with the correct PIN and returns a binding HMAC + approver id', async () => {
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.meta.approverUserId).toBe('supervisor-1');
      expect(outcome.meta.binding).toMatch(/^[0-9a-f]{64}$/);
      expect(outcome.meta.pinAttemptsBeforeSuccess).toBe(1);
    }
  });

  it('binding HMAC is deterministic for identical inputs and changes if ANY field changes (tamper-evidence, §7.4 check 2)', async () => {
    const fields = {
      eventId: 'evt-1',
      entity: 'void_refunds',
      entityId: 'vr-1',
      op: 'approved_offline',
      amountIdr: '100000.00',
      occurredAt: baseInput.occurredAt,
    };
    const claims = makeClaims();
    const h1 = await computeBindingHmac(claims.k, fields);
    const h2 = await computeBindingHmac(claims.k, fields);
    const h3 = await computeBindingHmac(claims.k, { ...fields, amountIdr: '999999.00' });
    expect(h1).toBe(h2);
    expect(h1).not.toBe(h3);
  });

  it('rejects an invalid PIN and increments the attempt counter without granting authorization', async () => {
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: 'wrong' },
      fakeVerifier('123456'),
    );
    expect(outcome).toEqual({ ok: false, reason: 'pin_invalid' });
  });

  it('locks out the credential on this device after 5 failed PIN attempts (§7.3)', async () => {
    // B-17: attempts 3 and 4 now start a cooldown, so a caller who does not wait
    // it out never reaches attempt 5. The clock is advanced explicitly rather
    // than slept through — and note this is the assertion that would have caught
    // the ladder silently CAPPING the counter at 3 instead of merely pacing it.
    let clock = new Date('2026-08-16T12:00:00.000Z').getTime();
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await authorizeOffline(
        db,
        { ...baseInput, pin: 'wrong' },
        fakeVerifier('123456'),
        new Date(clock).toISOString(),
      );
      clock += 5 * 60_000; // comfortably past the longest backoff
    }
    expect(await isLockedOut(db, 'cred-1')).toBe(true);

    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
      new Date(clock).toISOString(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'locked_out' });
  });

  it('B-17 — backs off at the 3rd wrong PIN instead of going straight to a dead credential', async () => {
    const t0 = new Date('2026-08-16T12:00:00.000Z').getTime();
    const at = (ms: number) => new Date(t0 + ms).toISOString();

    // Two free attempts: a mistyped digit is not an attack.
    for (const ms of [0, 1000]) {
      const outcome = await authorizeOffline(
        db,
        { ...baseInput, pin: 'wrong' },
        fakeVerifier('123456'),
        at(ms),
      );
      expect(outcome).toEqual({ ok: false, reason: 'pin_invalid' });
    }
    expect(await remainingCooldownMs(db, 'cred-1', at(2000))).toBe(0);

    // The third starts the 30s cooldown.
    await authorizeOffline(db, { ...baseInput, pin: 'wrong' }, fakeVerifier('123456'), at(2000));
    expect(await remainingCooldownMs(db, 'cred-1', at(2000))).toBe(
      PIN_BACKOFF_MS_BY_FAILURE_COUNT[3],
    );

    // ...and the CORRECT PIN is refused while it runs, with the wait attached.
    const during = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
      at(5000),
    );
    expect(during.ok).toBe(false);
    if (!during.ok) {
      expect(during.reason).toBe('cooling_down');
      expect(during.retryAfterSeconds).toBe(27);
    }

    // The credential is NOT dead — this is the whole point of B-17. An outlet
    // with no internet recovers by waiting, with no human process at all.
    expect(await isLockedOut(db, 'cred-1')).toBe(false);
  });

  it('B-17 — the cooldown clears itself, and a correct PIN afterwards works and wipes the ladder', async () => {
    const t0 = new Date('2026-08-16T12:00:00.000Z').getTime();
    const at = (ms: number) => new Date(t0 + ms).toISOString();

    for (const ms of [0, 1000, 2000]) {
      await authorizeOffline(db, { ...baseInput, pin: 'wrong' }, fakeVerifier('123456'), at(ms));
    }

    const after = PIN_BACKOFF_MS_BY_FAILURE_COUNT[3]! + 3000;
    expect(await remainingCooldownMs(db, 'cred-1', at(after))).toBe(0);

    const success = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
      at(after),
    );
    expect(success.ok).toBe(true);

    // A later single mistake must be free again, not resume at attempt 4 —
    // otherwise a supervisor who fumbles once an hour eventually kills the
    // credential for reasons nobody can reconstruct.
    const later = await authorizeOffline(
      db,
      { ...baseInput, pin: 'wrong' },
      fakeVerifier('123456'),
      at(after + 1000),
    );
    expect(later).toEqual({ ok: false, reason: 'pin_invalid' });
    expect(await remainingCooldownMs(db, 'cred-1', at(after + 1000))).toBe(0);
  });

  it('B-17 — a terminally locked-out credential reports locked_out, never a cooldown that will never end', async () => {
    let clock = new Date('2026-08-16T12:00:00.000Z').getTime();
    for (let i = 0; i < PIN_MAX_ATTEMPTS; i++) {
      await authorizeOffline(
        db,
        { ...baseInput, pin: 'wrong' },
        fakeVerifier('123456'),
        new Date(clock).toISOString(),
      );
      clock += 5 * 60_000;
    }

    // `lockedUntil` must not be set alongside the terminal lock: a UI counting
    // down to a moment that changes nothing is worse than one saying plainly
    // that this credential needs the device back online.
    expect(await remainingCooldownMs(db, 'cred-1', new Date(clock).toISOString())).toBe(0);
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
      new Date(clock).toISOString(),
    );
    expect(outcome).toEqual({ ok: false, reason: 'locked_out' });
  });

  it('a successful verification resets the failure counter', async () => {
    await authorizeOffline(db, { ...baseInput, pin: 'wrong' }, fakeVerifier('123456'));
    await authorizeOffline(db, { ...baseInput, pin: 'wrong' }, fakeVerifier('123456'));
    const success = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
    );
    expect(success.ok).toBe(true);
    if (success.ok) expect(success.meta.pinAttemptsBeforeSuccess).toBe(3);
  });

  it('rejects a revoked credential even if it has not expired (CRL check)', async () => {
    await db.runTransaction(['credential_crl'], 'readwrite', async (tx) => {
      await applyCrlRevocationWithinTx(tx, 'cred-1', new Date().toISOString());
    });
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456' },
      fakeVerifier('123456'),
    );
    expect(outcome).toEqual({ ok: false, reason: 'revoked' });
  });

  it('rejects an amount above the scope cap (advisory local pre-check mirroring §7.4 check 5)', async () => {
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456', amountIdr: '999999.00' },
      fakeVerifier('123456'),
    );
    expect(outcome).toEqual({ ok: false, reason: 'scope_exceeded' });
  });

  it('requires a selfie above the threshold', async () => {
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, pin: '123456', amountIdr: '250000.00' },
      fakeVerifier('123456'),
    );
    expect(outcome).toEqual({ ok: false, reason: 'selfie_required' });
  });

  it('accepts an above-threshold amount when a selfieRef is supplied', async () => {
    const outcome = await authorizeOffline(
      db,
      {
        ...baseInput,
        pin: '123456',
        amountIdr: '250000.00',
        scopeKey: 'void_refund.approve',
        selfieRef: { sha256: 'abc', size: 100, mime: 'image/jpeg' },
      },
      fakeVerifier('123456'),
    );
    // scope cap is 500000 so 250000 passes; only the selfie gate was the concern here
    expect(outcome.ok).toBe(true);
  });

  it('rejects a credential id that was never cached on this device', async () => {
    const outcome = await authorizeOffline(
      db,
      { ...baseInput, credentialId: 'unknown-cred', pin: '123456' },
      fakeVerifier('123456'),
    );
    expect(outcome).toEqual({ ok: false, reason: 'not_cached' });
  });
});
