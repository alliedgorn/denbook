/**
 * Regression tests for EXIF stripping on image upload paths.
 *
 * Guards the invariant that uploaded images are stored WITHOUT EXIF — no GPS,
 * no device make/model — while remaining visually upright.
 *
 * Why this exists: the upload pipelines previously ended in
 * `.withMetadata({ orientation: undefined })`, which was read as "strip EXIF,
 * clear orientation". It does the opposite — `withMetadata()` is sharp's KEEP
 * call, and passing `orientation: undefined` merely declines to override the
 * orientation tag. Stripping is sharp's DEFAULT, reached by omitting the call.
 * Every upload therefore retained full EXIF including GPS, and nothing failed,
 * because no test asserted on the stored bytes.
 *
 * These tests assert the pipeline shape used by /api/upload,
 * /api/routine/photo/upload, and the Telegram photo path in server.ts. They
 * pin the sharp-version axis: a future sharp release that changes metadata
 * defaults fails here instead of silently re-exposing user location data.
 */

import { describe, it, expect } from 'bun:test';
import sharp from 'sharp';

/** Builds a JPEG carrying GPS + device EXIF and the given orientation tag. */
async function makeExifJpeg(width: number, height: number, orientation: number): Promise<Buffer> {
  return await sharp({
    create: { width, height, channels: 3, background: { r: 12, g: 140, b: 90 } },
  })
    .jpeg()
    .withExif({
      IFD0: { Make: 'DenCam', Model: 'RaccoonPhone' },
      GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' },
    })
    .withMetadata({ orientation })
    .toBuffer();
}

describe('upload EXIF stripping', () => {
  it('source fixture actually carries EXIF (guards the test itself)', async () => {
    const meta = await sharp(await makeExifJpeg(300, 200, 6)).metadata();
    expect(meta.exif).toBeTruthy();
    expect(meta.exif!.length).toBeGreaterThan(0);
    expect(meta.orientation).toBe(6);
  });

  it('strips EXIF on the resize branch (>1920px)', async () => {
    const out = await sharp(await makeExifJpeg(3000, 2000, 1))
      .rotate()
      .resize(1920, null, { withoutEnlargement: true })
      .jpeg({ quality: 95 })
      .toBuffer();

    const meta = await sharp(out).metadata();
    expect(meta.exif).toBeFalsy();
    expect(meta.width).toBe(1920);
  });

  it('strips EXIF on the re-encode branch (large but not oversized)', async () => {
    const out = await sharp(await makeExifJpeg(800, 600, 1))
      .rotate()
      .jpeg({ quality: 95 })
      .toBuffer();

    expect((await sharp(out).metadata()).exif).toBeFalsy();
  });

  it('strips EXIF on the passthrough branch (rotate only)', async () => {
    const out = await sharp(await makeExifJpeg(300, 200, 1)).rotate().toBuffer();

    expect((await sharp(out).metadata()).exif).toBeFalsy();
  });

  it('bakes orientation into pixels so stripping the tag stays visually correct', async () => {
    // Orientation 6 = rotate 90deg on display, so 300x200 must come out 200x300.
    const out = await sharp(await makeExifJpeg(300, 200, 6)).rotate().toBuffer();

    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(300);
    expect(meta.exif).toBeFalsy();
  });

  it('withMetadata() retains EXIF — the trap this suite exists to catch', async () => {
    const out = await sharp(await makeExifJpeg(300, 200, 1))
      .rotate()
      .withMetadata({ orientation: undefined })
      .toBuffer();

    // Documents the old behaviour: the call that read as "strip" preserves GPS.
    expect((await sharp(out).metadata()).exif).toBeTruthy();
  });
});
