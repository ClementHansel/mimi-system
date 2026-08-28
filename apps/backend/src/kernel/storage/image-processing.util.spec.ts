import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import {
  compressAndStripExif,
  isProcessableImage,
  makeThumbnail,
  sha256Hex,
} from './image-processing.util';

/** Builds a real JPEG buffer carrying real EXIF metadata (GPS + camera model), for the strip proof below. */
async function makeJpegWithExif(): Promise<Buffer> {
  return sharp({
    create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 50, b: 50 } },
  })
    .jpeg()
    .withExif({
      IFD0: {
        Make: 'TestPhone',
        Model: 'TestPhone Model X',
        Software: 'mimi-chicken-e2e',
      },
      // sharp's `WriteableExif` type omits the GPS IFD, but sharp itself
      // writes it — and GPS is precisely the tag group
      // `compressAndStripExif` exists to remove, so the fixture must
      // carry it. Cast at the boundary, not on the whole object.
      GPS: {
        GPSLatitude: '1/1, 30/1, 0/1',
        GPSLongitude: '116/1, 50/1, 0/1',
      },
    } as Parameters<sharp.Sharp['withExif']>[0])
    .toBuffer();
}

describe('isProcessableImage', () => {
  it('recognizes common photo mime types', () => {
    expect(isProcessableImage('image/jpeg')).toBe(true);
    expect(isProcessableImage('image/png')).toBe(true);
    expect(isProcessableImage('IMAGE/JPEG')).toBe(true);
  });

  it('rejects non-image mime types (e.g. generated PDFs) so they pass through untouched', () => {
    expect(isProcessableImage('application/pdf')).toBe(false);
  });
});

describe('compressAndStripExif', () => {
  it('strips EXIF metadata that was genuinely present on the input', async () => {
    const input = await makeJpegWithExif();

    // Prove the fixture actually carries EXIF before we touch it — otherwise
    // a passing assertion below would be vacuous.
    const inputMeta = await sharp(input).metadata();
    expect(inputMeta.exif).toBeDefined();
    expect(inputMeta.exif!.length).toBeGreaterThan(0);

    const result = await compressAndStripExif(input);

    const outputMeta = await sharp(result.buffer).metadata();
    expect(outputMeta.exif).toBeUndefined();
    expect(outputMeta.icc).toBeUndefined();
    expect(outputMeta.xmp).toBeUndefined();
  });

  it('compresses a large photo below its original size', async () => {
    const input = await makeJpegWithExif();
    const result = await compressAndStripExif(input);

    expect(result.sizeBytes).toBeLessThan(input.length);
    expect(result.buffer.length).toBe(result.sizeBytes);
  });

  it('resizes to fit within the 1920px bound without upscaling smaller images', async () => {
    const large = await makeJpegWithExif(); // 3000x2000
    const largeResult = await compressAndStripExif(large);
    const largeMeta = await sharp(largeResult.buffer).metadata();
    expect(largeMeta.width).toBeLessThanOrEqual(1920);
    expect(largeMeta.height).toBeLessThanOrEqual(1920);

    const small = await sharp({
      create: { width: 200, height: 100, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();
    const smallResult = await compressAndStripExif(small);
    const smallMeta = await sharp(smallResult.buffer).metadata();
    expect(smallMeta.width).toBe(200);
    expect(smallMeta.height).toBe(100);
  });

  it('re-encodes to JPEG regardless of input format', async () => {
    const png = await sharp({
      create: {
        width: 100,
        height: 100,
        channels: 4,
        background: { r: 0, g: 255, b: 0, alpha: 1 },
      },
    })
      .png()
      .toBuffer();
    const result = await compressAndStripExif(png);
    expect(result.mimeType).toBe('image/jpeg');
    const meta = await sharp(result.buffer).metadata();
    expect(meta.format).toBe('jpeg');
  });

  it('returns a sha256 that matches the returned buffer', async () => {
    const input = await makeJpegWithExif();
    const result = await compressAndStripExif(input);
    expect(result.sha256).toBe(sha256Hex(result.buffer));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('makeThumbnail — the POS offline photo cache budget', () => {
  it('produces a square WebP at the requested size, cover-cropped from any aspect ratio', async () => {
    // 2400x1600 stands in for a phone photo: a 4:3 crop of a 3:2 source is the
    // case that would letterbox if `fit` were `inside` rather than `cover`, and a
    // menu grid of uniform tiles looks broken with mixed aspect ratios.
    const wide = await sharp({
      create: { width: 2400, height: 1600, channels: 3, background: { r: 200, g: 120, b: 40 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const thumb = await makeThumbnail(wide, 320);
    const meta = await sharp(thumb.buffer).metadata();

    expect(thumb.mimeType).toBe('image/webp');
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(320);
    expect(meta.height).toBe(320);
  });

  it('is small enough that a whole menu fits in a tablet cache — the reason it exists at all', async () => {
    // The till PRECACHES every menu photo so a tile still renders on a dead
    // link. This asserts the budget that decision rests on: at ~25KB a photo, a
    // 100-product menu is ~2.5MB, against RISK-S5's 200MB device cap. Serving
    // the stored 1920px original instead would be 15-25MB for images displayed
    // in a 160px tile. The bound is deliberately loose (60KB) — it is a
    // regression guard on the ORDER OF MAGNITUDE, not a golden file that breaks
    // on a libwebp version bump.
    const photo = await sharp({
      create: { width: 1920, height: 1920, channels: 3, background: { r: 180, g: 90, b: 30 } },
    })
      .jpeg({ quality: 80 })
      .toBuffer();

    const thumb = await makeThumbnail(photo, 320);
    expect(thumb.sizeBytes).toBeLessThan(60 * 1024);
    expect(thumb.sizeBytes).toBeLessThan(photo.length);
  });

  it('never upscales — a photo already smaller than the target is not blown up', async () => {
    const tiny = await sharp({
      create: { width: 120, height: 120, channels: 3, background: { r: 10, g: 10, b: 10 } },
    })
      .jpeg()
      .toBuffer();

    const meta = await sharp((await makeThumbnail(tiny, 320)).buffer).metadata();
    expect(meta.width).toBe(120);
    expect(meta.height).toBe(120);
  });

  it('returns the sha256 OF THE THUMBNAIL, which is what the photo route sends as its ETag', async () => {
    const photo = await sharp({
      create: { width: 800, height: 800, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .jpeg()
      .toBuffer();

    const thumb = await makeThumbnail(photo, 320);
    // Not the hash of the SOURCE: a device revalidating with `If-None-Match`
    // must be comparing the bytes it actually holds.
    expect(thumb.sha256).toBe(sha256Hex(thumb.buffer));
    expect(thumb.sha256).not.toBe(sha256Hex(photo));
  });
});
