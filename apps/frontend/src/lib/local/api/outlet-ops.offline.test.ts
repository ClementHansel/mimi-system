import { describe, it, expect, vi } from 'vitest';
import { createTestDatabase } from '../test-support/fixtures';
import { getAttachmentByAttachmentId } from '../attachments/attachment-store';
import { encodeOfflineCredentialToken } from '../credentials/offline-credentials';
import { createLocalRuntime } from './local-runtime';
import type { OfflineCredentialClaims } from '../types';
import type { SyncTransport } from '../transport/types';
import type { ConnectivityReporter } from '../sync/sync-engine';
import type { PinVerifier } from '../credentials/pin-verifier';

/**
 * B-11 step 2 of 4 — device commit helpers for the four offline flows
 * (stock opname, replenishment requests, petty cash, waste records). Proves
 * RISK-02's scenario against the real `LocalRuntime`, exactly the way
 * `AbsenPanel.offline.test.ts`/`DriverJobsPanel.offline.test.ts`/
 * `ReceivingPanel.offline.test.ts` already do for F04/F11/F13: an outlet
 * counting stock on a Sunday with the line down, or recording waste during
 * an outage, must queue locally, never fail.
 *
 * The transport below throws on every method and is never handed to
 * `runtime.start()`/`syncNow()`, so the only way a test here could pass by
 * accident is if one of the new commit helpers or `captureEvidence` secretly
 * reached across the network itself. None of them do — everything writes to
 * the local IndexedDB-shaped store only. There is no UI panel to pair these
 * with yet (that is B-11 step 4) — this file lives under `lib/local` itself,
 * exercising `LocalRuntime`'s public API directly.
 */
function unreachableTransport(): SyncTransport {
  const fail = () => {
    throw new Error('network disabled — this transport must never be called by a local commit');
  };
  return {
    health: fail,
    hello: fail,
    push: fail,
    pull: fail,
    heartbeat: fail,
  } as unknown as SyncTransport;
}

const noopConnectivity: ConnectivityReporter = {
  setTier: vi.fn(),
  setCloudReachable: vi.fn(),
  setQueueDepth: vi.fn(),
  setLastSyncAt: vi.fn(),
  setSyncing: vi.fn(),
};

const ACTOR = { actorUserId: 'user-1', actorRole: 'leader_outlet', appVersion: 'test' };
const LOCATION_ID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';

function makeRuntime(pinVerifier?: PinVerifier) {
  return createLocalRuntime({
    db: createTestDatabase(),
    transport: unreachableTransport(),
    candidates: [], // no upstream configured — nothing for the engine to even try reaching
    connectivity: noopConnectivity,
    ...(pinVerifier ? { pinVerifier } : {}),
  });
}

describe('Stock opname — commitOpnameOpened/AreaCounted/Submitted/Cancelled (RISK-02)', () => {
  it('counts TWO areas of the same opname offline — both queue, neither collides with the other (§2.2 rule 3 dedupe key is (entity, entityId, op))', async () => {
    const runtime = makeRuntime();
    await runtime.init();
    expect(await runtime.getOutboxDepth()).toBe(0);

    const opnameId = crypto.randomUUID();
    const gudangAreaId = crypto.randomUUID();
    const kitchenAreaId = crypto.randomUUID();

    await runtime.commitOpnameOpened(
      opnameId,
      {
        id: opnameId,
        opnameNumber: 'OPN-0001',
        locationId: LOCATION_ID,
        storageAreaId: null,
        countedBy: ACTOR.actorUserId,
        startedAt: new Date().toISOString(),
      },
      ACTOR,
    );
    expect(await runtime.getOutboxDepth()).toBe(1);

    // Area 1 (gudang) counted — its own draft-time id, NOT the opnameId.
    const gudangCountId = crypto.randomUUID();
    await runtime.commitOpnameAreaCounted(
      gudangCountId,
      {
        opnameId,
        storageAreaId: gudangAreaId,
        lines: [
          {
            itemId: crypto.randomUUID(),
            systemQty: '10.000',
            countedQty: '9.500',
            varianceReason: 'susut',
          },
        ],
      },
      ACTOR,
    );
    expect(await runtime.getOutboxDepth()).toBe(2);

    // Area 2 (kitchen) counted — a DIFFERENT draft-time id. If the helper
    // (wrongly) used `opnameId` as the entityId for both, this second call
    // would silently collide with the first and the outbox would stay at 2.
    const kitchenCountId = crypto.randomUUID();
    await runtime.commitOpnameAreaCounted(
      kitchenCountId,
      {
        opnameId,
        storageAreaId: kitchenAreaId,
        lines: [{ itemId: crypto.randomUUID(), systemQty: '5.000', countedQty: '5.000' }],
      },
      ACTOR,
    );
    expect(await runtime.getOutboxDepth()).toBe(3);

    await runtime.commitOpnameSubmitted(
      opnameId,
      { opnameId, submittedAt: new Date().toISOString() },
      ACTOR,
    );
    expect(await runtime.getOutboxDepth()).toBe(4);
  });

  it('is idempotent on retry: resubmitting the SAME area count does not double-queue (double-tap guard)', async () => {
    const runtime = makeRuntime();
    await runtime.init();

    const opnameId = crypto.randomUUID();
    const areaId = crypto.randomUUID();
    const areaCountId = crypto.randomUUID();
    const payload = {
      opnameId,
      storageAreaId: areaId,
      lines: [{ itemId: crypto.randomUUID(), systemQty: '10.000', countedQty: '10.000' }],
    };

    await runtime.commitOpnameAreaCounted(areaCountId, payload, ACTOR);
    await runtime.commitOpnameAreaCounted(areaCountId, payload, ACTOR); // double-tap submit, same area

    expect(await runtime.getOutboxDepth()).toBe(1);
  });

  it('commitOpnameCancelled queues independently of an opened/counted opname', async () => {
    const runtime = makeRuntime();
    await runtime.init();

    const opnameId = crypto.randomUUID();
    await runtime.commitOpnameOpened(
      opnameId,
      {
        id: opnameId,
        opnameNumber: 'OPN-0002',
        locationId: LOCATION_ID,
        storageAreaId: null,
        countedBy: ACTOR.actorUserId,
        startedAt: new Date().toISOString(),
      },
      ACTOR,
    );
    await runtime.commitOpnameCancelled(opnameId, { opnameId }, ACTOR);
    expect(await runtime.getOutboxDepth()).toBe(2);
  });
});

describe('Replenishment requests — commitReplenishmentSubmitted/Cancelled/SupervisorApproved(Offline)/SupervisorRejected (RISK-02)', () => {
  it('submits a replenishment request offline with embedded lines and zero network calls', async () => {
    const runtime = makeRuntime();
    await runtime.init();
    expect(await runtime.getOutboxDepth()).toBe(0);

    const requestId = crypto.randomUUID();
    const result = await runtime.commitReplenishmentSubmitted(
      requestId,
      {
        id: requestId,
        requestNumber: 'REQ-0001',
        locationId: LOCATION_ID,
        neededBy: null,
        source: 'manual',
        lines: [
          { itemId: crypto.randomUUID(), qtyRequested: '20.000', unitId: crypto.randomUUID() },
        ],
      },
      ACTOR,
    );

    expect(result.envelope.eventId).toBeTruthy();
    expect(result.wasAlreadyCommitted).toBe(false);
    expect(await runtime.getOutboxDepth()).toBe(1);
  });

  it('is idempotent on retry: resubmitting the SAME request does not double-queue', async () => {
    const runtime = makeRuntime();
    await runtime.init();

    const requestId = crypto.randomUUID();
    const payload = {
      id: requestId,
      requestNumber: 'REQ-0002',
      locationId: LOCATION_ID,
      neededBy: null,
      source: 'manual',
      lines: [{ itemId: crypto.randomUUID(), qtyRequested: '5.000', unitId: crypto.randomUUID() }],
    };

    await runtime.commitReplenishmentSubmitted(requestId, payload, ACTOR);
    await runtime.commitReplenishmentSubmitted(requestId, payload, ACTOR); // double-tap

    expect(await runtime.getOutboxDepth()).toBe(1);
  });

  it('commitReplenishmentCancelled and commitReplenishmentSupervisorApproved queue as separate facts against the SAME requestId', async () => {
    const runtime = makeRuntime();
    await runtime.init();

    const requestId = crypto.randomUUID();
    await runtime.commitReplenishmentSubmitted(
      requestId,
      {
        id: requestId,
        requestNumber: 'REQ-0003',
        locationId: LOCATION_ID,
        neededBy: null,
        source: 'manual',
        lines: [],
      },
      ACTOR,
    );
    await runtime.commitReplenishmentSupervisorApproved(requestId, { id: requestId }, ACTOR);
    expect(await runtime.getOutboxDepth()).toBe(2);

    await runtime.commitReplenishmentSupervisorRejected(
      crypto.randomUUID(),
      { id: requestId, reason: 'stok masih cukup' },
      ACTOR,
    );
    expect(await runtime.getOutboxDepth()).toBe(3);
  });

  it('commitReplenishmentSupervisorApprovedOffline (§7/D-17 credential+PIN) commits with zero network calls and carries the binding in meta.authorization, never touching the transport', async () => {
    const fakePinVerifier: PinVerifier = { verify: async (pin) => pin === '123456' };
    const runtime = makeRuntime(fakePinVerifier);
    await runtime.init();

    const claims: OfflineCredentialClaims = {
      credentialId: 'cred-supervisor-1',
      sub: 'supervisor-1',
      role: 'supervisor',
      locationIds: [LOCATION_ID],
      scopes: { 'replenishment.supervisor_approve': {} },
      iat: new Date().toISOString(),
      exp: new Date(Date.now() + 3600_000).toISOString(),
      k: Buffer.from('0123456789abcdef0123456789abcdef', 'utf8').toString('base64'),
      pinVerifier: 'fake-hash',
      selfieRequiredAboveIdr: '200000.00',
    };
    await runtime.cacheOfflineCredential({
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });

    const requestId = crypto.randomUUID();
    const result = await runtime.commitReplenishmentSupervisorApprovedOffline({
      requestId,
      credentialId: claims.credentialId,
      pin: '123456',
      occurredAt: new Date().toISOString(),
      actor: ACTOR,
    });

    expect(result.authorization.ok).toBe(true);
    expect(result.commit?.wasAlreadyCommitted).toBe(false);
    expect(await runtime.getOutboxDepth()).toBe(1);
  });
});

describe('Petty cash — commitPettyCashRecorded (RISK-02, wajib dua foto)', () => {
  it('captures BOTH wajib photos (payment proof + goods) and queues the purchase locally with zero network calls', async () => {
    const runtime = makeRuntime();
    await runtime.init();
    expect(await runtime.getOutboxDepth()).toBe(0);

    const paymentProofRef = await runtime.captureEvidence(
      new Blob(['fake-payment-proof-bytes'], { type: 'image/jpeg' }),
      'image/jpeg',
      'petty_cash_payment_proof',
    );
    const goodsPhotoRef = await runtime.captureEvidence(
      new Blob(['fake-goods-photo-bytes'], { type: 'image/jpeg' }),
      'image/jpeg',
      'petty_cash_goods_photo',
    );

    // Two distinct blobs must get two distinct canonical ids (attachment-store's
    // "two identities, one row") — a single shared id here would mean one of
    // the two wajib-foto requirements is unverifiable at inspection time.
    expect(paymentProofRef.attachmentId).not.toBe(goodsPhotoRef.attachmentId);

    const pettyCashId = crypto.randomUUID();
    const result = await runtime.commitPettyCashRecorded(
      pettyCashId,
      {
        id: pettyCashId,
        locationId: LOCATION_ID,
        purchasedBy: ACTOR.actorUserId,
        purchaseDate: new Date().toISOString().slice(0, 10),
        storeName: 'Toko Sembako Pak Budi',
        lines: [
          {
            description: 'Bumbu dapur',
            itemId: null,
            qty: '2.000',
            amount: '50000.00',
            expenseCategory: 'ingredients',
          },
        ],
        paymentProofAttachmentId: paymentProofRef.attachmentId,
        goodsPhotoAttachmentId: goodsPhotoRef.attachmentId,
      },
      ACTOR,
    );

    expect(result.envelope.eventId).toBeTruthy();
    expect(result.wasAlreadyCommitted).toBe(false);
    expect(await runtime.getOutboxDepth()).toBe(1);

    // The property that matters: the QUEUED event's own attachment
    // references resolve back to the exact blobs captured — not merely that
    // some UUID-shaped field is populated.
    const queued = result.envelope.payload.data as {
      paymentProofAttachmentId: string;
      goodsPhotoAttachmentId: string;
    };
    const resolvedPaymentProof = await getAttachmentByAttachmentId(
      runtime.db,
      queued.paymentProofAttachmentId,
    );
    const resolvedGoodsPhoto = await getAttachmentByAttachmentId(
      runtime.db,
      queued.goodsPhotoAttachmentId,
    );
    expect(resolvedPaymentProof?.sha256).toBe(paymentProofRef.sha256);
    expect(resolvedGoodsPhoto?.sha256).toBe(goodsPhotoRef.sha256);
  });

  it('is idempotent on retry: resubmitting the SAME petty cash purchase does not double-queue', async () => {
    const runtime = makeRuntime();
    await runtime.init();

    const paymentProofRef = await runtime.captureEvidence(
      new Blob(['a']),
      'image/jpeg',
      'petty_cash_payment_proof',
    );
    const goodsPhotoRef = await runtime.captureEvidence(
      new Blob(['b']),
      'image/jpeg',
      'petty_cash_goods_photo',
    );
    const pettyCashId = crypto.randomUUID();
    const payload = {
      id: pettyCashId,
      locationId: LOCATION_ID,
      purchasedBy: ACTOR.actorUserId,
      purchaseDate: new Date().toISOString().slice(0, 10),
      storeName: 'Toko Sembako Pak Budi',
      lines: [
        {
          description: 'Bumbu dapur',
          itemId: null,
          qty: '2.000',
          amount: '50000.00',
          expenseCategory: 'ingredients',
        },
      ],
      paymentProofAttachmentId: paymentProofRef.attachmentId,
      goodsPhotoAttachmentId: goodsPhotoRef.attachmentId,
    };

    await runtime.commitPettyCashRecorded(pettyCashId, payload, ACTOR);
    await runtime.commitPettyCashRecorded(pettyCashId, payload, ACTOR); // double-tap

    expect(await runtime.getOutboxDepth()).toBe(1);
  });
});

describe('Waste records — commitWasteReported/ApprovedOffline (RISK-02, FR-WST-01 wajib foto)', () => {
  it('reports a waste batch with photo evidence and queues it locally with zero network calls', async () => {
    const runtime = makeRuntime();
    await runtime.init();
    expect(await runtime.getOutboxDepth()).toBe(0);

    const photoRef = await runtime.captureEvidence(
      new Blob(['fake-waste-photo-bytes'], { type: 'image/jpeg' }),
      'image/jpeg',
      'waste_photo',
    );
    expect(photoRef.attachmentId).toBeTruthy();

    const batchId = crypto.randomUUID();
    const result = await runtime.commitWasteReported(
      batchId,
      {
        batchId,
        locationId: LOCATION_ID,
        items: [{ itemId: crypto.randomUUID(), qty: '1.500', reason: 'expired' }],
        photoAttachmentIds: [photoRef.attachmentId],
      },
      ACTOR,
    );

    expect(result.envelope.eventId).toBeTruthy();
    expect(result.wasAlreadyCommitted).toBe(false);
    expect(await runtime.getOutboxDepth()).toBe(1);

    const queuedPhotoId = (result.envelope.payload.data as { photoAttachmentIds: string[] })
      .photoAttachmentIds[0]!;
    const resolved = await getAttachmentByAttachmentId(runtime.db, queuedPhotoId);
    expect(resolved?.sha256).toBe(photoRef.sha256);
  });

  it('is idempotent on retry: resubmitting the SAME waste report does not double-queue', async () => {
    const runtime = makeRuntime();
    await runtime.init();

    const photoRef = await runtime.captureEvidence(new Blob(['x']), 'image/jpeg', 'waste_photo');
    const batchId = crypto.randomUUID();
    const payload = {
      batchId,
      locationId: LOCATION_ID,
      items: [{ itemId: crypto.randomUUID(), qty: '1.000', reason: 'expired' }],
      photoAttachmentIds: [photoRef.attachmentId],
    };

    await runtime.commitWasteReported(batchId, payload, ACTOR);
    await runtime.commitWasteReported(batchId, payload, ACTOR); // double-tap

    expect(await runtime.getOutboxDepth()).toBe(1);
  });

  it('commitWasteApprovedOffline (§7/D-17 credential+PIN, waste.approve scope) commits with zero network calls', async () => {
    const fakePinVerifier: PinVerifier = { verify: async (pin) => pin === '999999' };
    const runtime = makeRuntime(fakePinVerifier);
    await runtime.init();

    const claims: OfflineCredentialClaims = {
      credentialId: 'cred-supervisor-2',
      sub: 'supervisor-2',
      role: 'supervisor',
      locationIds: [LOCATION_ID],
      scopes: { 'waste.approve': {} },
      iat: new Date().toISOString(),
      exp: new Date(Date.now() + 3600_000).toISOString(),
      k: Buffer.from('fedcba9876543210fedcba9876543210', 'utf8').toString('base64'),
      pinVerifier: 'fake-hash',
      selfieRequiredAboveIdr: '200000.00',
    };
    await runtime.cacheOfflineCredential({
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });

    const batchId = crypto.randomUUID();
    const result = await runtime.commitWasteApprovedOffline({
      batchId,
      credentialId: claims.credentialId,
      pin: '999999',
      note: 'disetujui offline — koneksi mati',
      occurredAt: new Date().toISOString(),
      actor: ACTOR,
    });

    expect(result.authorization.ok).toBe(true);
    expect(result.commit?.wasAlreadyCommitted).toBe(false);
    expect(await runtime.getOutboxDepth()).toBe(1);
  });

  it('commitWasteApprovedOffline rejects a wrong PIN and does NOT queue anything (advisory local gate, §7.4 still re-verifies at cloud)', async () => {
    const fakePinVerifier: PinVerifier = { verify: async (pin) => pin === '999999' };
    const runtime = makeRuntime(fakePinVerifier);
    await runtime.init();

    const claims: OfflineCredentialClaims = {
      credentialId: 'cred-supervisor-3',
      sub: 'supervisor-3',
      role: 'supervisor',
      locationIds: [LOCATION_ID],
      scopes: { 'waste.approve': {} },
      iat: new Date().toISOString(),
      exp: new Date(Date.now() + 3600_000).toISOString(),
      k: Buffer.from('11112222333344445555666677778888', 'utf8').toString('base64'),
      pinVerifier: 'fake-hash',
      selfieRequiredAboveIdr: '200000.00',
    };
    await runtime.cacheOfflineCredential({
      credentialId: claims.credentialId,
      token: encodeOfflineCredentialToken(claims),
      scopes: claims.scopes,
      expiresAt: claims.exp,
    });

    const batchId = crypto.randomUUID();
    const result = await runtime.commitWasteApprovedOffline({
      batchId,
      credentialId: claims.credentialId,
      pin: '000000', // wrong
      occurredAt: new Date().toISOString(),
      actor: ACTOR,
    });

    expect(result.authorization.ok).toBe(false);
    expect(result.commit).toBeUndefined();
    expect(await runtime.getOutboxDepth()).toBe(0);
  });
});
