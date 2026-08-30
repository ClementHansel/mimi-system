import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Seals and opens a tenant's SMTP password.
 *
 * ENCRYPTED, NOT HASHED, and that is forced by the problem rather than chosen:
 * the password has to be replayed to Gmail on every send, so a one-way hash
 * cannot work here. This is a credential store, and the honest framing is that
 * anyone holding BOTH the database and `SETTINGS_ENCRYPTION_KEY` can read these
 * passwords. A Gmail App Password grants full send rights on that mailbox and
 * cannot be scoped to this application, so the blast radius of that pair
 * leaking is every tenant's outbound mail. OAuth2 refresh tokens would be
 * revocable and send-scoped; App Passwords were the owner's choice
 * (docs/MULTI-TENANCY.md §5), and this comment is where that trade-off lives.
 *
 * AES-256-GCM, not CBC: GCM authenticates the ciphertext, so a tampered or
 * truncated value fails to open instead of decrypting into garbage that gets
 * handed to an SMTP server as a password.
 *
 * Stored as `v1.<iv>.<authTag>.<ciphertext>`, all base64url. The version prefix
 * exists so a future key rotation or algorithm change can be detected rather
 * than guessed at — without it, the only way to change scheme is to break every
 * stored value at once.
 */

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // 96 bits, the size GCM is specified for
const KEY_ENV = 'SETTINGS_ENCRYPTION_KEY';

export class SmtpSecretError extends Error {}

/**
 * Derives the 32-byte key from the environment.
 *
 * SHA-256 of the configured value rather than requiring exactly 32 raw bytes:
 * operators set this from `openssl rand -hex 32` or a password manager, and
 * rejecting anything that is not precisely 32 bytes produces a deployment that
 * will not boot for a reason nobody can act on. Hashing accepts any input of
 * sufficient entropy and always yields a correctly sized key.
 *
 * Read at CALL TIME, not at module load, so a test can set the variable after
 * import and so a missing key surfaces on the operation that needs it rather
 * than crashing the whole application at startup — email being unconfigured
 * must not take down payroll.
 */
function key(): Buffer {
  const configured = process.env[KEY_ENV];
  if (!configured || configured.length < 16) {
    throw new SmtpSecretError(
      `${KEY_ENV} is missing or too short (need at least 16 characters). ` +
        `Generate one with: openssl rand -hex 32`,
    );
  }
  return createHash('sha256').update(configured).digest();
}

/** True when a key is configured — lets callers degrade instead of throwing. */
export function canSealSecrets(): boolean {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

export function sealSmtpPassword(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    VERSION,
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function openSmtpPassword(sealed: string): string {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    throw new SmtpSecretError(
      `Unrecognised sealed secret (expected ${VERSION}.<iv>.<tag>.<ciphertext>). ` +
        `A value stored under a different key or scheme cannot be opened.`,
    );
  }
  const [, ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(ivB64!, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64!, 'base64url'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataB64!, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // GCM's authentication failing means the ciphertext was tampered with OR
    // the key changed. Both are "cannot open this", and neither should leak
    // which — nor should the raw crypto error reach a caller that might log it.
    throw new SmtpSecretError(
      'Could not open the stored SMTP password: it was sealed with a different ' +
        `${KEY_ENV}, or the stored value has been altered. Re-enter the password in Settings.`,
    );
  }
}

/**
 * What the API returns instead of the password. Never the ciphertext either —
 * that is still the secret, just wearing a coat.
 */
export function maskSmtpPassword(sealed: string | null): string | null {
  return sealed ? '••••••••' : null;
}
