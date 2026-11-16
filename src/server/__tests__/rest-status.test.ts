// Norm #65 rest flag: PATCH /api/beast/:name {"rest_status": ...} must actually
// set rest_status, for the Beast itself or Gorn only, and /wake must clear it.
// Before this fix the field was not in the PATCH list, so the /rest skill's call
// returned 200 and set nothing, and beats kept firing at resting seats.
import { describe, test, expect, beforeEach } from 'bun:test';

// This file imports src/db, which opens ORACLE_DB_PATH. Refuse to run anywhere
// but in memory, so a bare `bun test` can never write the real oracle.db.
if (process.env.ORACLE_DB_PATH !== ':memory:') {
  throw new Error('rest-status.test.ts needs ORACLE_DB_PATH=:memory: (use bun run test:unit)');
}
const { OpenAPIHono } = await import('@hono/zod-openapi');
const { sqlite, upsertBeastProfile } = await import('../../db/index.ts');
const { registerPackRoutes } = await import('../../pack/routes.ts');

// server.ts adds these two columns at boot (lines ~1014-1016), outside the migrations.
try { sqlite.prepare('ALTER TABLE beast_profiles ADD COLUMN sex TEXT DEFAULT NULL').run(); } catch { /* exists */ }
try { sqlite.prepare("ALTER TABLE beast_profiles ADD COLUMN rest_status TEXT DEFAULT 'active'").run(); } catch { /* exists */ }
// /wake touches beast_schedules, which server.ts also creates at boot. Only the
// columns the wake handler reads or writes.
sqlite.prepare(`CREATE TABLE IF NOT EXISTS beast_schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, beast TEXT NOT NULL, interval_seconds INTEGER NOT NULL,
  next_due_at TEXT NOT NULL, enabled INTEGER DEFAULT 1, trigger_status TEXT DEFAULT 'pending',
  updated_at TEXT DEFAULT (datetime('now')))`).run();

let app: InstanceType<typeof OpenAPIHono>;
let broadcasts: Array<{ event: string; data: any }>;

function build() {
  broadcasts = [];
  app = new OpenAPIHono();
  registerPackRoutes(app, sqlite, {
    hasSessionAuth: () => false,
    // Stands in for bearer derivation: the header names the authenticated caller.
    requireBeastIdentity: (c) => c.req.header('x-test-caller') || null,
    isTrustedRequest: () => true,
    wsBroadcast: (event, data) => { broadcasts.push({ event, data }); },
    getTmuxStatus: () => ({ tmuxStatus: new Map(), contextPctMap: new Map() }),
    normalizeAvatarUrl: (u) => u,
    webPresence: new Map(),
    WEB_PRESENCE_TIMEOUT_MS: 0,
  });
  upsertBeastProfile({ name: 'resttest', displayName: 'Resttest', animal: 'test' } as any);
  sqlite.prepare("UPDATE beast_profiles SET rest_status = 'active' WHERE name = 'resttest'").run();
}

function patch(caller: string | null, body: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (caller) headers['x-test-caller'] = caller;
  return app.request('/api/beast/resttest', { method: 'PATCH', headers, body: JSON.stringify(body) });
}

const status = () =>
  (sqlite.prepare("SELECT rest_status FROM beast_profiles WHERE name = 'resttest'").get() as any).rest_status;

describe('rest_status via PATCH /api/beast/:name', () => {
  beforeEach(build);

  test('the Beast itself can set rest, and it is broadcast', async () => {
    const r = await patch('resttest', { rest_status: 'rest' });
    expect(r.status).toBe(200);
    expect(status()).toBe('rest');
    expect(broadcasts).toContainEqual({ event: 'beast_state_change', data: { beast: 'resttest', rest_status: 'rest' } });
  });

  test('rest then /wake round-trips back to active', async () => {
    await patch('resttest', { rest_status: 'rest' });
    expect(status()).toBe('rest');
    const r = await app.request('/api/beast/resttest/wake', { method: 'POST' });
    expect(r.status).toBe(200);
    expect((await r.json()).previous_status).toBe('rest');
    expect(status()).toBe('active');
  });

  test('Gorn can set it', async () => {
    expect((await patch('gorn', { rest_status: 'rest' })).status).toBe(200);
    expect(status()).toBe('rest');
  });

  test('another Beast cannot set it', async () => {
    expect((await patch('bertus', { rest_status: 'rest' })).status).toBe(403);
    expect(status()).toBe('active');
  });

  test('no identity cannot set it', async () => {
    expect((await patch(null, { rest_status: 'rest' })).status).toBe(401);
    expect(status()).toBe('active');
  });

  for (const bad of ['nap', 'sleeping', '', 1, null]) {
    test(`rejects ${JSON.stringify(bad)} and writes nothing`, async () => {
      expect((await patch('resttest', { rest_status: bad })).status).toBe(400);
      expect(status()).toBe('active');
      expect(broadcasts).toEqual([]);
    });
  }

  test('a profile edit without rest_status leaves it alone', async () => {
    await patch('resttest', { rest_status: 'rest' });
    expect((await patch('resttest', { bio: 'hi' })).status).toBe(200);
    expect(status()).toBe('rest');
  });
});
