/**
 * SYNC-PROTOCOL §7.2 mints `pin_verifier` as an argon2id hash (`m=64MiB,
 * t=3, p=1`), PHC-encoded (`$argon2id$v=19$m=...,t=...,p=...$salt$hash`,
 * fits CONTRACTS.md's `offline_credentials.pin_verifier VARCHAR(255)`), for
 * the device to check the approver's PIN against LOCALLY, offline.
 *
 * Backed by `hash-wasm`'s `argon2Verify` (W1-A-approved dependency: WASM
 * embedded as inline base64, no `fetch()`, runs under plain Node — verified
 * against both constraints before being added). `argon2Verify` parses
 * `m`/`t`/`p`/salt straight out of the encoded hash string, so this side
 * never needs to know the minting parameters — it only ever verifies.
 *
 * `PinVerifier` stays an injectable seam (not a direct `hash-wasm` import at
 * every call site) so `offline-credentials.test.ts` can still exercise
 * attempt-counting/lockout logic against a fast deterministic fake, while
 * `hash-wasm-pin-verifier.test.ts` exercises the real primitive end-to-end.
 */
import { argon2Verify } from 'hash-wasm';

export interface PinVerifier {
  /** `true` iff `pin` matches the argon2id `verifierHash` minted at credential issuance (§7.2). */
  verify(pin: string, verifierHash: string): Promise<boolean>;
}

/** The real, production PinVerifier. */
export const hashWasmPinVerifier: PinVerifier = {
  async verify(pin, verifierHash) {
    return argon2Verify({ password: pin, hash: verifierHash });
  },
};

export function createHashWasmPinVerifier(): PinVerifier {
  return hashWasmPinVerifier;
}

/**
 * Kept only as an explicit, loud fallback for a caller that constructs a
 * `LocalRuntime` without any `PinVerifier` at all AND without going through
 * `createLocalRuntime()`'s own default (which is `hashWasmPinVerifier`) —
 * i.e. it should be unreachable in practice. A stub that silently returned
 * `false` would look like "PIN verification works, it's just always wrong";
 * one that returned `true` would be a live security hole. Neither is
 * acceptable for something gating a financial approval, so this fails loudly
 * instead.
 */
export const unimplementedPinVerifier: PinVerifier = {
  async verify(): Promise<boolean> {
    throw new Error(
      'PinVerifier not configured and no default was supplied. Use createHashWasmPinVerifier() ' +
        '(the production default in createLocalRuntime()) or inject a test double explicitly.',
    );
  },
};
