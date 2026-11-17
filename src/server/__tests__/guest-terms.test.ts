// Guest terms flag (Gorn 11-17: "a flag saying whether notified about this terms ... and
// user accepted"). Real guest routes, in-memory DB; a stub middleware stands in for the
// session, which sets guestUsername in the real server.
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAPIHono } from '@hono/zod-openapi';
import { initGuestTables, guestTermsNote, guestTermsAccepted, GUEST_TERMS_VERSION } from '../guest-accounts.ts';
import { registerGuestRoutes } from '../../guest/routes.ts';

let db: Database;
let app: OpenAPIHono;

beforeEach(() => {
  db = new Database(':memory:');
  db.exec('CREATE TABLE forum_threads (id INTEGER PRIMARY KEY, visibility TEXT)');
  initGuestTables(db);
  db.prepare('INSERT INTO guest_accounts (username, password_hash, display_name) VALUES (?, ?, ?)').run('alice', 'x', 'Alice W');
  app = new OpenAPIHono();
  app.use('*', async (c, next) => { c.set('guestUsername' as any, c.req.header('x-test-guest')); return next(); });
  registerGuestRoutes(app, db, {
    wsBroadcast: () => {}, withRetry: async (fn) => fn(),
    getTmuxStatus: () => ({ tmuxStatus: new Map(), contextPctMap: new Map() }),
    normalizeAvatarUrl: (u) => u, uploadsDir: '/nonexistent',
  });
});

const call = (method: string, path: string, body?: unknown) => app.request(path, {
  method, headers: { 'Content-Type': 'application/json', 'x-test-guest': 'alice' },
  body: body === undefined ? undefined : JSON.stringify(body),
});
const row = () => db.prepare('SELECT terms_accepted_at, terms_version FROM guest_accounts WHERE username = ?').get('alice') as any;

describe('guest terms', () => {
  test('a new guest has not accepted, and can read the current terms', async () => {
    const r = await call('GET', '/api/guest/terms');
    expect(r.status).toBe(200);
    const j = await r.json();
    expect(j.accepted).toBe(false);
    expect(j.version).toBe(GUEST_TERMS_VERSION);
    expect(j.text).toContain('can be read by the owner and the Den Beasts');
  });

  test('before accepting, every send route is refused with terms_required', async () => {
    for (const [path, body] of [
      ['/api/guest/dm', { to: 'karo', message: 'hi' }],
      ['/api/guest/thread', { title: 't', message: 'hi' }],
      ['/api/guest/thread/1/message', { message: 'hi' }],
    ] as const) {
      const r = await call('POST', path, body);
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe('terms_required');
    }
  });

  test('accepting old wording is refused and records nothing', async () => {
    const r = await call('POST', '/api/guest/terms/accept', { version: GUEST_TERMS_VERSION - 1 });
    expect(r.status).toBe(409);
    expect(row().terms_accepted_at).toBeNull();
  });

  test('accepting the current version records it; sends then pass the gate (positive control)', async () => {
    const r = await call('POST', '/api/guest/terms/accept', { version: GUEST_TERMS_VERSION });
    expect(r.status).toBe(200);
    expect(row().terms_version).toBe(GUEST_TERMS_VERSION);
    expect((await (await call('GET', '/api/guest/terms')).json()).accepted).toBe(true);
    // Past the gate: thread 1 does not exist, so the route itself answers 404.
    expect((await call('POST', '/api/guest/thread/1/message', { message: 'hi' })).status).toBe(404);
  });

  test('a version bump asks again', () => {
    expect(guestTermsAccepted({ terms_accepted_at: '2026-11-17T00:00:00Z', terms_version: GUEST_TERMS_VERSION })).toBe(true);
    expect(guestTermsAccepted({ terms_accepted_at: '2026-11-17T00:00:00Z', terms_version: GUEST_TERMS_VERSION - 1 })).toBe(false);
    expect(guestTermsAccepted({ terms_accepted_at: null, terms_version: GUEST_TERMS_VERSION })).toBe(false);
  });

  test('the note a Beast sees on a guest DM, matched like the DM key', async () => {
    expect(guestTermsNote(db, 'alice w')).toBe('terms NOT accepted');
    await call('POST', '/api/guest/terms/accept', { version: GUEST_TERMS_VERSION });
    expect(guestTermsNote(db, 'ALICE W')).toMatch(/^terms accepted \d{4}-\d{2}-\d{2}$/);
    expect(guestTermsNote(db, 'alice')).toMatch(/^terms accepted/);
    expect(guestTermsNote(db, 'nobody')).toBeNull();
  });
});

// Bertus, PR 177 review: dropping the upload gate failed no test. Real files route.
import { registerFilesRoutes } from '../../files/routes.ts';
import { listGuests, acceptGuestTerms } from '../guest-accounts.ts';
describe('POST /api/upload for a guest', () => {
  let up: OpenAPIHono;
  beforeEach(() => {
    up = new OpenAPIHono();
    up.use('*', async (c, next) => { c.set('role' as any, 'guest'); c.set('guestUsername' as any, 'alice'); return next(); });
    registerFilesRoutes(up, db, {
      hasSessionAuth: () => true, isTrustedRequest: () => false, isLocalNetwork: () => false,
      verifySessionToken: () => true, uploadsDir: '/nonexistent-upload-dir', sessionCookieName: 'x',
    });
  });
  const upload = () => {
    const fd = new FormData();
    fd.append('file', new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.png', { type: 'image/png' }));
    return up.request('/api/upload', { method: 'POST', body: fd });
  };

  test('refused with terms_required before accepting', async () => {
    const r = await upload();
    expect(r.status).toBe(403);
    expect((await r.json()).code).toBe('terms_required');
  });

  test('after accepting, the terms gate no longer answers (positive control)', async () => {
    acceptGuestTerms(db, (db.prepare("SELECT id FROM guest_accounts WHERE username = 'alice'").get() as any).id);
    const r = await upload();
    const j = await r.json().catch(() => ({}));
    expect(j.code).not.toBe('terms_required');
  });
});

describe('owner guest list', () => {
  test('terms_current is true only for the current version', () => {
    const id = (db.prepare("SELECT id FROM guest_accounts WHERE username = 'alice'").get() as any).id;
    expect(listGuests(db)[0].terms_current).toBe(false);
    acceptGuestTerms(db, id);
    expect(listGuests(db)[0].terms_current).toBe(true);
    db.prepare('UPDATE guest_accounts SET terms_version = ? WHERE id = ?').run(GUEST_TERMS_VERSION - 1, id);
    expect(listGuests(db)[0].terms_current).toBe(false);
  });
});
