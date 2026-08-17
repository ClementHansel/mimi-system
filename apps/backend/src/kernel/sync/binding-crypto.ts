/**
 * Offline-authorization credential crypto (SYNC-PROTOCOL §7.2/§7.3).
 *
 * Two independent pieces of key material, per §7.2's token shape:
 *  - `k` — the 32-byte per-issuance "binding secret". Minted at credential
 *    mint time (M01 `auth.offline_credential.mint`, Wave 3, not yet built),
 *    stored at rest as `offline_credentials.binding_secret_enc` (BYTEA),
 *    and also shipped inside the signed token to the device (§7.2) so the
 *    device can compute the binding HMAC locally. This module owns the
 *    at-rest encryption so cloud storage and cloud re-verification
 *    (§7.4 check 2) share one implementation.
 *  - The binding HMAC itself: `HMAC_SHA256(k, event_id ‖ entity ‖ entity_id
 *    ‖ op ‖ amount_idr ‖ occurred_at)` (§7.3 verbatim).
 *
 * COORDINATION NOTE for whoever builds M01's credential-mint endpoint: mint
 * `k` with `randomBytes(32)`, call `encryptBindingSecret(k, encKey)` and
 * store the result in `offline_credentials.binding_secret_enc`, using the
 * SAME `OFFLINE_CREDENTIAL_ENC_KEY` env var this module reads (see
 * `encKeyFromConfig`). This is the only place that key is interpreted —
 * keep it that way rather than re-deriving the cipher elsewhere.
 */
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const KEY_BYTES = 32;

/**
 * `OFFLINE_CREDENTIAL_ENC_KEY` — 64 hex chars (32 bytes), same env-var
 * convention as `common/jwt/jwt-secrets.ts`. Dev default is intentionally
 * fixed and MUST be overridden in every non-dev environment (secrets never
 * live in code — this default is a placeholder, not a secret).
 */
export function encKeyFromConfig(config: ConfigService): Buffer {
  const hex = config.get<string>(
    'OFFLINE_CREDENTIAL_ENC_KEY',
    '0'.repeat(64), // dev-only placeholder — 32 zero bytes, never used outside local dev
  );
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `OFFLINE_CREDENTIAL_ENC_KEY must decode to ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${key.length}`,
    );
  }
  return key;
}

export function generateBindingSecret(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** `iv (12) || authTag (16) || ciphertext` — self-contained, no separate nonce column needed. */
export function encryptBindingSecret(k: Buffer, encKey: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(k), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptBindingSecret(enc: Buffer, encKey: Buffer): Buffer {
  const iv = enc.subarray(0, IV_BYTES);
  const authTag = enc.subarray(IV_BYTES, IV_BYTES + 16);
  const ciphertext = enc.subarray(IV_BYTES + 16);
  const decipher = createDecipheriv(ALGO, encKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export interface BindingHmacInput {
  eventId: string;
  entity: string;
  entityId: string;
  op: string;
  amountIdr: string; // Money decimal string; '' if the action carries no amount
  occurredAt: string;
}

function bindingMessage(input: BindingHmacInput): string {
  return [input.eventId, input.entity, input.entityId, input.op, input.amountIdr, input.occurredAt].join('‖');
}

/** `HMAC_SHA256(k, event_id ‖ entity ‖ entity_id ‖ op ‖ amount_idr ‖ occurred_at)`, hex-encoded (§7.3). */
export function computeBindingHmac(k: Buffer, input: BindingHmacInput): string {
  return createHmac('sha256', k).update(bindingMessage(input), 'utf8').digest('hex');
}

/** Constant-time compare — never a plain `===` on secret-derived material. */
export function verifyBindingHmac(k: Buffer, input: BindingHmacInput, providedHmacHex: string): boolean {
  const expected = computeBindingHmac(k, input);
  const expectedBuf = Buffer.from(expected, 'hex');
  const providedBuf = Buffer.from(providedHmacHex, 'hex');
  if (expectedBuf.length !== providedBuf.length) return false;
  return timingSafeEqual(expectedBuf, providedBuf);
}
