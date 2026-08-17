/**
 * Encodes the SYNC-PROTOCOL §7.2 offline-credential token.
 *
 * CONTRACT DEVIATION (flagged for the architect/W2-D/W2-E, not fixed here —
 * none of the three files involved are in this agent's owned directories):
 * CONTRACTS.md/SYNC-PROTOCOL.md's prose describes the token as "compact
 * signed token (Ed25519, cloud private key)". But the consumer that already
 * exists and is tested — `apps/frontend/src/lib/local/credentials
 * /offline-credentials.ts` (`decodeOfflineCredentialToken`, W2-E, Wave 2,
 * frozen) — has already shipped and tested a DIFFERENT, simpler contract:
 * "`token` is `base64url(JSON.stringify(claims))` (no signature verification
 * attempted device-side...)". Per that file's own comment: "If M01 ships a
 * different encoding this decoder is the one function to change" — but
 * `apps/frontend/**` is W2-E's frozen territory, not this agent's, so this
 * file MATCHES the already-built, already-tested consumer rather than
 * implementing the Ed25519 scheme the prose describes and breaking every
 * `cacheCredential()`/`authorizeOffline()` call the frontend already tests
 * against. Flagged in this agent's final report as a prose/implementation
 * mismatch for the architect to reconcile (either amend the docs to match
 * the shipped encoding, or commission a frontend change to add signature
 * verification — a decision outside this agent's three owned directories).
 *
 * SEPARATE, more consequential mismatch also flagged in the report: the
 * binding-HMAC field JOINER differs between the two already-frozen
 * implementations that must agree bit-for-bit — `kernel/sync/binding-crypto
 * .ts`'s `bindingMessage()` joins with `'‖'` (U+2016) while `apps/frontend`'s
 * `computeBindingHmac()` joins with a plain `'|'`. This file does not touch
 * either (both are outside this agent's ownership); it only mints `k` and
 * ships it in the token exactly as both sides expect (raw 32 bytes,
 * base64-encoded) — the joiner mismatch will make EVERY offline-approval
 * re-verification (§7.4 check 2) fail once a real device is in the loop,
 * regardless of anything this module does.
 */
import type { Money, UUID } from '@mimi/shared';

/** Mirrors `OfflineCredentialClaims` (`apps/frontend/src/lib/local/types.ts`) and SYNC-PROTOCOL §7.2's JSON shape exactly. */
export interface OfflineCredentialClaims {
  credentialId: UUID;
  sub: UUID;
  role: string;
  locationIds: UUID[];
  scopes: Record<string, { maxIdr?: Money }>;
  iat: string;
  exp: string;
  /** Raw 32-byte per-issuance binding secret, base64-encoded (§7.3). */
  k: string;
  pinVerifier: string;
  selfieRequiredAboveIdr: Money;
}

export function encodeOfflineCredentialToken(claims: OfflineCredentialClaims): string {
  return Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
}
