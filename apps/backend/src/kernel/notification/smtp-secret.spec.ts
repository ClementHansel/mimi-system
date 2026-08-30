import { beforeEach, describe, expect, it } from 'vitest';
import {
  canSealSecrets,
  maskSmtpPassword,
  openSmtpPassword,
  sealSmtpPassword,
  SmtpSecretError,
} from './smtp-secret';

/**
 * These hold a real credential — a Gmail App Password grants full send rights
 * on a tenant's mailbox — so the failure modes worth testing are the ones that
 * would hand a wrong or corrupted value to an SMTP server, or quietly weaken
 * the sealing.
 */
describe('smtp secret sealing', () => {
  beforeEach(() => {
    process.env.SETTINGS_ENCRYPTION_KEY = 'a'.repeat(64);
  });

  it('round-trips a password', () => {
    const sealed = sealSmtpPassword('abcd efgh ijkl mnop');
    expect(openSmtpPassword(sealed)).toBe('abcd efgh ijkl mnop');
  });

  it('never stores the plaintext anywhere in the sealed value', () => {
    // The whole point. A "sealed" value that still contains the password —
    // through a bad encoding or an accidental passthrough — would pass a
    // round-trip test perfectly.
    const sealed = sealSmtpPassword('hunter2-app-password');
    expect(sealed).not.toContain('hunter2');
    expect(Buffer.from(sealed).toString('utf8')).not.toContain('hunter2');
  });

  it('produces a different ciphertext every time', () => {
    // A fresh IV per seal. Identical output for identical input would tell an
    // attacker which tenants share a password, before decrypting anything.
    const a = sealSmtpPassword('same-password');
    const b = sealSmtpPassword('same-password');
    expect(a).not.toBe(b);
    expect(openSmtpPassword(a)).toBe(openSmtpPassword(b));
  });

  it('refuses a value sealed under a different key, rather than returning garbage', () => {
    const sealed = sealSmtpPassword('original');
    process.env.SETTINGS_ENCRYPTION_KEY = 'b'.repeat(64);
    // GCM authenticates, so this fails closed. With CBC it would "succeed" and
    // hand random bytes to an SMTP server as a password.
    expect(() => openSmtpPassword(sealed)).toThrow(SmtpSecretError);
  });

  it('refuses tampered ciphertext', () => {
    const sealed = sealSmtpPassword('original');
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered-ciphertext').toString('base64url');
    expect(() => openSmtpPassword(parts.join('.'))).toThrow(SmtpSecretError);
  });

  it('refuses a malformed or foreign-format value', () => {
    expect(() => openSmtpPassword('not-sealed-at-all')).toThrow(SmtpSecretError);
    expect(() => openSmtpPassword('v2.a.b.c')).toThrow(/Unrecognised/);
  });

  it('reports a missing key instead of sealing with a weak one', () => {
    delete process.env.SETTINGS_ENCRYPTION_KEY;
    expect(canSealSecrets()).toBe(false);
    expect(() => sealSmtpPassword('x')).toThrow(/SETTINGS_ENCRYPTION_KEY/);
    // Short keys are refused too: accepting them would mean a deployment that
    // looks encrypted and is trivially brute-forced.
    process.env.SETTINGS_ENCRYPTION_KEY = 'short';
    expect(canSealSecrets()).toBe(false);
  });

  it('masks rather than echoing anything derived from the secret', () => {
    const sealed = sealSmtpPassword('abcd efgh');
    const masked = maskSmtpPassword(sealed);
    expect(masked).toBe('••••••••');
    // The ciphertext is still the secret; returning it to a client would be
    // the same mistake as returning the password.
    expect(masked).not.toContain(sealed.slice(0, 8));
    expect(maskSmtpPassword(null)).toBeNull();
  });
});
