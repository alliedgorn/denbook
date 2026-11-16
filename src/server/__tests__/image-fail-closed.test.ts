// T#937: the upload image pipeline fails CLOSED. Asserts on STORED BYTES, not
// only on response codes: a 503 with the original already on disk would pass
// a response-only test.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import sharp from 'sharp';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { sqlite } from '../../db/index.ts';
import { registerFilesRoutes } from '../../files/routes.ts';
import { processImageForStorage, ImageProcessingError, __setSharpLoaderForTest } from '../image-processing.ts';

async function exifJpeg(w = 300, h = 200): Promise<Buffer> {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 12, g: 140, b: 90 } } })
    .jpeg()
    .withExif({ IFD0: { Make: 'DenCam', Model: 'RaccoonPhone' }, GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' } })
    .withMetadata({ orientation: 6 })
    .toBuffer();
}

afterEach(() => __setSharpLoaderForTest(null));

describe('processImageForStorage', () => {
  it('the fixture really carries EXIF (guards the test)', async () => {
    expect((await sharp(await exifJpeg()).metadata()).exif).toBeTruthy();
  });

  it('strips EXIF and applies orientation to the pixels', async () => {
    const out = await processImageForStorage(await exifJpeg(300, 200), { ext: '.jpg', mime: 'image/jpeg' });
    const m = await sharp(out.buffer).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.orientation).toBeUndefined();
    expect([m.width, m.height]).toEqual([200, 300]); // rotated by the tag-6 orientation
  });

  it('wide images are resized and re-encoded as JPEG', async () => {
    const out = await processImageForStorage(await exifJpeg(3000, 1000), { ext: '.jpg', mime: 'image/jpeg' });
    expect(out.ext).toBe('.jpg');
    expect((await sharp(out.buffer).metadata()).width).toBeLessThanOrEqual(1920);
  });

  it('sharp unavailable: throws with sharpUnavailable, never returns the original', async () => {
    __setSharpLoaderForTest(() => { throw new Error('Cannot find module sharp'); });
    const err = await processImageForStorage(await exifJpeg(), { ext: '.jpg', mime: 'image/jpeg' }).catch(e => e);
    expect(err).toBeInstanceOf(ImageProcessingError);
    expect(err.sharpUnavailable).toBe(true);
  });

  it('sharp throws mid-pipeline: throws, not sharpUnavailable', async () => {
    const err = await processImageForStorage(Buffer.from('not an image at all'), { ext: '.jpg', mime: 'image/jpeg' }).catch(e => e);
    expect(err).toBeInstanceOf(ImageProcessingError);
    expect(err.sharpUnavailable).toBe(false);
  });

  it('EXIF that survives processing is refused (a sharp default change cannot leak)', async () => {
    // A sharp whose pipeline keeps metadata, like a reintroduced withMetadata().
    const leaky: any = (input: Buffer) => {
      const real = sharp(input);
      const wrap: any = {
        metadata: () => real.metadata(),
        rotate: () => wrap, resize: () => wrap, jpeg: () => wrap,
        toBuffer: () => sharp(input).withMetadata().toBuffer(),
      };
      return wrap;
    };
    __setSharpLoaderForTest(() => leaky);
    const err = await processImageForStorage(await exifJpeg(), { ext: '.jpg', mime: 'image/jpeg' }).catch(e => e);
    expect(err).toBeInstanceOf(ImageProcessingError);
    expect(String(err.message)).toContain('EXIF survived');
  });

  it('reads the capture date before the strip', async () => {
    const withDate = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
      .jpeg().withExif({ IFD0: { DateTime: '2026:11:16 08:30:00' } }).toBuffer();
    const out = await processImageForStorage(withDate, { ext: '.jpg', mime: 'image/jpeg', forceJpeg: true });
    expect(out.captureDate).toBe('2026-11-16T08:30:00.000Z');
    expect((await sharp(out.buffer).metadata()).exif).toBeUndefined();
  });
});

describe('POST /api/upload stores only stripped bytes, and nothing on failure', () => {
  let dir: string;
  let app: OpenAPIHono;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 't937-uploads-'));
    app = new OpenAPIHono();
    registerFilesRoutes(app, sqlite, {
      hasSessionAuth: () => true,
      isTrustedRequest: () => true,
      isLocalNetwork: () => true,
      verifySessionToken: () => true,
      uploadsDir: dir,
      sessionCookieName: 'oracle_session',
    } as any);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const upload = async (buf: Buffer) => {
    const fd = new FormData();
    fd.append('file', new File([buf], 'photo.jpg', { type: 'image/jpeg' }));
    return Promise.resolve(app.request('/api/upload', { method: 'POST', body: fd }));
  };
  const stored = () => readdirSync(dir).filter(f => statSync(path.join(dir, f)).isFile());

  it('happy path: the stored file has no EXIF', async () => {
    const res = await upload(await exifJpeg());
    expect(res.status).toBeLessThan(300);
    const files = stored();
    expect(files.length).toBe(1);
    expect((await sharp(readFileSync(path.join(dir, files[0]))).metadata()).exif).toBeUndefined();
  });

  it('sharp unavailable: 503 and NOTHING written to disk', async () => {
    __setSharpLoaderForTest(() => { throw new Error('Cannot find module sharp'); });
    const res = await upload(await exifJpeg());
    expect(res.status).toBe(503);
    expect(stored()).toEqual([]);
  });

});

describe('no upload path runs its own sharp chain (regression guard)', () => {
  it('only image-processing.ts requires sharp or calls withMetadata in src', () => {
    const root = path.join(import.meta.dir, '..', '..');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f) || p.endsWith(path.join('server', 'image-processing.ts'))) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/require\(['"]sharp['"]\)|from ['"]sharp['"]|\.withMetadata\(/.test(line)) hits.push(`${path.relative(root, p)}:${i + 1}`);
        });
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
