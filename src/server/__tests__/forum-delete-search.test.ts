// T#975 — a soft-deleted forum post must not be findable in Den search.
// Covers the four ways it could come back: the DELETE handler, posts deleted
// before the fix (startup sweep), a full reindex, and a stray index row
// (result guard). Meilisearch is off here (no master key), so this exercises
// the FTS5 path; the Meili calls share the same ids and code paths.
import { describe, it, expect, beforeAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAPIHono } from '@hono/zod-openapi';
import { initSearch, registerSearchRoutes, searchIndexUpsert } from '../../search/routes.ts';
import { registerForumRoutes } from '../../forum/routes.ts';
import { registerKnowledgeRoutes } from '../../knowledge/routes.ts';

let db: Database;
let app: OpenAPIHono;

function schema(d: Database) {
  d.run(`CREATE TABLE forum_threads (id INTEGER PRIMARY KEY, title TEXT, status TEXT, category TEXT, created_at TEXT,
         updated_at TEXT, created_by TEXT, deleted_at TEXT)`);
  d.run('CREATE TABLE forum_message_edits (id INTEGER PRIMARY KEY, message_id INTEGER, original_content TEXT, edited_by TEXT, created_at INTEGER)');
  d.run(`CREATE TABLE forum_messages (id INTEGER PRIMARY KEY, thread_id INTEGER, role TEXT, author TEXT,
         content TEXT, created_at TEXT, deleted_at TEXT, deleted_by TEXT, edited_at INTEGER)`);
  d.run('CREATE TABLE library (id INTEGER PRIMARY KEY, title TEXT, content TEXT, author TEXT, created_at TEXT)');
  d.run('CREATE TABLE risks (id INTEGER PRIMARY KEY, title TEXT, description TEXT, created_by TEXT, created_at TEXT)');
  d.run('CREATE TABLE tasks (id INTEGER PRIMARY KEY, title TEXT, description TEXT, assigned_to TEXT, created_at TEXT)');
  d.run(`CREATE TABLE library_shelves (id INTEGER PRIMARY KEY, name TEXT, description TEXT, icon TEXT,
         color TEXT, created_by TEXT, created_at TEXT)`);
  d.run(`CREATE TABLE spec_reviews (id INTEGER PRIMARY KEY, title TEXT, author TEXT, file_path TEXT,
         repo TEXT, created_at TEXT)`);
}

const post = (id: number, word: string, deleted = false, thread = 1) => db.run(
  'INSERT INTO forum_messages (id, thread_id, author, content, created_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?)',
  [id, thread, 'guest-x', `hello ${word} there`, '2026-11-16T00:00:00Z', deleted ? '2026-11-15T00:00:00Z' : null],
);

// A second app on the same db with a chosen caller, for the auth-sensitive routes.
// The helpers mirror PRODUCTION (server.ts): the token middleware sets `actor`
// for a bearer, and requireBeastIdentity returns that actor, else 'gorn' for ANY
// verified session, guest sessions included (T#887). A friendlier mock let the
// guest test pass vacuously (Bertus, PR 154).
function forumApp(bearer: string | null, session: boolean, role: 'owner' | 'guest' = 'owner'): OpenAPIHono {
  const a = new OpenAPIHono();
  a.use('*', async (c, next) => {
    c.set('role' as any, role);
    if (bearer) c.set('actor' as any, bearer);
    await next();
  });
  registerForumRoutes(a, db, {
    hasSessionAuth: () => session,
    requireBeastIdentity: (c) => ((c.get as any)('actor') as string | undefined) || (session ? 'gorn' : null),
    isTrustedRequest: () => true,
    wsBroadcast: () => {},
    withRetry: async (fn) => fn(),
    getSupportedEmoji: () => new Set(),
  });
  return a;
}

async function hits(word: string): Promise<number> {
  const r = await app.request(`/api/search?q=${word}&as=karo`);
  expect(r.status).toBe(200);
  const body = await r.json() as any;
  return body.results.filter((x: any) => x.source_type === 'forum').length;
}

const ftsRows = (id: number) => (db.query(
  "SELECT COUNT(*) c FROM search_index WHERE source_type = 'forum' AND CAST(source_id AS INTEGER) = ?",
).get(id) as any).c;

beforeAll(() => {
  db = new Database(':memory:');
  schema(db);
  db.run("INSERT INTO forum_threads (id, title) VALUES (1, 'guest thread')");
  db.run("INSERT INTO forum_threads (id, title, created_by) VALUES (2, 'thread to delete', 'rax')");
  db.run("INSERT INTO forum_threads (id, title, created_by) VALUES (3, 'gorns thread', 'gorn')");
  db.run("INSERT INTO forum_threads (id, title, created_by) VALUES (4, 'deleted before the fix', 'gorn')");
  post(50, 'zebrathreadpost', false, 2);
  post(60, 'zebrakeep', false, 3);
  post(70, 'zebraoldthread @karo', false, 4);
  post(80, 'zebrabefore', false, 1);
  post(1, 'zebraalive');            // stays live
  post(2, 'zebraold');              // live at first index, deleted "before the fix"
  post(3, 'zebrahandler');          // deleted through the API after the fix
  post(4, 'zebramention @karo');    // deleted; checked on the non-search read paths
  initSearch(db);                   // first boot: backfill indexes every post
  // Thread 4 is deleted the old way: thread flagged, its posts and index untouched.
  db.run("UPDATE forum_threads SET deleted_at = '2026-11-15 00:00:00', status = 'deleted' WHERE id = 4");

  // Post 2 is deleted the old way: row flagged, index untouched (prod today).
  db.run("UPDATE forum_messages SET deleted_at = '2026-11-15T00:00:00Z', deleted_by = 'gorn' WHERE id = 2");
  expect(ftsRows(2)).toBe(1);

  app = new OpenAPIHono();
  registerSearchRoutes(app, db, {
    hasSessionAuth: () => true,
    isLocalNetwork: () => true,
    isTrustedRequest: () => true,
    handleSearch: async () => ({}),
  });
  registerForumRoutes(app, db, {
    hasSessionAuth: () => true,
    requireBeastIdentity: () => null,
    isTrustedRequest: () => true,
    wsBroadcast: () => {},
    withRetry: async (fn) => fn(),
    getSupportedEmoji: () => new Set(),
  });
  registerKnowledgeRoutes(app, db, { repoRoot: '/nonexistent' } as any);
  db.run("UPDATE forum_messages SET deleted_at = '2026-11-15T00:00:00Z', deleted_by = 'gorn' WHERE id = 4");
});

describe('T#975 deleted forum posts leave Den search', () => {
  it('a live post is found (control)', async () => {
    expect(await hits('zebraalive')).toBe(1);
  });

  it('a post deleted before the fix is not returned (result guard)', async () => {
    expect(ftsRows(2)).toBe(1);     // still in the index until the sweep runs
    expect(await hits('zebraold')).toBe(0);
  });

  it('the startup sweep removes posts deleted before the fix from the index', () => {
    initSearch(db);                 // restart
    expect(ftsRows(2)).toBe(0);
    expect(ftsRows(1)).toBe(1);
  });

  it('DELETE /api/message/:id removes the post from the index', async () => {
    expect(ftsRows(3)).toBe(1);
    const r = await app.request('/api/message/3', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect((await r.json() as any).soft).toBe(true);
    expect(ftsRows(3)).toBe(0);
    expect(await hits('zebrahandler')).toBe(0);
    // Nothing is Deleted: the row itself stays.
    expect((db.query('SELECT deleted_at FROM forum_messages WHERE id = 3').get() as any).deleted_at).toBeTruthy();
  });

  it('a full reindex does not bring deleted posts back', async () => {
    const r = await app.request('/api/search/reindex', { method: 'POST' });
    expect(r.status).toBe(200);
    expect(ftsRows(2)).toBe(0);
    expect(ftsRows(3)).toBe(0);
    expect(ftsRows(1)).toBe(1);
  });

  it('search status counts only live posts, so it reports no drift', async () => {
    const r = await app.request('/api/search/status');
    const body = await r.json() as any;
    const src = body.source?.forum ?? body.sources?.forum;
    // Live at this point: 1, 50, 60, 80. Not counted: 2, 3, 4 (deleted posts)
    // and 70 (its thread was deleted).
    expect(src).toBe(4);
  });

  it('upsert replaces a backfilled row instead of stacking a duplicate', () => {
    expect(ftsRows(1)).toBe(1);     // row 1 came from the SQL backfill (integer id)
    searchIndexUpsert('forum', 1, 'guest thread', 'hello zebraalive edited', 'guest-x', '2026-11-16T00:00:00Z');
    expect(ftsRows(1)).toBe(1);
  });

  // Gorn 5e: gone "from anything a Beast or guest can see", not only search.
  it('the mentions feed (readable without a token) skips deleted posts', async () => {
    const body = await (await app.request('/api/forum/mentions/karo')).json() as any;
    expect(body.mentions.map((m: any) => m.message_id)).not.toContain(4);
  });

  it('/api/forum/search skips deleted posts', async () => {
    const body = await (await app.request('/api/forum/search?q=zebra')).json() as any;
    const ids = body.messages.map((m: any) => m.id);
    expect(ids).toContain(1);
    expect(ids).not.toContain(2);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
  });

  it('/api/feed skips deleted posts', async () => {
    const r = await app.request('/api/feed?type=forum');
    expect(r.status).toBe(200);
    const text = await r.text();
    expect(text).toContain('zebraalive');
    expect(text).not.toContain('zebraold');
    expect(text).not.toContain('zebramention');
  });

  it('/api/forum/activity skips deleted posts (Bertus, PR 152)', async () => {
    const body = await (await app.request('/api/forum/activity?limit=50')).json() as any;
    const ids = body.activity.map((m: any) => m.message_id);
    expect(ids).toContain(1);
    for (const dead of [2, 3, 4]) expect(ids).not.toContain(dead);
  });

  it('content read endpoints cap their page size at 200', async () => {
    for (let i = 100; i < 330; i++) post(i, `bulk${i} @karo`);
    const activity = await (await app.request('/api/forum/activity?limit=100000')).json() as any;
    expect(activity.activity.length).toBe(200);
    const mentions = await (await app.request('/api/forum/mentions/karo?limit=100000')).json() as any;
    expect(mentions.mentions.length).toBe(200);
    const search = await (await app.request('/api/forum/search?q=bulk&limit=100000')).json() as any;
    expect(search.messages.length).toBe(200);
    const junk = await (await app.request('/api/forum/activity?limit=abc')).json() as any;
    expect(junk.activity.length).toBe(30);
  });
});

describe('T#978 thread delete, edits, and thread-delete identity', () => {
  it('a post in a thread deleted before the fix is out of search and the read paths', async () => {
    expect(await hits('zebraoldthread')).toBe(0);          // result guard
    initSearch(db);                                         // restart: sweep
    expect(ftsRows(70)).toBe(0);
    const m = await (await app.request('/api/forum/mentions/karo')).json() as any;
    expect(m.mentions.map((x: any) => x.message_id)).not.toContain(70);
    const f = await (await app.request('/api/forum/search?q=zebraoldthread')).json() as any;
    expect(f.messages.length).toBe(0);
    const act = await (await app.request('/api/forum/activity?limit=200')).json() as any;
    expect(act.activity.map((x: any) => x.message_id)).not.toContain(70);
    const feed = await (await app.request('/api/feed?type=forum&limit=200')).text();
    expect(feed).not.toContain('zebraoldthread');
  });

  it('tokenless ?as=gorn cannot delete a thread (401), thread untouched', async () => {
    const r = await forumApp(null, false).request('/api/thread/3?as=gorn', { method: 'DELETE' });
    expect(r.status).toBe(401);
    expect((db.query('SELECT deleted_at FROM forum_threads WHERE id = 3').get() as any).deleted_at).toBeNull();
    expect(await hits('zebrakeep')).toBe(1);
  });

  it('a guest session cannot delete a thread as Gorn (401), thread untouched', async () => {
    const r = await forumApp(null, true, 'guest').request('/api/thread/3?as=gorn', { method: 'DELETE' });
    expect(r.status).toBe(401);
    expect((db.query('SELECT deleted_at FROM forum_threads WHERE id = 3').get() as any).deleted_at).toBeNull();
  });

  it('a Beast cannot delete a thread it did not create, even with ?as=gorn (403)', async () => {
    const r = await forumApp('karo', false).request('/api/thread/3?as=gorn', { method: 'DELETE' });
    expect(r.status).toBe(403);
    expect((db.query('SELECT deleted_at FROM forum_threads WHERE id = 3').get() as any).deleted_at).toBeNull();
  });

  it('the creator deletes their thread and its posts leave search', async () => {
    expect(ftsRows(50)).toBe(1);
    const r = await forumApp('rax', false).request('/api/thread/2', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(ftsRows(50)).toBe(0);
    expect(await hits('zebrathreadpost')).toBe(0);
    const re = await app.request('/api/search/reindex', { method: 'POST' });
    expect(re.status).toBe(200);
    expect(ftsRows(50)).toBe(0);                            // rebuild skips it too
  });

  it('Gorn (owner session) can still delete any thread', async () => {
    const r = await forumApp(null, true).request('/api/thread/3', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(ftsRows(60)).toBe(0);
  });

  it('an edit is re-indexed: the old word stops matching, the new word matches', async () => {
    expect(await hits('zebrabefore')).toBe(1);
    const r = await forumApp(null, true).request('/api/message/80', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello zebraafter there' }),
    });
    expect(r.status).toBe(200);
    expect(await hits('zebrabefore')).toBe(0);
    expect(await hits('zebraafter')).toBe(1);
    expect(ftsRows(80)).toBe(1);                            // replaced, not stacked
  });

  it('editing a deleted post does not put it back in search', async () => {
    const r = await forumApp(null, true).request('/api/message/3', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: 'hello zebraresurrect there' }),
    });
    expect(r.status).toBe(200);
    expect(ftsRows(3)).toBe(0);
    expect(await hits('zebraresurrect')).toBe(0);
  });
});
