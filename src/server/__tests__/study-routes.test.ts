// T#963 — study area gate + input handling.
// Self-contained: builds its own Hono app on an in-memory SQLite and never
// imports src/db, so it cannot touch ~/.oracle/oracle.db.
import { describe, test, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAPIHono } from '@hono/zod-openapi';
import { registerStudyRoutes, ensureStudyTables, STUDY_MAX_BYTES } from '../../study/routes.ts';

// Mirrors the real middleware outcomes per caller type:
//   owner  — valid owner cookie, role 'owner'
//   guest  — valid guest cookie, role 'guest'
//   beast  — bearer token, no cookie, role 'beast'
//   local  — local-bypass (incl. spoofed XFF 127.0.0.1), no cookie, role 'owner'
//   none   — nothing
type Caller = 'owner' | 'guest' | 'beast' | 'local' | 'none';

let sqlite: Database;
let app: OpenAPIHono;

function build() {
  sqlite = new Database(':memory:');
  ensureStudyTables(sqlite);
  app = new OpenAPIHono();
  app.use('*', async (c, next) => {
    const who = (c.req.header('x-test-caller') || 'none') as Caller;
    if (who === 'owner' || who === 'local') c.set('role' as any, 'owner');
    if (who === 'guest') c.set('role' as any, 'guest');
    if (who === 'beast') c.set('role' as any, 'beast');
    c.set('hasCookie' as any, who === 'owner' || who === 'guest');
    return next();
  });
  registerStudyRoutes(app, sqlite, { hasSessionAuth: (c) => !!(c.get as any)('hasCookie') });
}

function req(who: Caller, method: string, path: string, body?: string) {
  const headers: Record<string, string> = { 'x-test-caller': who };
  if (body != null) headers['Content-Type'] = 'application/json';
  return app.request(path, { method, headers, body });
}

const rows = () => sqlite.prepare('SELECT user, track, data FROM study_progress').all() as any[];

describe('study gate', () => {
  beforeEach(build);

  test('owner session: GET empty → PUT → GET round-trips (positive control)', async () => {
    let r = await req('owner', 'GET', '/api/study/progress/ai');
    expect(r.status).toBe(200);
    expect((await r.json()).data).toBeNull();

    r = await req('owner', 'PUT', '/api/study/progress/ai', JSON.stringify({ data: { read: { 'rag:0': true } } }));
    expect(r.status).toBe(200);

    r = await req('owner', 'GET', '/api/study/progress/ai');
    expect(r.status).toBe(200);
    expect((await r.json()).data).toEqual({ read: { 'rag:0': true } });
  });

  for (const who of ['guest', 'beast', 'local', 'none'] as Caller[]) {
    test(`${who}: GET and PUT are 403 and write nothing`, async () => {
      sqlite.prepare("INSERT INTO study_progress VALUES ('gorn','ai','{\"secret\":1}','x')").run();
      const g = await req(who, 'GET', '/api/study/progress/ai');
      expect(g.status).toBe(403);
      expect(JSON.stringify(await g.json())).not.toContain('secret');
      const p = await req(who, 'PUT', '/api/study/progress/ai', JSON.stringify({ data: { x: 1 } }));
      expect(p.status).toBe(403);
      expect(rows()).toEqual([{ user: 'gorn', track: 'ai', data: '{"secret":1}' }]);
    });
  }
});

describe('study input handling', () => {
  beforeEach(build);

  test('user comes from the session, never the body or query', async () => {
    const r = await req('owner', 'PUT', '/api/study/progress/ai?user=evil',
      JSON.stringify({ user: 'evil', data: { user: 'evil' } }));
    expect(r.status).toBe(200);
    const all = rows();
    expect(all.length).toBe(1);
    expect(all[0].user).toBe('gorn');
    expect(all.filter(x => x.user !== 'gorn')).toEqual([]);
  });

  test('malformed JSON → 400, not 500', async () => {
    const r = await req('owner', 'PUT', '/api/study/progress/ai', '{"data": {');
    expect(r.status).toBe(400);
    expect(rows()).toEqual([]);
  });

  test('data must be a JSON object', async () => {
    for (const body of ['{"data":[1,2]}', '{"data":null}', '{"data":"x"}', '{}', '[]', 'null']) {
      const r = await req('owner', 'PUT', '/api/study/progress/ai', body);
      expect(r.status).toBe(400);
    }
    expect(rows()).toEqual([]);
  });

  test('oversized payload → 413 and nothing written', async () => {
    const big = JSON.stringify({ data: { notes: 'x'.repeat(STUDY_MAX_BYTES) } });
    const r = await req('owner', 'PUT', '/api/study/progress/ai', big);
    expect(r.status).toBe(413);
    expect(rows()).toEqual([]);
  });

  test('track name is validated (no traversal / odd characters)', async () => {
    for (const t of ['..', 'AI', 'a_b', 'x'.repeat(41), '-ai', 'a%27b']) {
      // '..' is normalised away by the URL parser and never matches the route (404)
      const r = await req('owner', 'GET', `/api/study/progress/${t}`);
      expect([400, 404]).toContain(r.status);
    }
  });

  test('injection-shaped strings are stored as data, not executed', async () => {
    const payload = { notes: { k: "'); DROP TABLE study_progress; --" } };
    const r = await req('owner', 'PUT', "/api/study/progress/ai", JSON.stringify({ data: payload }));
    expect(r.status).toBe(200);
    const g = await req('owner', 'GET', '/api/study/progress/ai');
    expect((await g.json()).data).toEqual(payload);
  });
});
