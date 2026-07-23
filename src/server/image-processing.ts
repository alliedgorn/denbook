/**
 * Shared image-processing pipeline for upload paths (T#881).
 *
 * Every route that stores a user-supplied image goes through here, so the
 * EXIF-stripping guarantee lives in exactly one place and cannot drift between
 * call sites. Previously each route reimplemented the pipeline inline; all
 * three independently ended in `.withMetadata({ orientation: undefined })`,
 * which is sharp's KEEP call — so all three stored full EXIF including GPS
 * while documenting themselves as stripping it.
 *
 * Two invariants this module exists to hold:
 *
 * 1. **EXIF is stripped.** Achieved by NOT calling `withMetadata()`/`keepExif()`
 *    — stripping is sharp's default. `.rotate()` bakes orientation into the
 *    pixels first, so dropping the tag costs no visual correctness.
 *
 * 2. **It fails CLOSED.** On any sharp failure this throws. Callers must reject
 *    the upload rather than storing the original bytes. The previous inline
 *    `catch { /* sharp not available *\/ }` wrote the ORIGINAL buffer on
 *    failure — un-stripped, silently, with no log — so the privacy control
 *    silently degraded to a no-op under exactly the conditions where it
 *    mattered.
 */

export class ImageProcessingError extends Error {
  /** True when sharp itself could not be loaded (deployment problem, not input). */
  readonly sharpUnavailable: boolean;

  constructor(message: string, opts: { sharpUnavailable: boolean; cause?: unknown }) {
    super(message, { cause: opts.cause });
    this.name = 'ImageProcessingError';
    this.sharpUnavailable = opts.sharpUnavailable;
  }
}

export interface ProcessImageOptions {
  /** ext/mime to keep when the image is passed through without re-encoding. */
  fallbackExt: string;
  fallbackMime: string;
  /** Always re-encode to JPEG regardless of size (routine-photo path). */
  alwaysReencode?: boolean;
  /** Re-encode to JPEG when the source exceeds this many bytes. */
  reencodeOverBytes?: number;
  /** Pull DateTimeOriginal out of EXIF before it is stripped. */
  extractCaptureDate?: boolean;
}

export interface ProcessedImage {
  buffer: Buffer;
  ext: string;
  mime: string;
  /** ISO capture date recovered from EXIF before stripping, if requested/present. */
  captureDate: string | null;
}

const MAX_WIDTH = 1920;
const JPEG_QUALITY = 95;

/**
 * Reads DateTimeOriginal out of a raw EXIF block.
 *
 * The capture date is deliberately recovered BEFORE stripping so the routine
 * log can keep it as a DB column — the date is wanted, the GPS is not.
 */
function readCaptureDate(exif: Buffer): string | null {
  try {
    const m = exif.toString('binary').match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  } catch {
    return null;
  }
}

/**
 * Resizes/re-encodes as needed and returns EXIF-free bytes.
 *
 * @throws {ImageProcessingError} on any failure — callers must NOT fall back to
 *         storing the original buffer.
 */
export async function processImageForStorage(
  input: Buffer,
  opts: ProcessImageOptions,
): Promise<ProcessedImage> {
  let sharp: any;
  try {
    sharp = require('sharp');
  } catch (cause) {
    throw new ImageProcessingError(
      'sharp is unavailable — refusing to store an image without EXIF stripping',
      { sharpUnavailable: true, cause },
    );
  }

  try {
    const metadata = await sharp(input).metadata();

    const captureDate =
      opts.extractCaptureDate && metadata.exif ? readCaptureDate(metadata.exif) : null;

    const oversized = !!metadata.width && metadata.width > MAX_WIDTH;
    const overBytes =
      opts.reencodeOverBytes !== undefined && input.length > opts.reencodeOverBytes;

    // No withMetadata()/keepExif() anywhere below — stripping is the default.
    if (oversized || opts.alwaysReencode) {
      const buffer = await sharp(input)
        .rotate()
        .resize(MAX_WIDTH, null, { withoutEnlargement: true })
        .jpeg({ quality: JPEG_QUALITY })
        .toBuffer();
      return { buffer, ext: '.jpg', mime: 'image/jpeg', captureDate };
    }

    if (overBytes) {
      const buffer = await sharp(input).rotate().jpeg({ quality: JPEG_QUALITY }).toBuffer();
      return { buffer, ext: '.jpg', mime: 'image/jpeg', captureDate };
    }

    const buffer = await sharp(input).rotate().toBuffer();
    return { buffer, ext: opts.fallbackExt, mime: opts.fallbackMime, captureDate };
  } catch (cause) {
    if (cause instanceof ImageProcessingError) throw cause;
    throw new ImageProcessingError('image could not be processed', {
      sharpUnavailable: false,
      cause,
    });
  }
}
