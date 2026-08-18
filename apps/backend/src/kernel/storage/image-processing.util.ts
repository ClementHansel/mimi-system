import sharp from 'sharp';
import { createHash } from 'node:crypto';

const MAX_DIMENSION_PX = 1920;
const JPEG_QUALITY = 80;

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
