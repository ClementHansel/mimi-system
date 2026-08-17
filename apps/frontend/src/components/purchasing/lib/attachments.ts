/**
 * Presign -> PUT -> confirm attachment upload (CONTRACTS.md §4.0 kernel
 * endpoints) — the PO receiving photo evidence flow (FR-PO-04, wajib foto)
 * needs. Mirrors `components/finance/lib/attachments.ts`'s helper (same
 * three-step dance); kept as its own copy here rather than a cross-module
 * import so `components/purchasing` stays self-contained, matching the
 * ownership split every other module in this codebase uses.
 *
 * `PurchaseOrderService.receive()` binds each uploaded attachment to the
 * new `po_receipt` row itself (`UPDATE attachments SET entity_type =
 * 'po_receipt', entity_id = $receiptId WHERE id = $1 AND entity_id IS NULL`)
 * — the caller never knows the receipt id in advance, so this upload never
 * passes `entityType`/`entityId`; only the confirmed `attachmentId` is sent
 * in `POST /purchasing/orders/:id/receipts`'s `photoAttachmentIds`.
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
  kind: string;
}

/** Returns the confirmed attachment's UUID, ready to embed in a PO receipt body. */
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
