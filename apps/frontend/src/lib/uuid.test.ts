import { afterEach, describe, expect, it, vi } from 'vitest';
import { newUuid } from './uuid';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('newUuid (insecure-context-safe UUID minting)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses crypto.randomUUID when present', () => {
    const spy = vi.spyOn(crypto, 'randomUUID');
    const id = newUuid();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(id).toMatch(UUID_V4_RE);
  });

  it('falls back to crypto.getRandomValues when crypto.randomUUID is absent (simulating an insecure HTTP origin)', () => {
    // `crypto.randomUUID` is only defined in a secure context (HTTPS or
    // localhost) — this simulates the plain-HTTP-on-IP deployment where it
    // is `undefined`, which is the exact bug this helper exists to avoid.
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
      // no randomUUID property at all
    });

    const id = newUuid();

    expect(id).toMatch(UUID_V4_RE);
  });

  it('fallback path sets the version nibble to 4 and the variant bits to 10xx', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });

    for (let i = 0; i < 50; i++) {
      const id = newUuid();
      expect(id).toMatch(UUID_V4_RE);
      const variantNibble = id[19]!.toLowerCase();
      expect(['8', '9', 'a', 'b']).toContain(variantNibble);
    }
  });

  it('fallback path produces two different ids on successive calls', () => {
    vi.stubGlobal('crypto', {
      getRandomValues: crypto.getRandomValues.bind(crypto),
    });

    const a = newUuid();
    const b = newUuid();
    expect(a).not.toBe(b);
  });

  it('throws instead of silently degrading to Math.random when no CSPRNG is available at all', () => {
    vi.stubGlobal('crypto', undefined);
    expect(() => newUuid()).toThrow();
  });
});
