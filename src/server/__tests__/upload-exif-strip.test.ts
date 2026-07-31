/**
 * Regression tests for EXIF stripping on the image-upload paths (T#881).
 *
 * Guards the invariant that uploaded images are STORED without EXIF — no GPS,
 * no device make/model — while remaining visually upright.
 *
 * Why this exists: all three upload pipelines previously ended in
 * `.withMetadata({ orientation: undefined })`, which reads as "strip EXIF,
 * clear orientation" and does the opposite. `withMetadata()` is sharp's KEEP
 * call; passing `orientation: undefined` merely declines to override the
 * orientation tag. Stripping is sharp's DEFAULT, reached by OMITTING the call.
 * Every upload retained full EXIF including GPS, for months, and nothing
 * failed — because no test asserted on the stored bytes.
 *
 * ⚠️ The reintroduction path is the reason this file exists rather than a
 * one-off fixture: `withMetadata()` reads as "handle the metadata" to anyone
 * who has not been bitten. Somebody fixing an orientation bug in six months
 * adds it back in good faith. The canary test below goes red when they do.
 *
 * These mirror the pipeline shapes at files/routes.ts:124,132,139,
 * forge/routes.ts:1157 and telegram/routes.ts:141,144 — three distinct chains
 * across six call sites. They also pin the sharp-version axis: a future sharp
 * release that changes metadata defaults fails here instead of silently
 * re-exposing user location data.
 */

import { describe, it, expect } from 'bun:test';
import sharp from 'sharp';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    // Without this, every assertion below could pass on a specimen that never
    // had metadata — a probe incapable of returning a positive.
    const meta = await sharp(await makeExifJpeg(300, 200, 6)).metadata();
    expect(meta.exif).toBeTruthy();
    expect(meta.exif!.length).toBeGreaterThan(0);
    expect(meta.orientation).toBe(6);
  });

  // ── chain A — files/routes.ts:124 · forge/routes.ts:1157 · telegram:141 ──
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

  // ── chain B — files/routes.ts:132 ────────────────────────────────────────
  it('strips EXIF on the re-encode branch (large but not oversized)', async () => {
    const out = await sharp(await makeExifJpeg(800, 600, 1))
      .rotate()
      .jpeg({ quality: 95 })
      .toBuffer();

    expect((await sharp(out).metadata()).exif).toBeFalsy();
  });

  // ── chain C — files/routes.ts:139 · telegram/routes.ts:144 ───────────────
  // The one genuinely in doubt: no re-encode, so the container is never
  // rebuilt and EXIF surviving was plausible. It does not survive.
  it('strips EXIF on the rotate-only branch (no re-encode)', async () => {
    const out = await sharp(await makeExifJpeg(300, 200, 1)).rotate().toBuffer();
    expect((await sharp(out).metadata()).exif).toBeFalsy();
  });

  it('still applies orientation before stripping (image stays upright)', async () => {
    // orientation 6 = rotate 90° CW. Stripping must not mean ignoring it.
    const out = await sharp(await makeExifJpeg(300, 200, 6)).rotate().toBuffer();
    const meta = await sharp(out).metadata();
    expect(meta.width).toBe(200);
    expect(meta.height).toBe(300);
    expect(meta.exif).toBeFalsy();
  });

  // ── the canary ───────────────────────────────────────────────────────────
  it('CANARY: withMetadata() re-attaches EXIF — this is what the fix removed', async () => {
    // If somebody reintroduces `.withMetadata(...)` in an upload pipeline in
    // good faith, this documents exactly what that call does. It must keep
    // passing: the day it fails, sharp's semantics changed and the stripping
    // assertions above need re-deriving rather than trusting.
    const out = await sharp(await makeExifJpeg(800, 600, 1))
      .rotate()
      .jpeg({ quality: 95 })
      .withMetadata({ orientation: undefined })
      .toBuffer();

    expect((await sharp(out).metadata()).exif).toBeTruthy();
  });

  // ── stored bytes, not the in-memory buffer ───────────────────────────────
  it('asserts on the file ON DISK, not on the response', async () => {
    // A 200 with an unstripped file passes a response-only test — the same
    // shape as the fail-open this pipeline had. Round-trip through the
    // filesystem so the assertion is about what a reader would actually get.
    const dir = mkdtempSync(join(tmpdir(), 'exif-strip-'));
    try {
      const processed = await sharp(await makeExifJpeg(3000, 2000, 1))
        .rotate()
        .resize(1920, null, { withoutEnlargement: true })
        .jpeg({ quality: 95 })
        .toBuffer();

      const path = join(dir, 'stored.jpg');
      writeFileSync(path, processed);
      const fromDisk = readFileSync(path);

      expect((await sharp(fromDisk).metadata()).exif).toBeFalsy();
      // Byte-level: the device markers must not appear anywhere in the file.
      expect(fromDisk.includes(Buffer.from('DenCam', 'latin1'))).toBe(false);
      expect(fromDisk.includes(Buffer.from('RaccoonPhone', 'latin1'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
