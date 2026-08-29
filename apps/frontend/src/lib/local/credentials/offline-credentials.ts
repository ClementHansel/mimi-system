/**
 * Offline authorization (D-17, SYNC-PROTOCOL §7). Read §7.1 before touching
 * this file: the cashier controls the device this cache lives on, so nothing
 * here is a security boundary — it exists to (a) let a supervisor's
 * provisional approval work at all with no connectivity, (b) attach the
 * evidence (PIN telemetry, binding HMAC, selfie ref) the CLOUD will actually
 * gate on at re-verification (§7.4), and (c) apply the CRL locally so a
 * revoked credential stops working the moment its revocation has synced
 * down, even before any TTL expiry.
 *
 * TOKEN FORMAT — CONFIRMED against the real M01 mint endpoint
 * (`apps/backend/src/modules/auth/offline-credential-token.util.ts`,
 * `encodeOfflineCredentialToken`), not merely assumed: `token` is
 * `base64url(JSON.stringify(claims))`, unsigned. That file's own header
 * independently reaches the identical conclusion this one did — CONTRACTS.md/
 * SYNC-PROTOCOL.md's prose describes an Ed25519-signed token, but the actual
 * built-and-tested contract on both ends is the simpler unsigned form — and
 * defers the prose-vs-code reconciliation to the architect, same as here.
 * STATUS (architect decision, this session): the v1 token stays unsigned.
 * `cacheCredential` (below) still runs every token through an injectable
 * `SignatureVerifier` seam (`./signature-verifier.ts`) — today's default
 * no-op always accepts, but the call site is real, so a future verifier is
 * a one-line injection, not a redesign. Full reasoning in that file's header.
 *
 * Decode/encode do their own base64url<->base64 substitution rather than
 * handing a `-`/`_` string straight to `atob`/`btoa`: those two ONLY
 * implement standard base64 (RFC 4648 §4), not the URL-safe alphabet, in
 * both real browsers and Node's global `atob`/`btoa` — a raw
 * `Buffer.from(token, 'base64url')` fallback would round-trip fine in a
 * Node-only test but silently mis-decode the FIRST real token containing a
 * `-` or `_` once talking to the actual cloud, which encodes with
 * `.toString('base64url')`. `binding-fixture.test.ts`'s sibling
 * `token-wire-format.test.ts` decodes a token built independently via
 * Node's real `Buffer...toString('base64url')` to guard exactly this.
 */
import type { ISODateTime, Money, UUID } from '@mimi/shared';
import type { OfflineAuthorizationMeta } from '@mimi/sync-protocol';
import type { LocalDatabase, TxHandle } from '../store/local-database';
import type {
  CachedCredentialRecord,
  CredentialRevocationRecord,
  OfflineCredentialClaims,
  PinAttemptState,
} from '../types';
import { PIN_BACKOFF_MS_BY_FAILURE_COUNT, PIN_MAX_ATTEMPTS } from '../constants';
import {
  UNLOCK_CHALLENGE_LENGTH,
  UNLOCK_MAX_ATTEMPTS,
  encodeUnlockCode,
  unlockCodeMatches,
  unlockCodeMessage,
} from '@mimi/shared';
import { evaluateExpiryProvability, type ExpiryProvability } from '../clock/clock';
import type { PinVerifier } from './pin-verifier';
import { noopSignatureVerifier, type SignatureVerifier } from './signature-verifier';

export interface OfflineCredentialRes {
  credentialId: UUID;
  token: string;
  scopes: Record<string, { maxIdr?: Money }>;
  expiresAt: ISODateTime;
}

/** `base64url` -> standard `base64` (RFC 4648 §5 -> §4): swap the two alphabet characters and restore padding. */
function base64UrlToStd(b64url: string): string {
  const std = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const paddingNeeded = (4 - (std.length % 4)) % 4;
  return std + '='.repeat(paddingNeeded);
}

/** Standard `base64` -> `base64url`: swap the two alphabet characters and drop padding (never present in base64url). */
function stdToBase64Url(std: string): string {
  return std.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * `atob`/`btoa` operate on a "binary string" (one Latin1 byte per JS char) —
 * handing them a JSON string directly throws `InvalidCharacterError` the
 * moment any claim field (a role name, a future non-ASCII display value)
 * contains a code point above 255. Bridging through `TextEncoder`/
 * `TextDecoder` first makes this UTF-8-correct, matching what
 * `Buffer.from(json, 'utf8').toString('base64url')` does on the backend
 * side byte-for-byte — `token-wire-format.test.ts`'s regression fixture
 * exercises exactly this with an emoji + accented characters in a claim.
 */
function bytesToBinaryString(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return binary;
}

function binaryStringToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function decodeOfflineCredentialToken(token: string): OfflineCredentialClaims {
  let json: string;
  if (typeof atob === 'function') {
    const bytes = binaryStringToBytes(atob(base64UrlToStd(token)));
    json = new TextDecoder().decode(bytes);
  } else {
    json = Buffer.from(token, 'base64url').toString('utf8');
  }
  return JSON.parse(json) as OfflineCredentialClaims;
}

export function encodeOfflineCredentialToken(claims: OfflineCredentialClaims): string {
  const json = JSON.stringify(claims);
  let std: string;
  if (typeof btoa === 'function') {
    std = btoa(bytesToBinaryString(new TextEncoder().encode(json)));
  } else {
    std = Buffer.from(json, 'utf8').toString('base64');
  }
  return stdToBase64Url(std);
}

export interface CacheCredentialResult {
  cached: boolean;
}

/**
 * Caches a freshly-issued/refreshed offline credential (§7.2). Verifies the
 * token's signature via the injected `SignatureVerifier` BEFORE storing it —
 * wired the same way `authorizeOffline` wires `PinVerifier` — so that once a
 * real verifier exists, plugging it in here is the only change needed; a
 * `false` verdict means the credential is never cached (never usable for an
 * offline approval), same effective result as `authorizeOffline`'s
 * `not_cached` outcome. Today's default (`noopSignatureVerifier`) always
 * accepts, matching the v1-unsigned decision (see `signature-verifier.ts`).
 *
 * `publicKey` is `string | null` because no distribution channel for it
 * exists yet (see `signature-verifier.ts`) — callers pass `null` until one
 * does.
 */
export async function cacheCredential(
  db: LocalDatabase,
  res: OfflineCredentialRes,
  signatureVerifier: SignatureVerifier = noopSignatureVerifier,
  publicKey: string | null = null,
): Promise<CacheCredentialResult> {
  const signatureValid = await signatureVerifier.verify(res.token, publicKey);
  if (!signatureValid) return { cached: false };

  const claims = decodeOfflineCredentialToken(res.token);
  const record: CachedCredentialRecord = {
    credentialId: res.credentialId,
    token: res.token,
    claims,
    cachedAt: new Date().toISOString(),
  };
  await db.store<CachedCredentialRecord>('credentials').put(record);
  await db.store<PinAttemptState>('pin_attempts').put({
    credentialId: res.credentialId,
    failedAttempts: 0,
    lockedOut: false,
    lockedUntil: undefined,
    unlockChallenge: undefined,
    unlockAttempts: undefined,
  });
  return { cached: true };
}

/** §7.2 CRL check — called by the reconciler when an `offline_authorizations.revoked` event pulls down. */
export async function applyCrlRevocationWithinTx(
  tx: TxHandle,
  credentialId: UUID,
  revokedAt: ISODateTime,
): Promise<void> {
  await tx.store<CredentialRevocationRecord>('credential_crl').put({ credentialId, revokedAt });
}

export async function isRevoked(db: LocalDatabase, credentialId: UUID): Promise<boolean> {
  return (
    (await db.store<CredentialRevocationRecord>('credential_crl').get(credentialId)) !== undefined
  );
}

export async function isLockedOut(db: LocalDatabase, credentialId: UUID): Promise<boolean> {
  const state = await db.store<PinAttemptState>('pin_attempts').get(credentialId);
  return state?.lockedOut ?? false;
}

/**
 * B-17 — milliseconds left on the soft cooldown, or 0 if the credential can be
 * tried right now.
 *
 * Reads the device clock, which an operator can move. That is accepted rather
 * than defended: the cooldown is a speed bump against fat fingers and casual
 * guessing, and anyone able to change the tablet's clock already has the device
 * in their hands, which is the threat `PIN_MAX_ATTEMPTS` — a terminal count, not
 * a timer — is there for. The two are deliberately different kinds of limit.
 */
export async function remainingCooldownMs(
  db: LocalDatabase,
  credentialId: UUID,
  nowIso: string = new Date().toISOString(),
): Promise<number> {
  const state = await db.store<PinAttemptState>('pin_attempts').get(credentialId);
  if (!state?.lockedUntil) return 0;
  const remaining = new Date(state.lockedUntil).getTime() - new Date(nowIso).getTime();
  return remaining > 0 ? remaining : 0;
}

/**
 * B-17 — the challenge to read to head office, or `null` if this credential is
 * not terminally locked (in which case there is nothing to recover from).
 */
export async function getUnlockChallenge(
  db: LocalDatabase,
  credentialId: UUID,
): Promise<{ challenge: string; attemptsLeft: number } | null> {
  const state = await db.store<PinAttemptState>('pin_attempts').get(credentialId);
  if (!state?.lockedOut || !state.unlockChallenge) return null;
  return {
    challenge: state.unlockChallenge,
    attemptsLeft: Math.max(0, UNLOCK_MAX_ATTEMPTS - (state.unlockAttempts ?? 0)),
  };
}

export type RedeemUnlockOutcome =
  | { ok: true }
  | { ok: false; reason: 'not_locked' | 'no_challenge' | 'invalid'; attemptsLeft: number }
  | { ok: false; reason: 'attempts_exhausted'; attemptsLeft: 0 };

/**
 * B-17 — verifies an unlock code read over the phone and, if it is right,
 * brings a terminally-locked credential back to life ON THE DEVICE, with no
 * connectivity.
 *
 * The device can do this alone because it already holds `k`: head office
 * computed `HMAC(k, unlock‖v1‖credentialId‖challenge)` from its own copy, and
 * this recomputes the same thing. Both sides derive it through the SAME
 * `@mimi/shared` helpers — the §7.3 binding HMAC was once defined twice, agreed
 * in prose and disagreed in bytes, and broke every offline approval silently.
 *
 * Wrong codes are capped at `UNLOCK_MAX_ATTEMPTS`. That cap is enforced by code
 * running on hardware the attacker may be holding, so it is the code's 40 bits
 * of entropy doing the real work; the cap is there to stop casual grinding and
 * to make the terminal state honest rather than infinite.
 */
export async function redeemUnlockCode(
  db: LocalDatabase,
  credentialId: UUID,
  submittedCode: string,
): Promise<RedeemUnlockOutcome> {
  const attemptsStore = db.store<PinAttemptState>('pin_attempts');
  const state = await attemptsStore.get(credentialId);
  if (!state?.lockedOut) return { ok: false, reason: 'not_locked', attemptsLeft: 0 };
  if (!state.unlockChallenge) return { ok: false, reason: 'no_challenge', attemptsLeft: 0 };

  const used = state.unlockAttempts ?? 0;
  if (used >= UNLOCK_MAX_ATTEMPTS) {
    return { ok: false, reason: 'attempts_exhausted', attemptsLeft: 0 };
  }

  const cached = await db.store<CachedCredentialRecord>('credentials').get(credentialId);
  if (!cached) return { ok: false, reason: 'no_challenge', attemptsLeft: 0 };

  const expected = encodeUnlockCode(
    await hmacSha256Hex(cached.claims.k, unlockCodeMessage(credentialId, state.unlockChallenge)),
  );

  if (!unlockCodeMatches(expected, submittedCode)) {
    const unlockAttempts = used + 1;
    await attemptsStore.put({ ...state, unlockAttempts });
    const attemptsLeft = Math.max(0, UNLOCK_MAX_ATTEMPTS - unlockAttempts);
    return attemptsLeft === 0
      ? { ok: false, reason: 'attempts_exhausted', attemptsLeft: 0 }
      : { ok: false, reason: 'invalid', attemptsLeft };
  }

  // Back to a clean slate — including `failedAttempts`, because leaving the PIN
  // counter at 5 would send the credential straight back into a terminal lock on
  // the next mistyped digit, which is not what "unlocked" means to the person
  // who just spent a phone call getting here.
  await attemptsStore.put({
    credentialId,
    failedAttempts: 0,
    lockedOut: false,
    lockedUntil: undefined,
    unlockChallenge: undefined,
    unlockAttempts: undefined,
  });
  return { ok: true };
}

/**
 * Six digits from a CSPRNG. `crypto.getRandomValues` and never `Math.random()`:
 * a predictable challenge would let anyone who knows `k`'s message format
 * precompute codes, and — unlike `crypto.subtle` — `getRandomValues` is
 * available on an insecure origin, which the demo box still is (B-14).
 */
function generateUnlockChallenge(): string {
  const max = 10 ** UNLOCK_CHALLENGE_LENGTH;
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  // Rejection-free modulo bias is not worth chasing for a non-secret nonce, but
  // the value is still drawn from a CSPRNG so it cannot be guessed ahead.
  return String(buf[0]! % max).padStart(UNLOCK_CHALLENGE_LENGTH, '0');
}

/** Shared HMAC path with `computeBindingHmac`, kept in one place so both use the same Web Crypto call. */
async function hmacSha256Hex(kBase64: string, message: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SubtleCrypto is unavailable in this environment');
  const key = await subtle.importKey(
    'raw',
    base64ToBytes(kBase64) as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message) as unknown as BufferSource,
  );
  return bytesToHex(new Uint8Array(sig));
}

/** Display-safe summary of a cached credential — everything a Wave 4 approval UI needs to LIST which supervisors have a usable offline credential on this device, without exposing the binding secret `k` or the raw token. */
export interface CachedCredentialSummary {
  credentialId: UUID;
  approverUserId: UUID;
  role: string;
  scopes: Record<string, { maxIdr?: Money }>;
  expiresAt: ISODateTime;
  revoked: boolean;
  lockedOut: boolean;
  /**
   * RISK-S2 — the amount at or above which this credential requires a selfie
   * (§7.2 `selfieRequiredAboveIdr`).
   *
   * Exposed so a SURFACE can enforce the same threshold `authorizeOffline`
   * enforces, rather than discovering it by rejection. Without it the void
   * modal could only offer the camera optionally, and a supervisor voiding a
   * large sale would enter their PIN, tap approve, and get
   * `selfie_required` back — in front of a customer. A control people meet as
   * an unexplained refusal is one they learn to work around.
   */
  selfieRequiredAboveIdr: Money;
}

/**
 * Lists every offline credential cached on this device (§7.2). Exists so
 * Wave 4 surfaces (POS void/refund approval, outlet waste approval) can
 * discover a usable `credentialId` through the SAME public API they already
 * write through (`LocalRuntime`) instead of reaching into
 * `runtime.db.store('credentials').getAll()` directly, which breaks the
 * encapsulation `api/local-runtime.ts` exists to provide.
 */
export async function listCachedCredentials(db: LocalDatabase): Promise<CachedCredentialSummary[]> {
  const [creds, crl, attempts] = await Promise.all([
    db.store<CachedCredentialRecord>('credentials').getAll(),
    db.store<CredentialRevocationRecord>('credential_crl').getAll(),
    db.store<PinAttemptState>('pin_attempts').getAll(),
  ]);
  const revokedIds = new Set(crl.map((r) => r.credentialId));
  const lockedOutIds = new Set(attempts.filter((a) => a.lockedOut).map((a) => a.credentialId));

  return creds.map((c) => ({
    credentialId: c.credentialId,
    approverUserId: c.claims.sub,
    role: c.claims.role,
    scopes: c.claims.scopes,
    expiresAt: c.claims.exp,
    revoked: revokedIds.has(c.credentialId),
    lockedOut: lockedOutIds.has(c.credentialId),
    selfieRequiredAboveIdr: c.claims.selfieRequiredAboveIdr,
  }));
}

export interface AuthorizeOfflineInput {
  credentialId: UUID;
  pin: string;
  /** The `HMAC(k, event_id‖entity‖entity_id‖op‖amount_idr‖occurred_at)` inputs (§7.3). */
  eventId: UUID;
  entity: string;
  entityId: UUID;
  op: string;
  amountIdr: Money | null;
  occurredAt: ISODateTime;
  selfieRef?: { sha256: string; size: number; mime: string };
  scopeKey: string;
}

export type AuthorizeOfflineOutcome =
  | { ok: true; meta: OfflineAuthorizationMeta }
  | {
      ok: false;
      /** Only on `cooling_down` — how long until this credential can be tried again. */
      retryAfterSeconds?: number;
      reason:
        | 'revoked'
        | 'locked_out'
        /**
         * B-17 — the SOFT, self-clearing cooldown. Distinct from `locked_out`
         * on purpose: one means "wait 30 seconds", the other means "this
         * credential is dead until the device is online again", and telling a
         * supervisor the second when the first is true would send them looking
         * for connectivity they do not need.
         */
        | 'cooling_down'
        | 'expired'
        | 'scope_exceeded'
        | 'selfie_required'
        | 'pin_invalid'
        | 'not_cached';
    };

/**
 * The full §7.3 device-side flow. This function's verdict is ADVISORY UX
 * only — §7.4 says the cloud re-verifies everything at apply, and this local
 * gate exists so the cashier doesn't walk away thinking an approval worked
 * when it is trivially, locally, already known to be dead (revoked/expired/
 * locked out), not to substitute for that re-verification.
 */
export async function authorizeOffline(
  db: LocalDatabase,
  input: AuthorizeOfflineInput,
  pinVerifier: PinVerifier,
  nowIso: string = new Date().toISOString(),
): Promise<AuthorizeOfflineOutcome> {
  const cached = await db.store<CachedCredentialRecord>('credentials').get(input.credentialId);
  if (!cached) return { ok: false, reason: 'not_cached' };

  if (await isRevoked(db, input.credentialId)) return { ok: false, reason: 'revoked' };
  if (await isLockedOut(db, input.credentialId)) return { ok: false, reason: 'locked_out' };

  // B-17 — the soft cooldown is checked BEFORE the PIN is verified, for the
  // same reason the server checks its lock before reading the code row: an
  // attempt that never reaches the verifier must not be able to tell you
  // anything, and argon2id at m=64MiB is slow enough that letting a
  // cooling-down caller run it is also a free way to hang the tablet.
  const cooling = await remainingCooldownMs(db, input.credentialId, nowIso);
  if (cooling > 0) {
    return {
      ok: false,
      reason: 'cooling_down',
      retryAfterSeconds: Math.ceil(cooling / 1000),
    };
  }

  const provability: ExpiryProvability = evaluateExpiryProvability(
    input.occurredAt,
    null,
    cached.claims.exp,
  );
  if (
    provability === 'expired' &&
    new Date(nowIso).getTime() > new Date(cached.claims.exp).getTime()
  ) {
    return { ok: false, reason: 'expired' };
  }

  const scope = cached.claims.scopes[input.scopeKey];
  if (!scope) return { ok: false, reason: 'scope_exceeded' };
  if (scope.maxIdr && input.amountIdr && parseFloat(input.amountIdr) > parseFloat(scope.maxIdr)) {
    return { ok: false, reason: 'scope_exceeded' };
  }

  const amount = input.amountIdr ? parseFloat(input.amountIdr) : 0;
  const selfieThreshold = parseFloat(cached.claims.selfieRequiredAboveIdr);
  if (amount >= selfieThreshold && !input.selfieRef) {
    return { ok: false, reason: 'selfie_required' };
  }

  const attemptsStore = db.store<PinAttemptState>('pin_attempts');
  const attemptState = (await attemptsStore.get(input.credentialId)) ?? {
    credentialId: input.credentialId,
    failedAttempts: 0,
    lockedOut: false,
  };

  const valid = await pinVerifier.verify(input.pin, cached.claims.pinVerifier);
  if (!valid) {
    const failedAttempts = attemptState.failedAttempts + 1;
    const lockedOut = failedAttempts >= PIN_MAX_ATTEMPTS;
    const backoffMs = PIN_BACKOFF_MS_BY_FAILURE_COUNT[failedAttempts];
    // A terminal lock supersedes the cooldown rather than stacking with it —
    // `lockedUntil` on a dead credential would imply it comes back on its own.
    const lockedUntil =
      !lockedOut && backoffMs
        ? new Date(new Date(nowIso).getTime() + backoffMs).toISOString()
        : undefined;
    await attemptsStore.put({
      credentialId: input.credentialId,
      failedAttempts,
      lockedOut,
      lockedUntil,
      // B-17 — the moment the credential goes terminal, mint the challenge the
      // supervisor will read down the phone. Generated HERE rather than when
      // the unlock screen opens, so it is stable for the whole call: a
      // challenge that changed while head office was computing the answer would
      // invalidate the code being read back.
      ...(lockedOut ? { unlockChallenge: generateUnlockChallenge(), unlockAttempts: 0 } : {}),
    });
    return { ok: false, reason: 'pin_invalid' };
  }

  const pinAttemptsBeforeSuccess = attemptState.failedAttempts + 1;
  await attemptsStore.put({
    credentialId: input.credentialId,
    failedAttempts: 0,
    lockedOut: false,
    lockedUntil: undefined,
    unlockChallenge: undefined,
    unlockAttempts: undefined,
  });

  const binding = await computeBindingHmac(cached.claims.k, {
    eventId: input.eventId,
    entity: input.entity,
    entityId: input.entityId,
    op: input.op,
    // Normalized to '' HERE, at the call site — matching the backend's
    // `BindingHmacInput.amountIdr: string` contract (kernel/sync/binding-crypto.ts),
    // which expects an already-normalized string and does no coalescing of
    // its own. Doing it here rather than inside `computeBindingHmac` keeps
    // that function a byte-for-byte mirror of the backend's `bindingMessage`.
    amountIdr: input.amountIdr ?? '',
    occurredAt: input.occurredAt,
  });

  const meta: OfflineAuthorizationMeta = {
    credentialId: input.credentialId,
    approverUserId: cached.claims.sub,
    binding,
    pinAttemptsBeforeSuccess,
    ...(input.selfieRef ? { selfieRef: input.selfieRef } : {}),
    ...(input.amountIdr ? { amountIdr: input.amountIdr } : {}),
  };

  return { ok: true, meta };
}

/**
 * §7.3's binding: `HMAC_SHA256(k, event_id ‖ entity ‖ entity_id ‖ op ‖
 * amount_idr ‖ occurred_at)`, hex-encoded (64 hex chars — matches
 * CONTRACTS.md's `binding_hmac VARCHAR(64)` exactly).
 *
 * MIRRORS `apps/backend/src/kernel/sync/binding-crypto.ts`'s
 * `bindingMessage`/`computeBindingHmac` character for character — this was
 * previously a joiner mismatch (`'|'` U+007C here vs. the backend's `'‖'`
 * U+2016 DOUBLE VERTICAL LINE), which made every offline-authorized
 * approval fail §7.4 check 2's HMAC recomputation and land as `failed` in
 * the finance exception queue, unconditionally. Fixed by adopting the
 * backend's exact form. `amountIdr` is `string` here too (NOT `Money |
 * null`) for the same reason: the backend's `BindingHmacInput.amountIdr`
 * is a plain `string` ("''` if the action carries no amount") with no
 * internal coalescing — this function must not silently do something the
 * backend doesn't, so the `null` → `''` normalization lives at the ONE call
 * site (`authorizeOffline`, above), exactly where the backend expects ITS
 * caller to have already done it.
 *
 * `binding-fixture.test.ts` pins a known (key, inputs) → hex-digest fixture
 * computed independently via Node's `crypto` module, so this function's
 * correctness is checked against a literal expected value rather than only
 * "the two implementations agree in prose" — which is exactly how the
 * joiner mismatch went undetected until now.
 */
export async function computeBindingHmac(
  kBase64: string,
  fields: {
    eventId: UUID;
    entity: string;
    entityId: UUID;
    op: string;
    amountIdr: string;
    occurredAt: ISODateTime;
  },
): Promise<string> {
  const message = [
    fields.eventId,
    fields.entity,
    fields.entityId,
    fields.op,
    fields.amountIdr,
    fields.occurredAt,
  ].join('‖');
  const keyBytes = base64ToBytes(kBase64);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('Web Crypto SubtleCrypto is unavailable in this environment');
  const key = await subtle.importKey(
    'raw',
    keyBytes as unknown as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(message) as unknown as BufferSource,
  );
  return bytesToHex(new Uint8Array(sig));
}

function base64ToBytes(b64: string): Uint8Array {
  const bin =
    typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}
