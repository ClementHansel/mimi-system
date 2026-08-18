import { describe, expect, it } from 'vitest';
import { SyncEntity } from '@mimi/shared';
import { createTestDatabase, setupIdentity, ACTOR } from '../test-support/fixtures';
import { commitFact } from '../idempotent-commit';
import {
  captureAttachment,
  getAttachmentByAttachmentId,
  drainAttachmentUploads,
  sha256Hex,
  type AttachmentUploader,
} from './attachment-store';
import type { AttachmentRecord } from '../types';

function blobOf(content: string, mime = 'image/jpeg'): Blob {
  return new Blob([content], { type: mime });
}

/**
 * The regression this coordinator round asked for: not "an attachment
 * exists and an event exists" (both would pass even with the correlation
 * bug — a device mints an arbitrary UUID to satisfy the payload shape and
 * nothing checks it means anything), but that the id an event ACTUALLY
 * carries resolves back to the SAME blob that was captured, end to end
 * through the upload path (FR-LOG-15 wajib foto — the anti-fraud checkpoint
 * an offline goods receipt depends on).
 */
describe('attachment <-> event correlation (FR-LOG-15 wajib foto, found wiring outlet receiving)', () => {
  it('captureAttachment mints an attachmentId distinct from the sha256 dedupe key', async () => {
    const db = createTestDatabase();
    const ref = await captureAttachment(db, blobOf('drop-photo-1'), 'image/jpeg', 'sj_drop_photo');
    expect(ref.attachmentId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(ref.attachmentId).not.toBe(ref.sha256);
  });

  it('capturing the SAME content twice returns the SAME attachmentId (one blob, one canonical id)', async () => {
    const db = createTestDatabase();
    const first = await captureAttachment(
      db,
      blobOf('same-evidence'),
      'image/jpeg',
      'sj_drop_photo',
    );
    const second = await captureAttachment(
      db,
      blobOf('same-evidence'),
      'image/jpeg',
      'sj_drop_photo',
    );
    expect(second.attachmentId).toBe(first.attachmentId);
  });

  it('the id referenced by a committed sj_drops.received event resolves back to the ACTUAL stored blob (not merely: both exist)', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);

    const blob = blobOf('goods-receipt-photo-bytes');
    const evidence = await captureAttachment(db, blob, 'image/jpeg', 'sj_drop_photo');

    // The exact wire shape from packages/sync-protocol/src/schema/registry.ts:
    // 'sj_drops.received': { dropId, lines, photoAttachmentIds: array(uuid()), signatureAttachmentId: uuid(), ... }
    const { envelope } = await commitFact(db, {
      entity: SyncEntity.SJ_DROPS,
      op: 'received',
      entityId: 'drop-1',
      data: {
        dropId: 'drop-1',
        lines: [],
        photoAttachmentIds: [evidence.attachmentId],
        signatureAttachmentId: evidence.attachmentId,
      },
      meta: ACTOR,
    });

    const referencedId = (envelope.payload.data as { photoAttachmentIds: string[] })
      .photoAttachmentIds[0]!;
    const resolved = await getAttachmentByAttachmentId(db, referencedId);

    expect(resolved).toBeDefined();
    // The actual regression guard: the BLOB behind the referenced id is byte-identical to what was captured —
    // proven via its content hash, not merely "a row with this id happens to exist".
    expect(resolved!.sha256).toBe(await sha256Hex(blob));
    expect(resolved!.sha256).toBe(evidence.sha256);
  });

  it('an attachmentId that was never captured resolves to nothing (the failure mode this closes: an event claiming evidence that cannot be produced)', async () => {
    const db = createTestDatabase();
    const resolved = await getAttachmentByAttachmentId(db, '00000000-0000-4000-8000-000000000000');
    expect(resolved).toBeUndefined();
  });

  it('the correlation survives the upload path: the uploader receives the SAME attachmentId the event referenced, and it is unchanged after upload', async () => {
    const db = createTestDatabase();
    await setupIdentity(db);

    const blob = blobOf('goods-receipt-photo-for-upload');
    const evidence = await captureAttachment(db, blob, 'image/jpeg', 'sj_drop_photo');

    const { envelope } = await commitFact(db, {
      entity: SyncEntity.SJ_DROPS,
      op: 'received',
      entityId: 'drop-2',
      data: {
        dropId: 'drop-2',
        lines: [],
        photoAttachmentIds: [evidence.attachmentId],
        signatureAttachmentId: evidence.attachmentId,
      },
      meta: ACTOR,
    });
    const referencedId = (envelope.payload.data as { photoAttachmentIds: string[] })
      .photoAttachmentIds[0]!;

    const uploadCalls: { sha256: string; attachmentId: string }[] = [];
    const spyUploader: AttachmentUploader = {
      async upload(sha256, attachmentId) {
        uploadCalls.push({ sha256, attachmentId });
      },
    };

    const result = await drainAttachmentUploads(db, spyUploader);

    expect(result).toEqual({ uploaded: 1, failed: 0 });
    expect(uploadCalls).toEqual([{ sha256: evidence.sha256, attachmentId: referencedId }]);

    // Post-upload, the id is still intact and still resolves — surviving the uploadStatus transition.
    const afterUpload = await getAttachmentByAttachmentId(db, referencedId);
    expect(afterUpload?.attachmentId).toBe(referencedId);
    expect(afterUpload?.uploadStatus).toBe('uploaded');
  });

  it('drainAttachmentUploads leaves attachmentId untouched across a failed upload attempt too', async () => {
    const db = createTestDatabase();
    const evidence = await captureAttachment(db, blobOf('will-fail'), 'image/jpeg', 'k');
    const failingUploader: AttachmentUploader = {
      async upload() {
        throw new Error('network down');
      },
    };

    await drainAttachmentUploads(db, failingUploader);

    const row = await db.store<AttachmentRecord>('attachments').get(evidence.sha256);
    expect(row?.attachmentId).toBe(evidence.attachmentId);
    expect(row?.uploadStatus).toBe('pending');
  });
});
