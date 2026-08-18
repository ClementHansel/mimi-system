/**
 * Presign → PUT → confirm attachment upload (CONTRACTS.md §4.0 kernel
 * endpoints) — the selfie capture on Absen (FR-HR-01 "wajib foto"). Same
 * three-step dance as `components/outlet/lib/attachments.ts`; kept as its
 * own copy in `components/me` rather than a cross-surface import so F11
 * stays self-contained within this ticket's owned paths.
 */
import { api, API_BASE_URL } from '@/lib/api';

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Returns the confirmed attachment's UUID, ready to embed in a check-in/out body. */
export async function uploadSelfie(file: File): Promise<string> {
  const presign = await api.post<{
    attachmentId: string;
    uploadUrl: string;
    objectKey: string;
    expiresAt: string;
  }>('/attachments/presign', {
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    kind: 'selfie',
  });

  const target = /^https?:\/\//i.test(presign.uploadUrl)
    ? presign.uploadUrl
    : `${API_BASE_URL}${presign.uploadUrl.startsWith('/') ? '' : '/'}${presign.uploadUrl}`;
  const putRes = await fetch(target, {
    method: 'PUT',
    body: file,
    headers: { 'Content-Type': file.type },
  });
  if (!putRes.ok) throw new Error(`Upload gagal (${putRes.status})`);

  const sha256 = await sha256Hex(file);
  await api.post(`/attachments/${presign.attachmentId}/confirm`, { sha256 });

  return presign.attachmentId;
}
