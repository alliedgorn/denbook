import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

// Study area — owner-only learning tracks + per-user progress (T#963)
//
// Gate: owner browser session ONLY. A valid session cookie whose role is not
// 'guest'. Beast bearer tokens carry no cookie, and local-bypass requests carry
// no cookie, so neither reaches this data. Guests are already default-denied by
// rbacMiddleware; the explicit role check here is defense-in-depth.
//
// study_progress.user is always derived from the session, never from the body
// or query. Today the only owner identity is 'gorn'.

interface StudyHelpers {
  hasSessionAuth: (c: Context) => boolean;
  // Where runtime study content lives (Gorn 11-14: change content without a PR,
  // a rebuild or a restart). Karo edits these files on the box; there is no write
  // route. Unset = the content route answers 404 and the page uses bundled content.
  contentDir?: string;
}

export const STUDY_CONTENT_MAX_BYTES = 2 * 1024 * 1024;

export const STUDY_MAX_BYTES = 256 * 1024;
const TRACK_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function ensureStudyTables(sqlite: Database) {
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS study_progress (
      user TEXT NOT NULL,
      track TEXT NOT NULL,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user, track)
    )
  `).run();
}

export function registerStudyRoutes(app: OpenAPIHono, sqlite: Database, helpers: StudyHelpers) {
  const { hasSessionAuth, contentDir } = helpers;

  function ownerOf(c: Context): string | null {
    // Both checks are load-bearing. role 'owner' is also the middleware's default
    // for no-cookie local-bypass requests, so the signed-cookie check is what
    // keeps the on-box path out. Never reduce this to the role check alone.
    if (!hasSessionAuth(c)) return null;
    if ((c.get as any)('role') !== 'owner') return null;
    return 'gorn';
  }

  function deny(c: Context) {
    return c.json({ error: 'forbidden — owner session required' }, 403);
  }

  // GET /api/study/progress/:track — saved progress for one track
  app.get('/api/study/progress/:track', (c) => {
    const user = ownerOf(c);
    if (!user) return deny(c);
    const track = c.req.param('track');
    if (!TRACK_RE.test(track)) return c.json({ error: 'invalid track' }, 400);

    const row = sqlite.prepare(
      'SELECT data, updated_at FROM study_progress WHERE user = ? AND track = ?'
    ).get(user, track) as { data: string; updated_at: string } | null;
    if (!row) return c.json({ track, data: null, updated_at: null });

    let data: unknown = null;
    try { data = JSON.parse(row.data); } catch { /* corrupt row reads as empty */ }
    return c.json({ track, data, updated_at: row.updated_at });
  });

  // PUT /api/study/progress/:track — replace saved progress for one track
  // Body: { "data": { ...any JSON object... } }
  app.put('/api/study/progress/:track', async (c) => {
    const user = ownerOf(c);
    if (!user) return deny(c);
    const track = c.req.param('track');
    if (!TRACK_RE.test(track)) return c.json({ error: 'invalid track' }, 400);

    const declared = Number(c.req.header('content-length') || 0);
    if (declared > STUDY_MAX_BYTES) return c.json({ error: 'payload too large' }, 413);
    const raw = await c.req.text();
    if (Buffer.byteLength(raw, 'utf8') > STUDY_MAX_BYTES) return c.json({ error: 'payload too large' }, 413);

    let body: any;
    try { body = JSON.parse(raw); } catch { return c.json({ error: 'invalid JSON' }, 400); }
    const data = body?.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return c.json({ error: 'data must be a JSON object' }, 400);
    }

    const now = new Date().toISOString();
    sqlite.prepare(
      `INSERT INTO study_progress (user, track, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(user, track) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).run(user, track, JSON.stringify(data), now);
    return c.json({ track, updated_at: now });
  });

  // GET /api/study/content/:name — runtime content file <contentDir>/<name>.json
  // Read-only, owner-gated like progress. The name is a strict slug, so it can never
  // leave contentDir. Symlinks are refused (O_NOFOLLOW on open). The page validates the shape again and
  // falls back to its bundled copy on anything wrong, and every string is rendered as
  // text by RichText, so a bad file can break the page's content but never inject HTML.
  app.get('/api/study/content/:name', (c) => {
    const user = ownerOf(c);
    if (!user) return deny(c);
    const name = c.req.param('name');
    if (!TRACK_RE.test(name)) return c.json({ error: 'invalid name' }, 400);
    if (!contentDir) return c.json({ error: 'no content' }, 404);

    const file = path.join(contentDir, `${name}.json`);
    // Open with O_NOFOLLOW and check the open handle, so the file checked is the file
    // read: no stat-then-read gap for a swap to a symlink (Bertus, PR 148 review).
    // O_NONBLOCK too: a blocking open on a FIFO waits for a writer and freezes the whole
    // server (Bertus measured it). Non-blocking, the open returns and fstat rejects it.
    let fd: number;
    try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); } catch { return c.json({ error: 'no content' }, 404); }
    let st: fs.Stats;
    let raw: string;
    try {
      st = fs.fstatSync(fd);
      if (!st.isFile()) return c.json({ error: 'no content' }, 404);
      if (st.size > STUDY_CONTENT_MAX_BYTES) return c.json({ error: 'content file too large' }, 500);
      raw = fs.readFileSync(fd, 'utf8');
    } finally {
      fs.closeSync(fd);
    }

    let content: unknown;
    try { content = JSON.parse(raw); } catch { return c.json({ error: 'content file is not valid JSON' }, 500); }
    if (!content || typeof content !== 'object' || Array.isArray(content)) {
      return c.json({ error: 'content must be a JSON object' }, 500);
    }
    c.header('Cache-Control', 'no-store');
    return c.json({ name, content, updated_at: st.mtime.toISOString() });
  });
}
