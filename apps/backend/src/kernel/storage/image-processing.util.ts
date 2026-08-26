import sharp from 'sharp';
import { createHash } from 'node:crypto';

const MAX_DIMENSION_PX = 1920;
const JPEG_QUALITY = 80;
const THUMBNAIL_WEBP_QUALITY = 75;

export interface ProcessedImage {
  buffer: Buffer;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/** MIME types this pipeline knows how to compress. Everything else (PDF, etc.) passes through untouched. */
const PROCESSABLE_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export function isProcessableImage(mimeType: string): boolean {
  return PROCESSABLE_MIME_TYPES.has(mimeType.toLowerCase());
}

/**
 * Compresses a photo and strips its metadata (EXIF/ICC/XMP) — backs every
 * *wajib foto* flow (receiving, waste, petty cash, payment proof, absensi
 * selfie, servis, Surat Jalan drops; CONTRACTS.md §0).
 *
 * WHY THIS STRIPS EXIF: sharp() strips ALL metadata by default — EXIF, ICC
 * profile, XMP — UNLESS `.withMetadata()` is explicitly called, which this
 * pipeline deliberately never does. GPS location, device model/serial, and
 * capture timestamp embedded by a phone's camera app have no legitimate
 * reason to leave the building in a stored object a wide set of roles can
 * later fetch a presigned URL for (e.g. a driver's phone GPS baked into a
 * cold-chain photo is a data-minimisation concern the PRD never asked this
 * system to collect that way). Orientation is corrected via `.rotate()`
 * BEFORE metadata is dropped (sharp reads the EXIF `Orientation` tag to
 * un-rotate pixels physically), so a photo taken sideways still displays
 * upright despite carrying no EXIF afterward.
 *
 * Compression: resized to fit within 1920×1920 (no upscaling — camera
 * photos are always larger than this; a photo already smaller is
 * untouched) and re-encoded as JPEG quality 80 — more than sufficient for
 * evidentiary photos (proof of delivery, waste, cold-chain), while keeping
 * MinIO storage and mobile upload bandwidth bounded (NFR-09, RISK-S5's 200MB
 * device binary cap).
 */
export async function compressAndStripExif(input: Buffer): Promise<ProcessedImage> {
  const buffer = await sharp(input)
    .rotate()
    .resize({
      width: MAX_DIMENSION_PX,
      height: MAX_DIMENSION_PX,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();

  return {
    buffer,
    mimeType: 'image/jpeg',
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * A small, square-fitting WebP derivative for the POS product grid.
 *
 * WHY A SEPARATE DERIVATIVE and not just `compressAndStripExif`'s output: the
 * till PRECACHES every menu photo into IndexedDB so a tile still renders on a
 * dead link (the catalog is offline-first, D-25). At 1920px/JPEG-80 a photo is
 * ~150-250KB, so a 100-product menu is 15-25MB of device storage against
 * RISK-S5's 200MB binary cap — for images displayed in a ~160px tile. At 320px
 * WebP-75 the same menu is ~2MB.
 *
 * `fit: 'cover'` (not `'inside'`) because a menu grid of uniform square tiles
 * looks broken with mixed aspect ratios, and cropping to the centre of a food
 * photo is the safe crop. Metadata is stripped here for the same reason
 * `compressAndStripExif` strips it — sharp drops it unless asked not to.
 */
export async function makeThumbnail(input: Buffer, maxPx: number): Promise<ProcessedImage> {
  const buffer = await sharp(input)
    .rotate()
    .resize({ width: maxPx, height: maxPx, fit: 'cover', withoutEnlargement: true })
    .webp({ quality: THUMBNAIL_WEBP_QUALITY })
    .toBuffer();

  return {
    buffer,
    mimeType: 'image/webp',
    sizeBytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  };
}
