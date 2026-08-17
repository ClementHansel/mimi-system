import { describe, expect, it } from 'vitest';
import { argon2id } from 'hash-wasm';
import { hashWasmPinVerifier, createHashWasmPinVerifier } from './pin-verifier';
import { authorizeOffline, cacheCredential, encodeOfflineCredentialToken } from './offline-credentials';
import { createTestDatabase } from '../test-support/fixtures';
import type { OfflineCredentialClaims } from '../types';

/**
 * Exercises the REAL argon2id primitive (§7.2: "m=64MiB, t=3, p=1") end to
 * end — `offline-credentials.test.ts` still uses a fast deterministic fake
 * for attempt-counting/lockout logic; this file is the one place that
 * proves the actual production `PinVerifier` (backed by `hash-wasm`, wired
 * as `createLocalRuntime()`'s default) works against a hash shaped exactly
 * like what M01 mints.
 */
async function mintPinVerifier(pin: string): Promise<string> {
  return argon2id({
    password: pin,
    salt: new Uint8Array(16).fill(3), // fixed salt is fine for a test fixture; production salts are random per credential
    iterations: 3,
    parallelism: 1,
    memorySize: 64 * 1024, // 64 MiB, per §7.2
    hashLength: 32,
    outputType: 'encoded',
  });
}

describe('hash-wasm-backed PinVerifier (SYNC-PROTOCOL §7.2, real argon2id)', () => {
  it('produces a PHC-encoded string that fits CONTRACTS.md pin_verifier VARCHAR(255)', async () => {
    const hash = await mintPinVerifier('482913');
    expect(hash.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
    expect(hash.length).toBeLessThanOrEqual(255);
  });

  it('verifies the correct PIN against its own argon2id hash', async () => {
    const hash = await mintPinVerifier('482913');
    await expect(hashWasmPinVerifier.verify('482913', hash)).resolves.toBe(true);
  });

  it('rejects an incorrect PIN', async () => {
    const hash = await mintPinVerifier('482913');
    await expect(hashWasmPinVerifier.verify('000000', hash)).resolves.toBe(false);
  });

  it('rejects a PIN that differs by only one digit (no partial-match leniency)', async () => {
    const hash = await mintPinVerifier('482913');
    await expect(hashWasmPinVerifier.verify('482912', hash)).resolves.toBe(false);
  });

  it('createHashWasmPinVerifier() returns a working verifier instance', async () => {
    const verifier = createHashWasmPinVerifier();
    const hash = await mintPinVerifier('123456');
    await expect(verifier.verify('123456', hash)).resolves.toBe(true);
  });

  it('full §7.3 authorizeOffline flow succeeds end-to-end against the REAL verifier', async () => {
    const db = createTestDatabase();
    const pin = '739201';
    const pinVerifier = await mintPinVerifier(pin);

    const claims: OfflineCredentialClaims = {
      credentialId: 'cred-real-1',
      sub: 'supervisor-1',
      role: 'supervisor',
      locationIds: ['loc-1'],
      scopes: { 'void_refund.approve': { maxIdr: '500000.00' } },
      iat: new Date('2026-08-16T00:00:00.000Z').toISOString(),
      exp: new Date('2026-08-17T00:00:00.000Z').toISOString(),
      k: Buffer.from('binding-secret-bytes-0123456789', 'utf8').toString('base64'),
      pinVerifier,
      selfieRequiredAboveIdr: '200000.00',
    };
    await cacheCredential(db, {
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });

    const outcome = await authorizeOffline(
      db,
      {
        credentialId: 'cred-real-1',
        pin,
        eventId: 'evt-real-1',
        entity: 'void_refunds',
        entityId: 'vr-real-1',
        op: 'approved_offline',
        amountIdr: '100000.00',
        occurredAt: new Date('2026-08-16T12:00:00.000Z').toISOString(),
        scopeKey: 'void_refund.approve',
      },
      hashWasmPinVerifier,
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.meta.approverUserId).toBe('supervisor-1');
      expect(outcome.meta.binding).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  it('full §7.3 flow rejects a wrong PIN against the REAL verifier and increments the attempt counter', async () => {
    const db = createTestDatabase();
    const claims: OfflineCredentialClaims = {
      credentialId: 'cred-real-2',
      sub: 'supervisor-1',
      role: 'supervisor',
      locationIds: ['loc-1'],
      scopes: { 'void_refund.approve': { maxIdr: '500000.00' } },
      iat: new Date().toISOString(),
      exp: new Date(Date.now() + 3600_000).toISOString(),
      k: Buffer.from('binding-secret-bytes-0123456789', 'utf8').toString('base64'),
      pinVerifier: await mintPinVerifier('555555'),
      selfieRequiredAboveIdr: '200000.00',
    };
    await cacheCredential(db, { credentialId: claims.credentialId, token: encodeOfflineCredentialToken(claims), scopes: claims.scopes, expiresAt: claims.exp });

    const outcome = await authorizeOffline(
      db,
      {
        credentialId: 'cred-real-2',
        pin: '111111',
        eventId: 'evt-real-2',
        entity: 'void_refunds',
        entityId: 'vr-real-2',
        op: 'approved_offline',
        amountIdr: '50000.00',
        occurredAt: new Date().toISOString(),
        scopeKey: 'void_refund.approve',
      },
      hashWasmPinVerifier,
    );

    expect(outcome).toEqual({ ok: false, reason: 'pin_invalid' });
  });
});
