import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../test-support/fixtures';
import { FakeCloud } from '../transport/fake-cloud';
import { createLocalRuntime } from '..';
import type { ConnectivityReporter } from '../sync/sync-engine';
import type { OfflineCredentialClaims } from '../types';
import { encodeOfflineCredentialToken } from '../credentials/offline-credentials';

function noopConnectivity(): ConnectivityReporter {
  return {
    setTier() {},
    setCloudReachable() {},
    setQueueDepth() {},
    setLastSyncAt() {},
    setSyncing() {},
  };
}

/**
 * Covers the two gaps found by W4-07/POS wiring real surfaces against
 * `LocalRuntime`: `captureEvidence` must hand back an `attachmentId` (not
 * just a `sha256`), and there must be a public way to discover a cached
 * credential's id without reaching into `runtime.db.store(...)` directly.
 */
describe('LocalRuntime public API — attachment/credential discovery', () => {
  function makeRuntime() {
    return createLocalRuntime({
      db: createTestDatabase(),
      transport: new FakeCloud(),
      candidates: [],
      connectivity: noopConnectivity(),
    });
  }

  it('captureEvidence returns an attachmentId usable as an event reference', async () => {
    const runtime = makeRuntime();
    await runtime.init();
    const ref = await runtime.captureEvidence(
      new Blob(['photo-bytes']),
      'image/jpeg',
      'sj_drop_photo',
    );
    expect(ref.attachmentId).toBeTruthy();
    expect(ref.sha256).toBeTruthy();
    expect(ref.attachmentId).not.toBe(ref.sha256);
  });

  it('listCachedCredentials() discovers a cached credential id — the encapsulated replacement for reaching into runtime.db.store(...) directly', async () => {
    const runtime = makeRuntime();
    await runtime.init();

    const claims: OfflineCredentialClaims = {
      credentialId: 'cred-1',
      sub: 'supervisor-1',
      role: 'supervisor',
      locationIds: ['loc-1'],
      scopes: { 'void_refund.approve': { maxIdr: '500000.00' } },
      iat: new Date().toISOString(),
      exp: new Date(Date.now() + 3600_000).toISOString(),
      k: Buffer.from('binding-secret-bytes-0123456789', 'utf8').toString('base64'),
      pinVerifier: 'fake-hash',
      selfieRequiredAboveIdr: '200000.00',
    };
    await runtime.cacheOfflineCredential({
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });

    const list = await runtime.listCachedCredentials();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      credentialId: 'cred-1',
      approverUserId: 'supervisor-1',
      role: 'supervisor',
      revoked: false,
      lockedOut: false,
    });
  });

  it('listCachedCredentials() returns an empty list, not an error, when nothing is cached', async () => {
    const runtime = makeRuntime();
    await runtime.init();
    expect(await runtime.listCachedCredentials()).toEqual([]);
  });
});

describe('LocalRuntime.recheckConnectivity() — the "Coba Sinkron" retry affordance', () => {
  it('delegates to the engine and reports isolated + no upstream when there is nothing to talk to (no candidates)', async () => {
    const runtime = createLocalRuntime({
      db: createTestDatabase(),
      transport: new FakeCloud(),
      candidates: [],
      connectivity: noopConnectivity(),
    });
    await runtime.init();

    const result = await runtime.recheckConnectivity();
    expect(result).toEqual({ tier: 'isolated', hasUpstream: false });
  });

  it('reports online + an upstream once a healthy cloud candidate exists, without calling start()/stop()', async () => {
    const runtime = createLocalRuntime({
      db: createTestDatabase(),
      transport: new FakeCloud(),
      candidates: [{ kind: 'cloud', baseUrl: 'https://cloud.mimi' }],
      connectivity: noopConnectivity(),
    });
    await runtime.init();

    const result = await runtime.recheckConnectivity();
    expect(result).toEqual({ tier: 'online', hasUpstream: true });
    expect(runtime.getUpstreamState().tier).toBe('online');
  });
});
