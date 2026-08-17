/**
 * Presign → PUT → confirm attachment upload (CONTRACTS.md §4.0 kernel
 * endpoints). Every "wajib foto" field on this surface (PO receipt photo,
 * retur bukti foto) goes through this helper. Deliberately NOT imported from
 * `components/outlet/lib/attachments.ts` — this surface owns its own copy
 * rather than reaching into W4-07's owned directory, matching the
 * ticket's per-surface ownership split; the two files are near-identical
 * because both transcribe the same kernel endpoints, not because of a
 * dependency between them.
 */
import { api, API_BASE_URL } from '@/lib/api';

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface UploadAttachmentArgs {
  file: File | Blob;
  fileName: string;
  mimeType: string;
  /** e.g. 'po_receipt_photo', 'return_proof'. */
  kind: string;
  entityType?: string;
  entityId?: string;
}

/** Returns the confirmed attachment's UUID, ready to embed in a mutation body. */
export async function uploadAttachment(args: UploadAttachmentArgs): Promise<string> {
  const presign = await api.post<{ attachmentId: string; uploadUrl: string; objectKey: string; expiresAt: string }>(
    '/attachments/presign',
    {
      fileName: args.fileName,
      mimeType: args.mimeType,
      sizeBytes: args.file.size,
      kind: args.kind,
      entityType: args.entityType,
      entityId: args.entityId,
    },
  );

  const target = /^https?:\/\//i.test(presign.uploadUrl)
    ? presign.uploadUrl
    : `${API_BASE_URL}${presign.uploadUrl.startsWith('/') ? '' : '/'}${presign.uploadUrl}`;
  const putRes = await fetch(target, { method: 'PUT', body: args.file, headers: { 'Content-Type': args.mimeType } });
  if (!putRes.ok) throw new Error(`Upload gagal (${putRes.status})`);

  const sha256 = await sha256Hex(args.file);
  await api.post(`/attachments/${presign.attachmentId}/confirm`, { sha256 });

  return presign.attachmentId;
}
