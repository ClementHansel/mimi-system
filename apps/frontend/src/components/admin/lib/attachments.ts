/**
 * Presign -> PUT -> confirm attachment upload (CONTRACTS.md §4.0 kernel
 * endpoints) for everything `components/admin` uploads: the MENU PRODUCT PHOTO
 * in Master Data, and (F-DOC, 2026-08-27) the BRAND LOGO, the FAVICON and a
 * document template's BACKGROUND letterhead.
 *
 * Same three-step dance as `components/purchasing/lib/attachments.ts` and its
 * siblings, kept as this module's own copy rather than a cross-module import so
 * `components/admin` stays self-contained — the ownership split every other
 * module here follows.
 *
 * F-DOC ADDED THREE CALLERS, NOT A NINTH COPY. The brief for the document
 * designers said to find the existing uploader and reuse it rather than write a
 * second one. There are eight module-local copies of this dance in the repo, so
 * "the existing uploader" for anything mounted under Admin is THIS file — the
 * generic `uploadAttachment(file, kind)` below was extracted from
 * `uploadProductPhoto`, which now calls it. `components/documents` (the
 * designer) imports from here rather than growing a ninth copy, which is a
 * dependency on `components/admin` and an honest one: the designer is mounted
 * from exactly one place, Admin → Dokumen.
 *
 * WHAT IS DIFFERENT ABOUT A PRODUCT PHOTO: every other caller uploads EVIDENCE
 * (a receiving photo, a payment proof) that gets bound to a document the server
 * creates. This one uploads a piece of MASTER DATA, so the confirmed
 * `attachmentId` goes straight into `PATCH/POST /products` as
 * `photoAttachmentId` and the product row is what owns it. It also carries no
 * `locationId`: a menu photo belongs to the menu, not to one outlet, which is
 * what keeps `StorageService`'s entity-scope check from hiding it from outlet
 * roles (see that check's doc — an attachment with no `location_id` is visible
 * to anyone authenticated, which is correct for a photo the till must render).
 */
import { api, API_BASE_URL } from '@/lib/api';

/** `attachments.kind` for a menu product photo — the discriminator storage groups objects by. */
export const PRODUCT_PHOTO_KIND = 'product_photo';

/**
 * F-DOC kinds. Three separate discriminators rather than one `brand` bucket
 * because storage groups objects by kind into its own key prefix
 * (`StorageService.buildObjectKey`), and these three have genuinely different
 * lifecycles: a logo is replaced rarely and read by every printed document, a
 * favicon is read by every page load, and a template background belongs to one
 * template and is orphaned the moment that template is reset to default.
 */
export const BRAND_LOGO_KIND = 'brand_logo';
export const BRAND_FAVICON_KIND = 'brand_favicon';
export const DOC_BACKGROUND_KIND = 'doc_background';

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * The three-step upload, for any `kind`. Returns the confirmed attachment's
 * UUID.
 *
 * Carries NO `locationId`, deliberately, for every kind that uses it: a menu
 * photo belongs to the menu, a logo and a favicon belong to the company, and a
 * letterhead belongs to a template — none of them to one outlet. That is what
 * keeps `StorageService`'s entity-scope check from hiding them from outlet
 * roles (an attachment with no `location_id` is visible to anyone
 * authenticated, which is correct for an image the till has to render on a
 * receipt).
 */
export async function uploadAttachment(file: File, kind: string): Promise<string> {
  const presign = await api.post<{
    attachmentId: string;
    uploadUrl: string;
    objectKey: string;
    expiresAt: string;
  }>('/attachments/presign', {
    fileName: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    kind,
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

  // The server RE-ENCODES an image on confirm (compress + strip EXIF), so the
  // hash it stores is of the PROCESSED bytes, not these. This one is sent as
  // the integrity hint `confirm` accepts for the upload leg — it is not
  // expected to match what ends up in `attachments.sha256`.
  const sha256 = await sha256Hex(file);
  await api.post(`/attachments/${presign.attachmentId}/confirm`, { sha256 });

  return presign.attachmentId;
}

/** Returns the confirmed attachment's UUID, ready to send as `photoAttachmentId`. */
export async function uploadProductPhoto(file: File): Promise<string> {
  return uploadAttachment(file, PRODUCT_PHOTO_KIND);
}
