import { describe, expect, it } from 'vitest';
import { decodeOfflineCredentialToken, encodeOfflineCredentialToken } from './offline-credentials';
import type { OfflineCredentialClaims } from '../types';

const CLAIMS: OfflineCredentialClaims = {
  credentialId: '018e5f2a-1b2c-7000-8000-00000000000a',
  sub: '018e5f2a-1b2c-7000-8000-00000000000b',
  role: 'supervisor',
  locationIds: ['018e5f2a-1b2c-7000-8000-00000000000c'],
  scopes: { 'void_refund.approve': { maxIdr: '500000.00' } },
  iat: '2026-08-16T00:00:00.000Z',
  exp: '2026-08-17T00:00:00.000Z',
  k: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'),
  pinVerifier: '$argon2id$v=19$m=65536,t=3,p=1$AAAAAAAAAAAAAAAAAAAAAA$deadbeefdeadbeefdeadbeefdeadbeef',
  selfieRequiredAboveIdr: '200000.00',
};

/**
 * `apps/backend/src/modules/auth/offline-credential-token.util.ts`'s
 * `encodeOfflineCredentialToken` is `Buffer.from(JSON.stringify(claims),
 * 'utf8').toString('base64url')` — a REAL base64url string (uses `-`/`_`,
 * never `+`/`/`, no `=` padding). This test builds a token the SAME way
 * (independently of this module's own encoder) and confirms the frontend
 * decoder reads it correctly, and vice versa — this is what would have
 * caught a base64 vs. base64url mismatch before a real device ever saw a
 * token containing a `-` or `_`.
 */
describe('offline-credential token wire format (base64url, §7.2)', () => {
  it('decodes a token built EXACTLY the way the real backend builds it (Buffer...toString(base64url))', () => {
    const backendStyleToken = Buffer.from(JSON.stringify(CLAIMS), 'utf8').toString('base64url');
    const decoded = decodeOfflineCredentialToken(backendStyleToken);
    expect(decoded).toEqual(CLAIMS);
  });

  it('this module\'s own encoder produces a token the backend-style Buffer decoder reads back correctly', () => {
    const token = encodeOfflineCredentialToken(CLAIMS);
    const decoded = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
    expect(decoded).toEqual(CLAIMS);
  });

  it('round-trips through THIS module\'s own encode/decode pair', () => {
    const token = encodeOfflineCredentialToken(CLAIMS);
    expect(decodeOfflineCredentialToken(token)).toEqual(CLAIMS);
  });

  it('regression guard: exercises a payload whose base64 form is known to contain "+" and "/" (must become "-"/"_", never appear literally, and never gain "=" padding)', () => {
    // Chosen so JSON.stringify(...) base64-encodes to bytes landing on both the
    // 62nd ('+') and 63rd ('/') alphabet characters at least once — a payload
    // built purely from short hex/UUID strings can accidentally never hit them.
    const claimsWithNoise: OfflineCredentialClaims = {
      ...CLAIMS,
      role: 'supervisor-🔥🔥🔥-ÀÉÎÕÜ-The quick brown fox jumps over the lazy dog 1234567890 !@#$%^&*()_+-=',
    };
    const token = encodeOfflineCredentialToken(claimsWithNoise);
    expect(token).not.toMatch(/[+/=]/);

    const rawStdBase64 = Buffer.from(JSON.stringify(claimsWithNoise), 'utf8').toString('base64');
    expect(rawStdBase64).toMatch(/[+/]/); // sanity: this fixture DOES exercise the substitution-worthy characters

    expect(decodeOfflineCredentialToken(token)).toEqual(claimsWithNoise);
    // And the reverse: a real base64url token from the backend's encoder decodes correctly too.
    const backendToken = Buffer.from(JSON.stringify(claimsWithNoise), 'utf8').toString('base64url');
    expect(decodeOfflineCredentialToken(backendToken)).toEqual(claimsWithNoise);
  });
});
