/**
 * Presign → PUT → confirm attachment upload (CONTRACTS.md §4.0 kernel
 * endpoints). Every "wajib foto"/signature field on this surface (receiving
 * photo + signature, opname is photo-free, waste photo, return proof,
 * petty-cash payment proof + goods photo) goes through this one helper so the
 * three-step dance lives in exactly one place.
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
  /** e.g. 'receiving_photo', 'receiving_signature', 'waste_photo', 'return_proof', 'payment_proof', 'petty_cash_photo'. */
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

  // `uploadUrl` is a presigned MinIO PUT URL — an absolute URL to object
  // storage, not one of our own API routes, so this bypasses `apiFetch`
  // (no bearer token, no base-URL prefixing) and goes straight through
  // `fetch`. Falls back to routing through our own API base if the backend
  // ever returns a relative path instead.
  const target = /^https?:\/\//i.test(presign.uploadUrl)
    ? presign.uploadUrl
    : `${API_BASE_URL}${presign.uploadUrl.startsWith('/') ? '' : '/'}${presign.uploadUrl}`;
  const putRes = await fetch(target, { method: 'PUT', body: args.file, headers: { 'Content-Type': args.mimeType } });
  if (!putRes.ok) throw new Error(`Upload gagal (${putRes.status})`);

  const sha256 = await sha256Hex(args.file);
  await api.post(`/attachments/${presign.attachmentId}/confirm`, { sha256 });

  return presign.attachmentId;
}

/** Turns a signature `<canvas>` data URL (from `SignaturePad`) into a `File` for `uploadAttachment`. */
export function dataUrlToFile(dataUrl: string, fileName = 'signature.png'): File {
  const [header, base64] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(header ?? '')?.[1] ?? 'image/png';
  const binary = atob(base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mime });
}
