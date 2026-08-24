import { api, API_BASE_URL } from '@/lib/api';

/**
 * `SignaturePad`'s canvas data URL → `File`, for `captureEvidence`. Same
 * small helper `components/outlet/lib/attachments.ts` defines — kept as its
 * own copy here rather than a cross-surface import so `components/driver`
 * stays self-contained (every Wave 4 surface owns its own thin lib, per the
 * pattern `outlet`/`pos` already established).
 */
export function dataUrlToFile(dataUrl: string, fileName = 'signature.png'): File {
  const [header, base64] = dataUrl.split(',');
  const mime = /data:(.*?);base64/.exec(header ?? '')?.[1] ?? 'image/png';
  const binary = atob(base64 ?? '');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mime });
}

/**
 * `attachments.kind` for the photo on a FAILED drop. Must match the string
 * `DropService.fail` asserts, or the upload succeeds and the fail is rejected.
 */
export const DELIVERY_FAILURE_KIND = 'delivery_failure';

/**
 * Presign -> PUT -> confirm, returning a real attachment UUID.
 *
 * Deliberately NOT `LocalRuntime.captureEvidence`, which every other driver
 * action uses. `captureEvidence` queues the file offline and hands back a
 * client-minted ref that becomes a real row only once sync drains — perfect for
 * `receive`, which is queued too, and useless here: `fail` is an online call and
 * the server checks the attachment exists before it will accept it. Passing a
 * ref that has not synced yet would fail the drop's own validation.
 */
export async function uploadFailurePhoto(file: File): Promise<string> {
  const presign = await api.post<{
    attachmentId: string;
    uploadUrl: string;
    objectKey: string;
    expiresAt: string;
  }>('/attachments/presign', {
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    kind: DELIVERY_FAILURE_KIND,
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

  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  const sha256 = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  await api.post(`/attachments/${presign.attachmentId}/confirm`, { sha256 });

  return presign.attachmentId;
}
