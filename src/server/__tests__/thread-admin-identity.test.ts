// T#719 (thread-admin section): every thread-admin handler takes its caller
// from auth, through one shared gate. The 7 PATCH handlers had no identity
// check at all (visibility refused guests only), and DELETE trusted ?as=
// until T#978.
//
// The harness mirrors PRODUCTION auth (server.ts): the token middleware sets
// `actor` for a bearer, the auth middleware sets `role` (owner for local bypass
// and owner sessions, guest for guest sessions), hasSessionAuth is true for ANY
// verified cookie (a guest's too), and requireBeastIdentity returns actor, or
// 'gorn' for any session. A friendlier mock let a guest test pass vacuously on
// PR 154 (Bertus).
import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerForumRoutes } from '../../forum/routes.ts';
// The visibility handler fans out a "New public thread" notification to every
// seat. Under bun test that lands in notifySink (T#981, preload), never on a
// real seat. This file used to mock notify.ts itself after it paged the pack
// at 14:31 on 11-16 (#20 31944).
import { notifySink } from '../../notify.ts';
const sent = notifySink;

let db: Database;

type Caller =
  | { kind: 'none' }                       // local bypass, no token, no cookie
  | { kind: 'bearer'; beast: string }
  | { kind: 'owner' }                      // Gorn's browser session
  | { kind: 'guest' };                     // a guest's browser session

function appFor(who: Caller): OpenAPIHono {
  const session = who.kind === 'owner' || who.kind === 'guest';
  const a = new OpenAPIHono();
  a.use('*', async (c, next) => {
    c.set('role' as any, who.kind === 'guest' ? 'guest' : 'owner');
    if (who.kind === 'bearer') c.set('actor' as any, who.beast);
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

const row = (id = 1) => db.query('SELECT * FROM forum_threads WHERE id = ?').get(id) as any;

// [path suffix, method, body] for each handler. Status writes through the
// global drizzle db, so its row is not checked here; the gate runs before it.
const HANDLERS: Array<{ name: string; method: string; path: string; body?: any; ownerOnly?: boolean; checksRow?: boolean }> = [
  { name: 'category',   method: 'PATCH',  path: '/category',   body: { category: 'decision' }, checksRow: true },
  { name: 'lock',       method: 'PATCH',  path: '/lock',       body: { locked: true }, checksRow: true },
  { name: 'archive',    method: 'PATCH',  path: '/archive',    checksRow: true },
  { name: 'pin',        method: 'PATCH',  path: '/pin',        body: { pinned: true }, checksRow: true },
  { name: 'title',      method: 'PATCH',  path: '/title',      body: { title: 'hijacked' }, checksRow: true },
  { name: 'visibility', method: 'PATCH',  path: '/visibility', body: { visibility: 'public' }, ownerOnly: true, checksRow: true },
  { name: 'status',     method: 'PATCH',  path: '/status',     body: { status: 'closed' } },
  { name: 'delete',     method: 'DELETE', path: '',            checksRow: true },
];

function call(who: Caller, h: typeof HANDLERS[number], id = 1, asGorn = true) {
  const q = asGorn ? '?as=gorn' : '';
  return appFor(who).request(`/api/thread/${id}${h.path}${q}`, {
    method: h.method,
    headers: { 'Content-Type': 'application/json' },
    body: h.body ? JSON.stringify({ ...h.body, beast: 'gorn' }) : undefined,
  });
}

beforeEach(() => {
  sent.length = 0;
  db = new Database(':memory:');
  db.run(`CREATE TABLE forum_threads (id INTEGER PRIMARY KEY, title TEXT, status TEXT, category TEXT,
          created_by TEXT, pinned INTEGER DEFAULT 0, visibility TEXT DEFAULT 'internal',
          deleted_at TEXT, created_at TEXT, updated_at TEXT)`);
  db.run(`CREATE TABLE forum_messages (id INTEGER PRIMARY KEY, thread_id INTEGER, author TEXT, content TEXT,
          created_at TEXT, deleted_at TEXT)`);
  db.run("INSERT INTO forum_threads (id, title, status, category, created_by) VALUES (1, 'security', 'active', 'discussion', 'rax')");
});

describe('T#719 thread-admin gate', () => {
  for (const h of HANDLERS) {
    describe(h.name, () => {
      it('no token, ?as=gorn and body beast=gorn: 401, thread untouched', async () => {
        const before = row();
        const r = await call({ kind: 'none' }, h);
        expect(r.status).toBe(401);
        expect(row()).toEqual(before);
      });

      it('guest session with ?as=gorn: 403, thread untouched', async () => {
        const before = row();
        const r = await call({ kind: 'guest' }, h);
        expect(r.status).toBe(403);
        expect(row()).toEqual(before);
      });

      it('a Beast that is not the creator, with ?as=gorn: 403, thread untouched', async () => {
        const before = row();
        const r = await call({ kind: 'bearer', beast: 'karo' }, h);
        expect(r.status).toBe(403);
        expect(row()).toEqual(before);
      });

      it(`the creator: ${h.ownerOnly ? '403 (Gorn only)' : 'allowed'}`, async () => {
        const before = row();
        const r = await call({ kind: 'bearer', beast: 'rax' }, h, 1, false);
        if (h.ownerOnly) {
          expect(r.status).toBe(403);
          expect(row()).toEqual(before);
        } else {
          expect(r.status).toBe(200);
          if (h.checksRow) expect(row()).not.toEqual(before);
        }
      });

      if (h.ownerOnly) {
        it('refused calls send no notification; a real flip sends them (into the T#981 sink)', async () => {
          await call({ kind: 'none' }, h);
          await call({ kind: 'guest' }, h);
          await call({ kind: 'bearer', beast: 'karo' }, h);
          await call({ kind: 'bearer', beast: 'rax' }, h, 1, false);
          expect(sent.length).toBe(0);
          await call({ kind: 'owner' }, h, 1, false);
          // The flip fanned out, and every send landed in the stub, not on a
          // real seat. > 0 also proves the stub is wired: a miss would mean
          // the real path ran.
          expect(sent.length).toBeGreaterThan(0);
          expect(sent.every(n => n.text.includes('New public thread'))).toBe(true);
        });
      }

      it('Gorn (owner session): allowed (positive control)', async () => {
        const before = row();
        const r = await call({ kind: 'owner' }, h, 1, false);
        expect(r.status).toBe(200);
        if (h.checksRow) expect(row()).not.toEqual(before);
      });

      it('missing thread: 401 without identity (no existence oracle), 404 with it', async () => {
        expect((await call({ kind: 'none' }, h, 999)).status).toBe(401);
        expect((await call({ kind: 'owner' }, h, 999, false)).status).toBe(404);
      });
    });
  }
});
