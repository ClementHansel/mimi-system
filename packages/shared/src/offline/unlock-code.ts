/**
 * B-17 — the offline credential UNLOCK CODE, defined once for both tiers.
 *
 * ## What this is for
 *
 * A tablet at an outlet with no internet locks a supervisor's cached credential
 * after five wrong PINs (`PIN_MAX_ATTEMPTS`). Before this existed, that
 * credential was dead until connectivity returned — which, during the exact
 * outage offline-first exists for, could mean a shift with no way to authorise
 * a void at all.
 *
 * The recovery channel is the one an isolated outlet still has: a phone call.
 * The tablet shows a CHALLENGE, the supervisor reads it to head office, head
 * office types it into the online system and reads back a CODE, and the tablet
 * verifies that code locally with the binding secret it already holds. No
 * connectivity is needed on the device at any point.
 *
 * ## Why the derivation lives in `@mimi/shared`
 *
 * Because the last time a two-tier HMAC message was defined twice, the two
 * definitions used different joiner characters (`'|'` vs `'‖'`) and EVERY
 * offline-authorized approval failed §7.4's recomputation — silently, landing
 * in the finance exception queue. The message construction and the encoding are
 * therefore written once, here, and both tiers import them; only the HMAC call
 * itself differs (Web Crypto on the device, `node:crypto` on the server),
 * because those are the primitives each side actually has.
 *
 * `unlock-code.fixture.test.ts` pins a known (key, challenge) → code triple, and
 * both tiers assert against that same literal rather than against each other.
 */

/** Chars a human reads over a bad phone line: Crockford base32 minus I, L, O and U. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * Eight characters ≈ 40 bits. Deliberately longer than the 6-digit approval
 * code, because this one is verified ON THE DEVICE, where the attacker holds
 * the hardware and no server-side limiter can see the attempts. The device's
 * own `UNLOCK_MAX_ATTEMPTS` cap is the other half of that defence, but a cap
 * enforced by code the attacker controls is worth less than entropy.
 */
export const UNLOCK_CODE_LENGTH = 8;

/**
 * How many wrong unlock codes a device accepts before the credential is beyond
 * offline recovery entirely.
 *
 * Three, not five: reaching here already means five wrong PINs, and someone who
 * then also cannot read an 8-character code off a phone call three times is not
 * the case this feature is for. The terminal state is honest and recoverable —
 * the credential is re-issued the moment the device is online again.
 */
export const UNLOCK_MAX_ATTEMPTS = 3;

/** Six digits, zero-padded — short enough to read aloud, and it is not a secret. */
export const UNLOCK_CHALLENGE_LENGTH = 6;

/**
 * The exact bytes both tiers HMAC.
 *
 * `v1:` is a version prefix so a future change to this scheme cannot silently
 * accept codes minted under the old one. The credential id is included so a
 * code computed for one credential is inert against another, and the challenge
 * so a code is inert once the device has moved on to a new lock.
 */
export function unlockCodeMessage(credentialId: string, challenge: string): string {
  return ['unlock', 'v1', credentialId, challenge].join('‖');
}

/**
 * Folds an HMAC-SHA256 hex digest down to the readable code.
 *
 * Takes 5 bits at a time off the digest — NOT `digest % 32` per character,
 * which would bias toward the low end of the alphabet and quietly shrink the
 * search space the length above is chosen to provide.
 */
export function encodeUnlockCode(hmacHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(hmacHex)) {
    throw new Error('unlock code derivation expects a 64-char lowercase sha256 hex digest');
  }
  let bits = '';
  // 8 chars × 5 bits = 40 bits = the first 10 hex characters.
  for (let i = 0; i < 10; i += 1) {
    bits += parseInt(hmacHex[i]!, 16).toString(2).padStart(4, '0');
  }
  let out = '';
  for (let i = 0; i < UNLOCK_CODE_LENGTH; i += 1) {
    out += ALPHABET[parseInt(bits.slice(i * 5, i * 5 + 5), 2)];
  }
  return out;
}

/**
 * Normalizes what a human typed: case, spaces and hyphens are noise, and the
 * four excluded letters are almost always a misread of the digit they resemble.
 * Doing this in shared code means the device and any future server-side check
 * forgive exactly the same things.
 */
export function normalizeUnlockCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V');
}

/**
 * Constant-time-ish comparison. Not a defence against a remote timing attack
 * (there is no network here — this runs on the device doing the check), but it
 * costs nothing and keeps the habit intact for whoever copies this function
 * somewhere it does matter.
 */
export function unlockCodeMatches(expected: string, submitted: string): boolean {
  const a = expected;
  const b = normalizeUnlockCode(submitted);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
