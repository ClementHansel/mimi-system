/**
 * Offline-credential TOKEN signature — the seam, not the primitive.
 *
 * DECISION (architect, this session — CONTRACTS.md is being amended to say
 * this plainly): the v1 token ships UNSIGNED
 * (`offline-credential-token.util.ts` / `offline-credentials.ts`'s
 * `encode`/`decodeOfflineCredentialToken`, both already built and agreeing).
 * Reasoning kept here for whoever revisits this:
 *  - §7.4 re-verifies every offline approval against the CLOUD's OWN stored
 *    `offline_credentials` row — a forged/edited local token can never make
 *    the cloud accept anything on its own; the server-side check is and
 *    remains the real control (D-17: offline approvals are provisional by
 *    design).
 *  - A token signature would only raise the bar on ONE variant of RISK-S2
 *    (editing the cached token's JSON in devtools) but not the comparable-
 *    skill-floor variant (patching the running page's JS to skip whatever
 *    local gate exists) — it narrows the attack class, it does not close it.
 *  - The genuine residual harm (cash physically leaves the drawer before
 *    detection) is unchanged by a signature either way; unwinding it is
 *    §7.5's job, not this seam's.
 *  - The spend that WOULD close the hole is approver-owned-device signing
 *    (the QR-handshake redesign, RISK-S2's own stated fix) — an open PM
 *    decision. Spending a new dependency + an undefined public-key-
 *    distribution/rotation contract slot on a measure that only narrows the
 *    same hole competes with the money for the fix that actually closes it.
 *
 * This file exists so that decision is reversible without a redesign: when
 * a real Ed25519 verifier, a public key, and a wire format for the signed
 * portion of the token all exist, wiring one in is a single injection at
 * `createLocalRuntime()` — exactly the `PinVerifier` pattern
 * (`./pin-verifier.ts`) — not a change to `cacheCredential`'s call site.
 */
export interface SignatureVerifier {
  /**
   * `true` iff `token`'s signature is valid under `publicKey`. `publicKey` is
   * `string | null` because no distribution mechanism exists yet (SYNC-
   * PROTOCOL §7.2 says "rotated via master-data sync," but no `SyncEntity`
   * or `SETTINGS_KEY_LIST` entry carries it today — a real implementation
   * needs that contract slot before it needs code here).
   */
  verify(token: string, publicKey: string | null): Promise<boolean>;
}

/**
 * The v1 default: always accepts. NOT a placeholder standing in for
 * "not implemented yet" the way `unimplementedPinVerifier` is — this is the
 * deliberate, decided behavior for an unsigned token, so it resolves `true`
 * rather than throwing. `cacheCredential` still calls it on every cache
 * write (see `offline-credentials.ts`), so the seam is exercised for real
 * today, not merely present in the type system.
 */
export const noopSignatureVerifier: SignatureVerifier = {
  async verify(): Promise<boolean> {
    return true;
  },
};

export function createNoopSignatureVerifier(): SignatureVerifier {
  return noopSignatureVerifier;
}
