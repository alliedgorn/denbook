// T#937 + T#881: the one image pipeline for every upload path, and it fails CLOSED.
//
// Before this, files, forge and telegram each ran their own sharp chain inside
// `catch { /* sharp not available */ }`. When sharp threw, the ORIGINAL buffer
// (EXIF, GPS and all) was written to disk, silently, with a 2xx. The privacy
// control became a no-op in exactly the case it exists for.
//
// Rules:
// - EXIF is stripped by OMITTING withMetadata(). withMetadata() is sharp's
//   KEEP call (T#881). rotate() applies the orientation to the pixels first,
//   so the stored image stays upright with no orientation tag.
// - After processing, the output is re-read. If it still carries EXIF, it is
//   refused. This catches a future sharp default change or a reintroduced
//   withMetadata().
// - Any failure throws ImageProcessingError. Nothing returns the original.
//   sharpUnavailable separates a deployment fault (callers answer 503) from a
//   bad or unreadable image (callers answer 400).
// - sharp is required lazily, so a missing sharp breaks uploads, not startup.
// (Design ported from rax/sharp-libvips-bump-exif-strip 9fe71f2e, which could
// not be rebased onto the split route files.)

export class ImageProcessingError extends Error {
  constructor(message: string, readonly sharpUnavailable: boolean) {
    super(message);
    this.name = 'ImageProcessingError';
  }
}

export type ProcessedImage = {
  buffer: Buffer;
  ext: string;          // '.jpg' when re-encoded, else the input ext
  mime: string;
  captureDate: string | null; // EXIF DateTimeOriginal as ISO, read BEFORE the strip
};

export type ProcessOptions = {
  ext: string;          // detected input extension, e.g. '.png'
  mime: string;         // detected input mime
  maxWidth?: number;    // resize above this width (default 1920)
  forceJpeg?: boolean;  // always re-encode to JPEG (forge)
  jpegAboveBytes?: number; // re-encode to JPEG above this input size (files: 2MB)
};

// Test seam: lets a test force "sharp unavailable" without uninstalling it.
let loadSharp: () => any = () => require('sharp');
export function __setSharpLoaderForTest(fn: (() => any) | null): void {
  loadSharp = fn ?? (() => require('sharp'));
}

function exifCaptureDate(exif: Buffer | undefined): string | null {
  if (!exif) return null;
  const m = exif.toString('binary').match(/(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z` : null;
}

export async function processImageForStorage(input: Buffer, opts: ProcessOptions): Promise<ProcessedImage> {
  let sharp: any;
  try {
    sharp = loadSharp();
  } catch (e) {
    throw new ImageProcessingError(`sharp unavailable: ${(e as Error).message}`, true);
  }

  try {
    const meta = await sharp(input).metadata();
    const captureDate = exifCaptureDate(meta.exif);
    const maxWidth = opts.maxWidth ?? 1920;
    const wide = !!meta.width && meta.width > maxWidth;
    const toJpeg = !!opts.forceJpeg || wide || (opts.jpegAboveBytes !== undefined && input.length > opts.jpegAboveBytes);

    let chain = sharp(input).rotate();
    if (wide) chain = chain.resize(maxWidth, null, { withoutEnlargement: true });
    if (toJpeg) chain = chain.jpeg({ quality: 95 });
    const buffer: Buffer = await chain.toBuffer();

    // GPS and device data can live in EXIF, XMP or IPTC. Refuse if any block
    // survived (Gnarl, PR 163: an XMP-only GPS passes an EXIF-only check).
    const after = await sharp(buffer).metadata();
    const kept = (['exif', 'xmp', 'iptc'] as const).filter(k => after[k] && after[k].length > 0);
    if (kept.length > 0) {
      throw new ImageProcessingError(`metadata survived processing (${kept.join(', ')}); refusing to store`, false);
    }
    return {
      buffer,
      ext: toJpeg ? '.jpg' : opts.ext,
      mime: toJpeg ? 'image/jpeg' : opts.mime,
      captureDate,
    };
  } catch (e) {
    if (e instanceof ImageProcessingError) throw e;
    throw new ImageProcessingError(`image processing failed: ${(e as Error).message}`, false);
  }
}
