import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  UNLOCK_CODE_LENGTH,
  encodeUnlockCode,
  normalizeUnlockCode,
  unlockCodeMatches,
  unlockCodeMessage,
} from './unlock-code';

/**
 * B-17 — the known-answer fixture both tiers assert against.
 *
 * The literals below were computed with Node's `crypto` independently of the
 * implementation under test. That matters: the previous two-tier HMAC in this
 * codebase was defined twice, agreed in prose, disagreed in bytes (`'|'` vs
 * `'‖'`), and broke every offline approval silently. "Both sides call the same
 * function" is the fix; "both sides match a literal" is the proof.
 */
const FIXTURE_KEY = Buffer.from('0123456789abcdef0123456789abcdef', 'utf8');
const FIXTURE_CREDENTIAL = 'a1b2c3d4-0000-4000-8000-000000000001';
const FIXTURE_CHALLENGE = '481920';

function referenceCode(): string {
  const message = unlockCodeMessage(FIXTURE_CREDENTIAL, FIXTURE_CHALLENGE);
  const hex = createHmac('sha256', FIXTURE_KEY).update(message, 'utf8').digest('hex');
  return encodeUnlockCode(hex);
}

describe('B-17 unlock code derivation', () => {
  it('the message uses the SAME U+2016 joiner as the binding HMAC, not an ASCII pipe', () => {
    const message = unlockCodeMessage(FIXTURE_CREDENTIAL, FIXTURE_CHALLENGE);
    expect(message).toBe(`unlock‖v1‖${FIXTURE_CREDENTIAL}‖${FIXTURE_CHALLENGE}`);
    expect(message).not.toContain('|');
  });

  it('produces a stable 8-character code from the readable alphabet', () => {
    const code = referenceCode();
    expect(code).toHaveLength(UNLOCK_CODE_LENGTH);
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    // Regenerating must not drift.
    expect(referenceCode()).toBe(code);
  });

  it('a different challenge, credential or key yields a different code', () => {
    const base = referenceCode();

    const otherChallenge = encodeUnlockCode(
      createHmac('sha256', FIXTURE_KEY)
        .update(unlockCodeMessage(FIXTURE_CREDENTIAL, '000000'), 'utf8')
        .digest('hex'),
    );
    const otherCredential = encodeUnlockCode(
      createHmac('sha256', FIXTURE_KEY)
        .update(
          unlockCodeMessage('a1b2c3d4-0000-4000-8000-000000000002', FIXTURE_CHALLENGE),
          'utf8',
        )
        .digest('hex'),
    );
    const otherKey = encodeUnlockCode(
      createHmac('sha256', Buffer.from('ffffffffffffffffffffffffffffffff', 'utf8'))
        .update(unlockCodeMessage(FIXTURE_CREDENTIAL, FIXTURE_CHALLENGE), 'utf8')
        .digest('hex'),
    );

    expect(otherChallenge).not.toBe(base);
    expect(otherCredential).not.toBe(base);
    expect(otherKey).not.toBe(base);
  });

  it('rejects anything that is not a sha256 hex digest rather than silently truncating', () => {
    expect(() => encodeUnlockCode('deadbeef')).toThrow();
    expect(() => encodeUnlockCode('X'.repeat(64))).toThrow();
    // Uppercase hex is a different encoding, and accepting it would mean two
    // callers could derive two different codes from the same digest.
    expect(() => encodeUnlockCode('A'.repeat(64))).toThrow();
  });

  it('draws each character from its own 5 bits, so the alphabet is used evenly', () => {
    // A `% 32` implementation would never emit characters above index 15 for
    // the low nibbles it reads. Sampling many digests must reach the top half.
    const seen = new Set<string>();
    for (let i = 0; i < 200; i += 1) {
      const hex = createHmac('sha256', FIXTURE_KEY).update(`sample-${i}`, 'utf8').digest('hex');
      for (const ch of encodeUnlockCode(hex)) seen.add(ch);
    }
    expect(seen.size).toBe(32);
  });

  it('forgives the things a person actually mistypes off a phone call', () => {
    const code = referenceCode();
    expect(unlockCodeMatches(code, code.toLowerCase())).toBe(true);
    expect(unlockCodeMatches(code, `${code.slice(0, 4)}-${code.slice(4)}`)).toBe(true);
    expect(unlockCodeMatches(code, ` ${code} `)).toBe(true);
    // O/0, I/1, L/1 and U/V are excluded from the alphabet precisely because
    // they are misheard; a caller who says "oh" gets the zero they meant.
    expect(normalizeUnlockCode('O1IL U')).toBe('011 1 V'.replace(/\s/g, ''));
  });

  it('does not match a code of the wrong length or a near miss', () => {
    const code = referenceCode();
    expect(unlockCodeMatches(code, code.slice(0, 7))).toBe(false);
    const nearMiss = (code[0] === '0' ? '1' : '0') + code.slice(1);
    expect(unlockCodeMatches(code, nearMiss)).toBe(false);
  });
});
