/**
 * Presign → PUT → confirm attachment upload (CONTRACTS.md §4.0 kernel
 * endpoints) — the asset photo and maintenance-job proof photo both go
 * through this. Same three-step dance `components/outlet/lib/attachments.ts`
 * defines, kept as its own copy so `components/assets` stays self-contained
 * (see that file's doc comment for why every Wave 4 surface owns this
 * locally rather than sharing one copy).
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
  /** e.g. 'asset_photo', 'maintenance_proof'. */
  kind: string;
}

/** Returns the confirmed attachment's UUID, ready to embed in a mutation body. */
export async function uploadAttachment(args: UploadAttachmentArgs): Promise<string> {
  const presign = await api.post<{ attachmentId: string; uploadUrl: string; objectKey: string; expiresAt: string }>(
    '/attachments/presign',
    { fileName: args.fileName, mimeType: args.mimeType, sizeBytes: args.file.size, kind: args.kind },
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
