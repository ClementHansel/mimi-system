/**
 * Presign → PUT → confirm attachment upload (CONTRACTS.md §4.0 kernel
 * endpoints) — the payment-proof evidence flow FR-ACCT-01 needs. Mirrors
 * `components/outlet/lib/attachments.ts`'s helper (same three-step dance);
 * kept as its own copy here rather than a cross-module import so F07 stays
 * self-contained within `components/finance/**`.
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
  /** 'payment_proof' — the only kind this module's evidence upload needs. */
  kind: string;
  entityType?: string;
  entityId?: string;
}

/** Returns the confirmed attachment's UUID, ready to embed in a payment mutation body. */
export async function uploadAttachment(args: UploadAttachmentArgs): Promise<string> {
  const presign = await api.post<{
    attachmentId: string;
    uploadUrl: string;
    objectKey: string;
    expiresAt: string;
  }>('/attachments/presign', {
    fileName: args.fileName,
    mimeType: args.mimeType,
    sizeBytes: args.file.size,
    kind: args.kind,
    entityType: args.entityType,
    entityId: args.entityId,
  });

  const target = /^https?:\/\//i.test(presign.uploadUrl)
    ? presign.uploadUrl
    : `${API_BASE_URL}${presign.uploadUrl.startsWith('/') ? '' : '/'}${presign.uploadUrl}`;
  const putRes = await fetch(target, {
    method: 'PUT',
    body: args.file,
    headers: { 'Content-Type': args.mimeType },
  });
  if (!putRes.ok) throw new Error(`Upload gagal (${putRes.status})`);

  const sha256 = await sha256Hex(args.file);
  await api.post(`/attachments/${presign.attachmentId}/confirm`, { sha256 });

  return presign.attachmentId;
}
