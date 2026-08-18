import { describe, expect, it } from 'vitest';
import { createTestDatabase } from '../test-support/fixtures';
import {
  captureAttachment,
  sha256Hex,
  AttachmentCapExceededError,
  drainAttachmentUploads,
  type AttachmentUploader,
} from './attachment-store';
import type { AttachmentRecord } from '../types';

function blobOf(content: string, mime = 'image/jpeg'): Blob {
  return new Blob([content], { type: mime });
}

describe('attachment-store (SYNC-PROTOCOL §4.7 side-channel)', () => {
  it('captures a blob keyed by its sha256 content hash', async () => {
    const db = createTestDatabase();
    const ref = await captureAttachment(db, blobOf('photo-bytes-1'), 'image/jpeg', 'sj_drop_photo');
    expect(ref.sha256).toBe(await sha256Hex(blobOf('photo-bytes-1')));
    expect(ref.size).toBeGreaterThan(0);
  });

  it('re-capturing the SAME content is a no-op (§4.7 rule 3: same-sha256 re-upload is a no-op)', async () => {
    const db = createTestDatabase();
    await captureAttachment(db, blobOf('same'), 'image/jpeg', 'waste_photo');
    await captureAttachment(db, blobOf('same'), 'image/jpeg', 'waste_photo');
    const all = await db.store<AttachmentRecord>('attachments').getAll();
    expect(all).toHaveLength(1);
  });

  it('different content produces different hashes and both are kept', async () => {
    const db = createTestDatabase();
    await captureAttachment(db, blobOf('a'), 'image/jpeg', 'k');
    await captureAttachment(db, blobOf('b'), 'image/jpeg', 'k');
    const all = await db.store<AttachmentRecord>('attachments').getAll();
    expect(all).toHaveLength(2);
  });

  it('T-09: blocks with a distinguished error when the count cap is reached and nothing uploaded is evictable', async () => {
    const db = createTestDatabase();
    // Fill past the (test-scale) count cap with distinct PENDING (never-uploaded) blobs.
    for (let i = 0; i < 500; i++) {
      await captureAttachment(db, blobOf(`content-${i}`), 'image/jpeg', 'k');
    }
    await expect(captureAttachment(db, blobOf('overflow'), 'image/jpeg', 'k')).rejects.toThrow(
      AttachmentCapExceededError,
    );
  });

  it('evicts oldest UPLOADED (cloud-confirmed) blobs to make room, but never evicts a still-pending one', async () => {
    const db = createTestDatabase();
    const first = await captureAttachment(db, blobOf('first'), 'image/jpeg', 'k');
    // Mark it uploaded (simulating a completed binary-outbox drain).
    const store = db.store<AttachmentRecord>('attachments');
    const rec = await store.get(first.sha256);
    await store.put({ ...rec!, uploadStatus: 'uploaded', uploadedAt: new Date(0).toISOString() });

    for (let i = 0; i < 499; i++) {
      await captureAttachment(db, blobOf(`content-${i}`), 'image/jpeg', 'k');
    }
    // At the count cap (500 blobs total: 1 uploaded + 499 pending). Adding one more must evict the uploaded one.
    await captureAttachment(db, blobOf('new-evidence'), 'image/jpeg', 'k');

    expect(await store.get(first.sha256)).toBeUndefined(); // evicted
    const all = await store.getAll();
    expect(all.every((a) => a.uploadStatus === 'pending')).toBe(true); // every remaining row is still pending evidence
  });

  it('drainAttachmentUploads marks successfully uploaded blobs and leaves failures pending for the next drain', async () => {
    const db = createTestDatabase();
    await captureAttachment(db, blobOf('ok'), 'image/jpeg', 'k');
    await captureAttachment(db, blobOf('fails'), 'image/jpeg', 'k');

    const okHash = await sha256Hex(blobOf('ok'));
    const uploader: AttachmentUploader = {
      upload: async (sha256) => {
        if (sha256 !== okHash) throw new Error('network down');
      },
    };

    const result = await drainAttachmentUploads(db, uploader);
    expect(result).toEqual({ uploaded: 1, failed: 1 });

    const rows = await db.store<AttachmentRecord>('attachments').getAll();
    const ok = rows.find((r) => r.sha256 === okHash)!;
    const failed = rows.find((r) => r.sha256 !== okHash)!;
    expect(ok.uploadStatus).toBe('uploaded');
    expect(failed.uploadStatus).toBe('pending');
  });
});
