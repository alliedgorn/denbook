// T#809: the guest avatar goes through the same fail-closed strip as every other
// upload path. Asserts on STORED BYTES: the avatar is served publicly at /api/f/.
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import sharp from 'sharp';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerGuestRoutes } from '../../guest/routes.ts';
import { initGuestTables, createGuest, getGuestByUsername } from '../guest-accounts.ts';
import { __setSharpLoaderForTest } from '../image-processing.ts';

async function gpsJpeg(): Promise<Buffer> {
  return sharp({ create: { width: 120, height: 80, channels: 3, background: { r: 200, g: 120, b: 40 } } })
    .jpeg()
    .withExif({ IFD0: { Make: 'GuestCam' }, GPS: { GPSLatitudeRef: 'N', GPSLongitudeRef: 'E' } })
    .toBuffer();
}

describe('POST /api/guest/avatar stores only stripped bytes, and nothing on failure (T#809)', () => {
  let dir: string;
  let app: OpenAPIHono;
  let db: Database;

  beforeEach(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 't809-avatar-'));
    db = new Database(':memory:');
    initGuestTables(db);
    await createGuest(db, 'avatartester', 'a-long-password');
    app = new OpenAPIHono();
    app.use('*', async (c, next) => { (c.set as any)('guestUsername', 'avatartester'); (c.set as any)('role', 'guest'); await next(); });
    registerGuestRoutes(app, db, {
      wsBroadcast: () => {},
      withRetry: (fn: any) => fn(),
      getTmuxStatus: () => ({ tmuxStatus: new Map(), contextPctMap: new Map() }),
      normalizeAvatarUrl: (u: string | null) => u,
      uploadsDir: dir,
    } as any);
  });
  afterEach(() => { __setSharpLoaderForTest(null); rmSync(dir, { recursive: true, force: true }); });

  const upload = async (buf: Buffer, type = 'image/jpeg') => {
    const fd = new FormData();
    fd.append('file', new File([buf], 'me.jpg', { type }));
    return Promise.resolve(app.request('/api/guest/avatar', { method: 'POST', body: fd }));
  };
  const stored = () => readdirSync(dir).filter(f => statSync(path.join(dir, f)).isFile());

  it('the fixture really carries EXIF with GPS (guards the test)', async () => {
    expect((await sharp(await gpsJpeg()).metadata()).exif).toBeTruthy();
  });

  it('happy path: 200, the stored avatar has no EXIF, XMP or IPTC, and the profile points at it', async () => {
    const res = await upload(await gpsJpeg());
    expect(res.status).toBe(200);
    const files = stored();
    expect(files).toEqual(['guest-avatartester-avatar.jpg']);
    const m = await sharp(readFileSync(path.join(dir, files[0]))).metadata();
    expect(m.exif).toBeUndefined();
    expect(m.xmp).toBeUndefined();
    expect(m.iptc).toBeUndefined();
    expect(getGuestByUsername(db, 'avatartester')!.avatar_url).toBe('/api/f/guest-avatartester-avatar.jpg');
  });

  it('sharp unavailable: 503, NOTHING written, profile unchanged', async () => {
    __setSharpLoaderForTest(() => { throw new Error('Cannot find module sharp'); });
    const res = await upload(await gpsJpeg());
    expect(res.status).toBe(503);
    expect(stored()).toEqual([]);
    expect(getGuestByUsername(db, 'avatartester')!.avatar_url ?? null).toBeNull();
  });

  it('a file with JPEG magic bytes that sharp cannot read: 400, NOTHING written', async () => {
    const junk = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really a jpeg at all')]);
    const res = await upload(junk);
    expect(res.status).toBe(400);
    expect(stored()).toEqual([]);
  });
});
