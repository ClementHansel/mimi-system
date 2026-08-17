import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { compressAndStripExif, isProcessableImage, sha256Hex } from './image-processing.util';

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
      GPS: {
        GPSLatitude: '1/1, 30/1, 0/1',
        GPSLongitude: '116/1, 50/1, 0/1',
      },
    })
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
      create: { width: 100, height: 100, channels: 4, background: { r: 0, g: 255, b: 0, alpha: 1 } },
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
