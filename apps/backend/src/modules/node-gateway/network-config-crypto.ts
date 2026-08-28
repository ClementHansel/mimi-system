/**
 * At-rest encryption for a branch node's WiFi passphrase
 * (`branch_nodes.network_secret_enc`, migration 254 — W3-10 hardening).
 *
 * Same convention as `kernel/sync/binding-crypto.ts`'s
 * `offline_credentials.binding_secret_enc` (AES-256-GCM, `iv (12) ||
 * authTag (16) || ciphertext`, one dev-placeholder env-var default that MUST
 * be overridden in every non-dev environment) — deliberately its OWN key
 * (`NODE_NETWORK_SECRET_ENC_KEY`), not a reuse of
 * `OFFLINE_CREDENTIAL_ENC_KEY`: these are two unrelated secret domains (an
 * offline-authorization binding secret vs. a physical outlet's WiFi
 * passphrase), and sharing one key would mean a key rotation for one forces
 * a rotation of the other, and a leak of one exposes the other.
 *
 * The passphrase this encrypts is WRITE-ONLY end to end: it is never
 * selected back out by `branch-nodes.repository.ts` (only
 * `network_secret_enc` is read, and only long enough to decrypt it onto the
 * one authenticated `/bridge` socket belonging to the node it's for — see
 * `nodes.controller.ts`'s `setNetworkConfig`), never included in the
 * `branch_nodes.config_updated` sync event (that payload is a separate,
 * secret-free projection), and never logged (nothing in this module or its
 * callers logs the plaintext or the ciphertext).
 */
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const KEY_BYTES = 32;

/** `NODE_NETWORK_SECRET_ENC_KEY` — 64 hex chars (32 bytes). Dev default is a fixed placeholder
 *  (never a real secret) and MUST be overridden outside local dev, same as `binding-crypto.ts`'s. */
export function networkSecretEncKeyFromConfig(config: ConfigService): Buffer {
  const hex = config.get<string>('NODE_NETWORK_SECRET_ENC_KEY', '0'.repeat(64));
  const key = Buffer.from(hex, 'hex');
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `NODE_NETWORK_SECRET_ENC_KEY must decode to ${KEY_BYTES} bytes (${KEY_BYTES * 2} hex chars), got ${key.length}`,
    );
  }
  return key;
}

/** `iv (12) || authTag (16) || ciphertext` — self-contained, no separate nonce column needed. */
export function encryptWifiPassphrase(passphrase: string, encKey: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, encKey, iv);
  const ciphertext = Buffer.concat([cipher.update(passphrase, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]);
}

export function decryptWifiPassphrase(enc: Buffer, encKey: Buffer): string {
  const iv = enc.subarray(0, IV_BYTES);
  const authTag = enc.subarray(IV_BYTES, IV_BYTES + AUTH_TAG_BYTES);
  const ciphertext = enc.subarray(IV_BYTES + AUTH_TAG_BYTES);
  const decipher = createDecipheriv(ALGO, encKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
