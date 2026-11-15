// T#883 — POST /api/handoff may only rest the authenticated caller.
import { describe, it, expect, beforeEach, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { OpenAPIHono } from '@hono/zod-openapi';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { registerInboxRoutes } from './routes.ts';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 't883-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

let db: Database;
let app: OpenAPIHono;

function build(actor: string | null) {
  db = new Database(':memory:');
  db.run('CREATE TABLE beast_profiles (name TEXT PRIMARY KEY, rest_status TEXT, updated_at INTEGER)');
  for (const b of ['karo', 'rax']) db.run("INSERT INTO beast_profiles VALUES (?, 'active', 0)", [b]);
  app = new OpenAPIHono();
  registerInboxRoutes(app, db, {
    isTrustedRequest: () => true,          // worst case: every caller is "trusted"
    requireBeastIdentity: () => actor,
    wsBroadcast: () => {},
    repoRoot: root,
  });
}
const post = (q: string) => app.request(`/api/handoff${q}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ content: 'x', slug: 't883' }),
});
const status = (b: string) => (db.query('SELECT rest_status s FROM beast_profiles WHERE name=?').get(b) as any).s;
const files = () => fs.existsSync(path.join(root, 'ψ/inbox/handoff')) ? fs.readdirSync(path.join(root, 'ψ/inbox/handoff')).length : 0;

describe('T#883 handoff rest identity', () => {
  beforeEach(() => fs.rmSync(path.join(root, 'ψ'), { recursive: true, force: true }));

  it('refuses ?as=<other> from an authenticated Beast, writes nothing', async () => {
    build('karo');
    const r = await post('?as=rax');
    expect(r.status).toBe(403);
    expect(status('rax')).toBe('active');
    expect(files()).toBe(0);
  });

  it('refuses ?as= with no identity (the original exploit), writes nothing', async () => {
    build(null);
    const r = await post('?as=rax');
    expect(r.status).toBe(403);
    expect(status('rax')).toBe('active');
    expect(files()).toBe(0);
  });

  it('rests the caller on ?as=<self>', async () => {
    build('karo');
    const r = await post('?as=KARO');
    expect(r.status).toBe(201);
    expect((await r.json()).rested_beast).toBe('karo');
    expect(status('karo')).toBe('rest');
    expect(status('rax')).toBe('active');
  });

  it('without ?as= writes the handoff and rests nobody', async () => {
    build('karo');
    const r = await post('');
    expect(r.status).toBe(201);
    expect((await r.json()).rested_beast).toBe(null);
    expect(status('karo')).toBe('active');
    expect(files()).toBe(1);
  });
});
