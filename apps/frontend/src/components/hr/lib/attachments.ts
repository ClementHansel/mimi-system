/**
 * Presign → PUT → confirm attachment upload, for HR's leave-request evidence
 * (a doctor's note for `sick`, a wedding invitation for `marriage`).
 *
 * WHY A SEVENTH COPY. `admin`, `assets`, `finance`, `outlet`, `purchasing` and
 * `warehouse` each keep their own copy of this three-step dance, deliberately,
 * so each feature area stays self-contained (see the note atop `finance`'s).
 * This follows that convention rather than quietly breaking it from the one
 * module that happens to need it next. It is worth saying plainly, though,
 * that the six existing copies have already DIVERGED — they run from 55 to 105
 * lines and no two are identical — so the convention is buying isolation at
 * the price of six places to fix a bug in an upload path. The download half
 * went the other way and lives in one shared `lib/attachment-url.ts`.
 */
import { api, API_BASE_URL } from '@/lib/api';

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface UploadLeaveAttachmentArgs {
  file: File;
  /**
   * Deliberately NOT bound to an entity here. A leave request does not exist
   * yet while its author is filling the form — the attachment id is what gets
   * posted WITH the request — so binding an `entityId` is impossible at this
   * point, and inventing one would be worse than leaving it unset.
   */
  kind: 'leave_attachment';
}

/** Returns the confirmed attachment's UUID, ready to send as `attachmentId`. */
export async function uploadLeaveAttachment(args: UploadLeaveAttachmentArgs): Promise<string> {
  const presign = await api.post<{
    attachmentId: string;
    uploadUrl: string;
    objectKey: string;
    expiresAt: string;
  }>('/attachments/presign', {
    fileName: args.file.name,
    mimeType: args.file.type,
    sizeBytes: args.file.size,
    kind: args.kind,
  });

  const target = /^https?:\/\//i.test(presign.uploadUrl)
    ? presign.uploadUrl
    : `${API_BASE_URL}${presign.uploadUrl.startsWith('/') ? '' : '/'}${presign.uploadUrl}`;
  const putRes = await fetch(target, {
    method: 'PUT',
    body: args.file,
    headers: { 'Content-Type': args.file.type },
  });
  if (!putRes.ok) throw new Error(`Upload gagal (${putRes.status})`);

  // The server recomputes this and rejects a mismatch, which is what makes the
  // confirm step meaningful rather than ceremonial.
  const sha256 = await sha256Hex(args.file);
  await api.post(`/attachments/${presign.attachmentId}/confirm`, { sha256 });

  return presign.attachmentId;
}
