import { describe, expect, it } from 'vitest';
import {
  noopSignatureVerifier,
  createNoopSignatureVerifier,
  type SignatureVerifier,
} from './signature-verifier';
import { cacheCredential, encodeOfflineCredentialToken } from './offline-credentials';
import { createTestDatabase } from '../test-support/fixtures';
import type { CachedCredentialRecord, OfflineCredentialClaims } from '../types';

function claimsFixture(credentialId: string): OfflineCredentialClaims {
  return {
    credentialId,
    sub: 'supervisor-1',
    role: 'supervisor',
    locationIds: ['loc-1'],
    scopes: { 'void_refund.approve': { maxIdr: '500000.00' } },
    iat: new Date().toISOString(),
    exp: new Date(Date.now() + 3600_000).toISOString(),
    k: Buffer.from('binding-secret-bytes-0123456789', 'utf8').toString('base64'),
    pinVerifier: 'fake-argon2id-hash',
    selfieRequiredAboveIdr: '200000.00',
  };
}

describe('SignatureVerifier seam (v1 unsigned token, architect decision)', () => {
  it('noopSignatureVerifier always accepts, regardless of token or public key', async () => {
    await expect(noopSignatureVerifier.verify('anything', null)).resolves.toBe(true);
    await expect(noopSignatureVerifier.verify('anything', 'some-public-key')).resolves.toBe(true);
    await expect(noopSignatureVerifier.verify('', null)).resolves.toBe(true);
  });

  it('createNoopSignatureVerifier() returns a working instance', async () => {
    const verifier = createNoopSignatureVerifier();
    await expect(verifier.verify('token', null)).resolves.toBe(true);
  });

  it('cacheCredential defaults to the no-op verifier and caches normally (v1 behavior)', async () => {
    const db = createTestDatabase();
    const claims = claimsFixture('cred-default');
    const result = await cacheCredential(db, {
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });

    expect(result).toEqual({ cached: true });
    expect(await db.store<CachedCredentialRecord>('credentials').get('cred-default')).toBeDefined();
  });

  it('cacheCredential calls the injected verifier with the token and public key (the seam is actually wired, not just present in types)', async () => {
    const calls: { token: string; publicKey: string | null }[] = [];
    const spyVerifier: SignatureVerifier = {
      async verify(token, publicKey) {
        calls.push({ token, publicKey });
        return true;
      },
    };

    const db = createTestDatabase();
    const claims = claimsFixture('cred-spy');
    const token = encodeOfflineCredentialToken(claims);
    await cacheCredential(
      db,
      { credentialId: claims.credentialId, token, scopes: claims.scopes, expiresAt: claims.exp },
      spyVerifier,
      'the-public-key',
    );

    expect(calls).toEqual([{ token, publicKey: 'the-public-key' }]);
  });

  it('a verifier that rejects prevents the credential from being cached at all (future-proofing: this is what a real verifier gates)', async () => {
    const rejectingVerifier: SignatureVerifier = {
      async verify() {
        return false;
      },
    };
    const db = createTestDatabase();
    const claims = claimsFixture('cred-rejected');
    const result = await cacheCredential(
      db,
      {
        credentialId: claims.credentialId,
        token: encodeOfflineCredentialToken(claims),
        scopes: claims.scopes,
        expiresAt: claims.exp,
      },
      rejectingVerifier,
    );

    expect(result).toEqual({ cached: false });
    expect(
      await db.store<CachedCredentialRecord>('credentials').get('cred-rejected'),
    ).toBeUndefined();
  });
});
