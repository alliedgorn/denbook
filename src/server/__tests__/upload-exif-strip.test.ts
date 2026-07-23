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
import { processImageForStorage, ImageProcessingError } from '../image-processing.ts';

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

/**
 * Tests against the shared helper rather than a hand-rolled pipeline, so these
 * catch call-site drift as well as sharp-version drift — the gap that existed
 * while each route reimplemented the pipeline inline.
 */
describe('processImageForStorage', () => {
  const opts = { fallbackExt: '.png', fallbackMime: 'image/png' };

  it('strips EXIF and re-encodes when the image exceeds max width', async () => {
    const r = await processImageForStorage(await makeExifJpeg(3000, 2000, 1), opts);

    expect(r.ext).toBe('.jpg');
    expect(r.mime).toBe('image/jpeg');
    expect((await sharp(r.buffer).metadata()).width).toBe(1920);
    expect((await sharp(r.buffer).metadata()).exif).toBeFalsy();
  });

  it('strips EXIF on passthrough, keeping the caller ext/mime', async () => {
    const r = await processImageForStorage(await makeExifJpeg(300, 200, 1), opts);

    expect(r.ext).toBe('.png');
    expect(r.mime).toBe('image/png');
    expect((await sharp(r.buffer).metadata()).exif).toBeFalsy();
  });

  it('re-encodes over the byte threshold when one is given', async () => {
    const r = await processImageForStorage(await makeExifJpeg(300, 200, 1), {
      ...opts,
      reencodeOverBytes: 10,
    });

    expect(r.ext).toBe('.jpg');
    expect((await sharp(r.buffer).metadata()).exif).toBeFalsy();
  });

  it('always re-encodes when asked, and still strips', async () => {
    const r = await processImageForStorage(await makeExifJpeg(300, 200, 1), {
      ...opts,
      alwaysReencode: true,
    });

    expect(r.ext).toBe('.jpg');
    expect((await sharp(r.buffer).metadata()).exif).toBeFalsy();
  });

  it('recovers the capture date before stripping, so the date survives the strip', async () => {
    const withDate = await sharp({
      create: { width: 60, height: 40, channels: 3, background: { r: 4, g: 4, b: 4 } },
    })
      .jpeg()
      .withExif({ IFD0: { DateTimeOriginal: '2026:03:28 14:05:09' }, GPS: { GPSLatitudeRef: 'N' } })
      .toBuffer();

    const r = await processImageForStorage(withDate, { ...opts, extractCaptureDate: true });

    expect(r.captureDate).toBe('2026-03-28T14:05:09.000Z');
    expect((await sharp(r.buffer).metadata()).exif).toBeFalsy();
  });

  it('leaves captureDate null when extraction is not requested', async () => {
    const r = await processImageForStorage(await makeExifJpeg(60, 40, 1), opts);
    expect(r.captureDate).toBeNull();
  });

  it('FAILS CLOSED on unprocessable input — never returns the original bytes', async () => {
    const garbage = Buffer.from('this is not an image, not even slightly');

    // The whole point: no fallback path may hand back un-stripped input.
    await expect(processImageForStorage(garbage, opts)).rejects.toThrow(ImageProcessingError);
  });

  it('marks input failures as not-sharpUnavailable, so callers can pick 400 vs 503', async () => {
    const garbage = Buffer.from('still not an image');

    try {
      await processImageForStorage(garbage, opts);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ImageProcessingError);
      expect((e as ImageProcessingError).sharpUnavailable).toBe(false);
    }
  });
});
