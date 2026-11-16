// T#981: tests must not reach real seats, real panes, or Gorn.
// Proves the two layers from scripts/test-preload.ts:
//   - SINK (the fix): notifications land in notifySink, and the spawn layer
//     records zero hits. Observed at the spawn layer, not inferred from the
//     sink (Gnarl's review predicate).
//   - TRIPWIRE (the guard): every bypass is blocked AND recorded, and an
//     unconsumed hit fails the whole run.
// Negative controls trip on purpose, assert, then clear the hits so the global
// afterAll stays green.
import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAPIHono } from '@hono/zod-openapi';
import path from 'path';
import { execSync as namedExecSync } from 'node:child_process';
import * as cpNamespace from 'child_process';
import { enqueueNotification, deliverToPane, notifySink } from '../../notify.ts';
import { registerForumRoutes } from '../../forum/routes.ts';
import { registerPackRoutes } from '../../pack/routes.ts';

const hits = (): Array<{ via: string; what: string }> => (globalThis as any).__denTripwire.hits;
const clearHits = () => { hits().length = 0; };
afterEach(() => { notifySink.length = 0; });

describe('T#981 sink (the fix)', () => {
  it('the preload turns the sink on', () => {
    expect(process.env.DEN_NOTIFY_SINK).toBe('memory');
    expect((globalThis as any).__denTripwire).toBeDefined();
  });

  it('enqueueNotification lands in the sink with zero spawns', () => {
    expect(hits().length).toBe(0);
    expect(enqueueNotification('karo', 'hello from a test')).toBe(true);
    expect(notifySink).toEqual([{ via: 'enqueue', target: 'karo', text: 'hello from a test' }]);
    expect(hits().length).toBe(0);
  });

  it('deliverToPane lands in the sink with zero spawns', () => {
    expect(deliverToPane('Karo', 'typed text')).toBe('sent');
    expect(notifySink[0]).toEqual({ via: 'pane', target: 'Karo', text: 'typed text' });
    expect(hits().length).toBe(0);
  });

  it("an UNSTUBBED notifying handler (today's incident path) reaches the sink, not a seat", async () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE forum_threads (id INTEGER PRIMARY KEY, title TEXT, status TEXT, category TEXT,
            created_by TEXT, pinned INTEGER DEFAULT 0, visibility TEXT DEFAULT 'internal',
            deleted_at TEXT, created_at TEXT, updated_at TEXT)`);
    db.run("INSERT INTO forum_threads (id, title, created_by) VALUES (1, 'sink fixture', 'rax')");
    const app = new OpenAPIHono();
    app.use('*', async (c, next) => { c.set('role' as any, 'owner'); await next(); });
    registerForumRoutes(app, db, {
      hasSessionAuth: () => true,
      requireBeastIdentity: () => 'gorn',
      isTrustedRequest: () => true,
      wsBroadcast: () => {},
      withRetry: async (fn) => fn(),
      getSupportedEmoji: () => new Set(),
    });
    const r = await app.request('/api/thread/1/visibility', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visibility: 'public' }),
    });
    expect(r.status).toBe(200);
    expect(notifySink.length).toBeGreaterThan(0);
    expect(notifySink.every(n => n.text.includes('New public thread: sink fixture'))).toBe(true);
    expect(hits().length).toBe(0);
  });
});

describe('T#981 tripwire (the guard), negative controls', () => {
  it('Bun.spawnSync naming tmux is blocked and recorded', () => {
    expect(() => Bun.spawnSync(['tmux', 'list-sessions'])).toThrow(/test tripwire/);
    expect(hits().map(h => h.via)).toEqual(['Bun.spawnSync']);
    clearHits();
  });

  it('Bun.spawn naming notify.sh is blocked and recorded', () => {
    expect(() => Bun.spawn(['bash', '/home/gorn/workspace/karo/scripts/notify.sh', 'x'])).toThrow(/test tripwire/);
    expect(hits().length).toBe(1);
    clearHits();
  });

  it("child_process via a NAMED import (import { execSync } from 'node:child_process') is blocked", () => {
    expect(() => namedExecSync('tmux has-session -t Karo')).toThrow(/test tripwire/);
    expect(hits()[0].via).toBe('child_process.execSync');
    clearHits();
  });

  it("child_process via a NAMESPACE import of 'child_process' is blocked, argv form too", () => {
    expect(() => cpNamespace.execFileSync('tmux', ['send-keys', '-t', 'Karo', 'x'])).toThrow(/test tripwire/);
    expect(hits()[0].via).toBe('child_process.execFileSync');
    clearHits();
  });

  it('a harmless spawn still runs (the tripwire is targeted, not a blanket ban)', () => {
    expect(Bun.spawnSync(['true']).exitCode).toBe(0);
    expect(namedExecSync('echo ok', { encoding: 'utf-8' }).trim()).toBe('ok');
    expect(hits().length).toBe(0);
  });

  it('fetch to a non-loopback host (Telegram) is blocked and recorded', async () => {
    await expect(fetch('https://api.telegram.org/botX/getMe')).rejects.toThrow(/test tripwire/);
    expect(hits()).toEqual([{ via: 'fetch', what: 'api.telegram.org' }]);
    clearHits();
  });

  it('pack /terminal/input writes to panes directly (not via notify): the tripwire catches it', async () => {
    const app = new OpenAPIHono();
    registerPackRoutes(app, new Database(':memory:'), {
      hasSessionAuth: () => true,
      requireBeastIdentity: () => 'gorn',
      isTrustedRequest: () => true,
      wsBroadcast: () => {},
      getTmuxStatus: () => ({ tmuxStatus: {}, contextPctMap: {} }),
      normalizeAvatarUrl: (u: string) => u,
      webPresence: new Map(),
      WEB_PRESENCE_TIMEOUT_MS: 0,
    } as any);
    const r = await app.request('/api/beast/karo/terminal/input', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys: 'typed by a test' }),
    });
    // The route swallows the error into a 404. That is why the tripwire
    // RECORDS: a throw alone would pass green.
    expect(r.status).toBe(404);
    expect(hits().length).toBeGreaterThan(0);
    expect(hits().every(h => /tmux/.test(h.what))).toBe(true);
    clearHits();
  });

  it('with the sink OFF, notify goes for notify.sh then tmux, and the tripwire catches both', () => {
    const saved = process.env.DEN_NOTIFY_SINK;
    delete process.env.DEN_NOTIFY_SINK;
    try {
      expect(enqueueNotification('karo', 'would page a real seat')).toBe(false);
    } finally {
      process.env.DEN_NOTIFY_SINK = saved;
    }
    const whats = hits().map(h => h.what);
    expect(whats.some(w => w.includes('notify.sh'))).toBe(true);
    expect(whats.some(w => w.includes('tmux'))).toBe(true);
    expect(notifySink.length).toBe(0);
    clearHits();
  });
});

describe('T#981 the run itself (child bun test processes)', () => {
  const fixture = path.join(import.meta.dir, 'fixtures', 'tripwire-leak.fixture.ts');
  const quiet = path.join(import.meta.dir, 'json-fail-clean.test.ts');
  const childEnv = (extra: Record<string, string> = {}) => {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith('TELEGRAM_')) env[k] = v;
    return { ...env, ...extra };
  };

  it('an unconsumed trip fails the whole run (the global afterAll)', () => {
    const r = Bun.spawnSync(['bun', 'test', fixture], { env: childEnv(), cwd: path.join(import.meta.dir, '../../..') });
    expect(r.exitCode).not.toBe(0);
    expect(r.stderr.toString() + r.stdout.toString()).toContain('[test tripwire] 1 blocked side effect');
  }, 30000);

  for (const key of ['TELEGRAM_BOTS', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID']) {
    it(`refuses to start when ${key} is set (any one of the three)`, () => {
      const r = Bun.spawnSync(['bun', 'test', quiet], { env: childEnv({ [key]: 'x' }), cwd: path.join(import.meta.dir, '../../..') });
      expect(r.exitCode).toBe(1);
      const out = r.stderr.toString();
      expect(out).toContain('REFUSING to run');
      expect(out).toContain(key);
      expect(out).not.toContain('x\n');   // names only, never the value
    }, 30000);
  }

  it('refuses a sink value other than memory', () => {
    const r = Bun.spawnSync(['bun', 'test', quiet], { env: childEnv({ DEN_NOTIFY_SINK: 'off' }), cwd: path.join(import.meta.dir, '../../..') });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toContain("DEN_NOTIFY_SINK must be 'memory'");
  }, 30000);
});
