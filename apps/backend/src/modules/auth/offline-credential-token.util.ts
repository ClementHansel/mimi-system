/**
 * Encodes the SYNC-PROTOCOL §7.2 offline-credential token:
 * `base64url(JSON.stringify(claims))`, no signature.
 *
 * D-13 (2026-08-29) — this header previously carried two "CONTRACT DEVIATION"
 * notices asking the architect to reconcile prose against code. SYNC-PROTOCOL
 * v1.4 settled both, in this implementation's favour, and the notices were
 * left behind describing the world as it was before that decision. They are
 * recorded here rather than deleted, because the second one is the sort of
 * comment that costs somebody an afternoon.
 *
 * 1. UNSIGNED, DELIBERATELY. The old prose called this a "compact signed
 *    token (Ed25519, cloud private key)" and this file did not sign. v1.4's
 *    amendment makes unsigned normative for v1 and gives the reasoning in
 *    §7.2: the real control is the cloud's re-verification against the STORED
 *    credential row at §7.4 checks 4/5, and a device-local signature does not
 *    raise the §7.1 skill floor — an attacker who can edit the token can edit
 *    the verifier that checks it. Editing `maxIdr` or `exp` in the local
 *    claims may pass the on-device gate and still comes back `failed` /
 *    `unprovable` from the cloud, which is what §9 T-15 (xi) exists to prove.
 *    The token is UX; the stored row is the control.
 *
 * 2. THE JOINER MISMATCH IS FIXED. The old notice warned that
 *    `kernel/sync/binding-crypto.ts` joined with `'‖'` (U+2016) while the
 *    frontend's `computeBindingHmac()` joined with a plain `'|'`, and that
 *    this would make EVERY offline-approval re-verification (§7.4 check 2)
 *    fail once a real device was in the loop. That was true when it was
 *    written and is no longer: both sides join with U+2016, v1.4 §7.3 makes
 *    it normative, and `apps/frontend/src/lib/local/credentials
 *    /binding-fixture.test.ts` pins it with a cross-tier known-answer fixture
 *    plus an explicit regression guard naming U+007C as the bug that shipped.
 *    Left standing, the notice reads as a live, system-wide failure and sends
 *    the next reader hunting something that is already covered.
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
