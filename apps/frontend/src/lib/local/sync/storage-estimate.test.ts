import { afterEach, describe, expect, it, vi } from 'vitest';
import { estimateStorage } from './sync-engine';

/**
 * D-08 — the heartbeat's storage figures.
 *
 * This was a hardcoded `{usedMb: 0, quotaMb: 0}`. The cloud derives
 * `storage_free_mb = quotaMb - usedMb`, so the whole fleet reported **0 MB
 * free** — which does not read as "no data", it reads as a full disk. The
 * tests below are mostly about the ABSENCE cases, because getting those wrong
 * is how the stub happened: every one of them must produce `undefined`
 * ("unknown"), and never a number that a threshold could act on.
 */
describe('estimateStorage (D-08)', () => {
  const original = globalThis.navigator;

  afterEach(() => {
    Object.defineProperty(globalThis, 'navigator', {
      value: original,
      configurable: true,
      writable: true,
    });
    vi.restoreAllMocks();
  });

  function withNavigator(value: unknown): void {
    Object.defineProperty(globalThis, 'navigator', {
      value,
      configurable: true,
      writable: true,
    });
  }

  it('reports real usage and quota, rounded to whole MB', async () => {
    withNavigator({
      storage: {
        estimate: async () => ({ usage: 52_428_800, quota: 1_073_741_824 }), // 50 MB of 1024 MB
      },
    });
    await expect(estimateStorage()).resolves.toEqual({ usedMb: 50, quotaMb: 1024 });
  });

  it('is undefined — not zero — when the Storage API is missing', async () => {
    withNavigator({});
    await expect(estimateStorage()).resolves.toBeUndefined();
  });

  it('is undefined when the browser answers with empty fields', async () => {
    // Spec-legal: `estimate()` may resolve `{}` when the origin has no
    // measurable quota. Returning `{usedMb: 0, quotaMb: 0}` here would be the
    // original bug wearing a different hat.
    withNavigator({ storage: { estimate: async () => ({}) } });
    await expect(estimateStorage()).resolves.toBeUndefined();
  });

  it('is undefined when the call throws', async () => {
    // Some privacy modes reject rather than returning empty.
    withNavigator({
      storage: {
        estimate: async () => {
          throw new Error('SecurityError');
        },
      },
    });
    await expect(estimateStorage()).resolves.toBeUndefined();
  });

  it('never reports a full disk for an empty one', async () => {
    // The regression in one line: a device using nothing must not be
    // indistinguishable from a device with nothing left.
    withNavigator({
      storage: { estimate: async () => ({ usage: 0, quota: 2_147_483_648 }) },
    });
    const empty = await estimateStorage();
    expect(empty).toEqual({ usedMb: 0, quotaMb: 2048 });
    // `storage_free_mb` as the cloud computes it.
    expect(empty!.quotaMb - empty!.usedMb).toBe(2048);
  });
});
