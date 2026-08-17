/**
 * Refresh-token hashing — deliberately NOT bcrypt.
 *
 * BUG FOUND WHILE TESTING (verified live, not a guess): bcrypt silently
 * truncates its input to 72 BYTES. A JWT refresh token's JSON payload
 * serializes `sub` (a UUID) first, then `sessionId` (also unchanged across
 * a rotation) — so two DIFFERENT refresh tokens for the SAME session share
 * an IDENTICAL first-72-byte prefix (header + `sub` + `sessionId`), and
 * bcrypt's `compare(oldToken, hashOfNewToken)` returns **true** even though
 * the full strings differ only in bytes beyond 72 (the added `jti`, the
 * signature). That silently defeated rotation: a stolen OLD refresh token
 * would keep working forever, matching the coordinator's stated failure
 * shape exactly ("a test that passes just as well if everything were
 * broken") — an integration test caught this, a unit test with a mocked
 * `bcrypt.compare` would not have.
 *
 * Bcrypt is the right tool for PASSWORDS (short, human-chosen, needs
 * deliberate slowness against brute force). A refresh token already has
 * enormous entropy of its own — hashing it only needs to be
 * collision-resistant and full-length, not slow. SHA-256 over the full
 * string, compared in constant time, is the standard approach (matches
 * `kernel/sync/binding-crypto.ts`'s own `timingSafeEqual` discipline for a
 * comparable HMAC-hex comparison).
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function verifyRefreshTokenHash(token: string, storedHashHex: string): boolean {
  const expected = Buffer.from(hashRefreshToken(token), 'hex');
  const actual = Buffer.from(storedHashHex, 'hex');
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}
