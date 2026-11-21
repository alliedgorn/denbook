// T#935 — a Beast reads its own token chain without presenting any ancestor.
import { describe, it, expect, beforeEach } from 'bun:test';
import { Hono } from 'hono';
import { sqlite } from '../../db/index.ts';
import { createToken, selfRotateToken, getTokenChain } from '../beast-tokens.ts';

beforeEach(() => { sqlite.exec('DELETE FROM beast_tokens'); });

function mint(beast: string, by: string): number {
  const r = createToken(beast, by);
  if (!('id' in r)) throw new Error('mint failed');
  return r.id;
}
function rotate(id: number, beast: string): number {
  const r = selfRotateToken(id, beast);
  if (!('id' in r)) throw new Error('rotate failed: ' + JSON.stringify(r));
  return r.id;
}

describe('getTokenChain', () => {
  it('owner-issued root, two self-rotations: root -> head, root_issued_by gorn, not truncated', () => {
    const a = mint('karo', 'gorn');
    const b = rotate(a, 'karo');
    const c = rotate(b, 'karo');
    const r = getTokenChain(c, 'karo')!;
    expect(r.chain.map(l => l.id)).toEqual([a, b, c]);
    expect(r.chain[0].created_by).toBe('gorn');
    expect(r.root_issued_by).toBe('gorn');
    expect(r.truncated).toBe(false);
    expect(r.chain[0].next_token_id).toBe(b);
    expect(r.chain[2].rotated_at).toBeNull();
  });

  it('never returns a hash or a token value', () => {
    const a = mint('karo', 'gorn');
    const r = getTokenChain(a, 'karo')!;
    const keys = Object.keys(r.chain[0]).sort();
    expect(keys).toEqual(['created_at', 'created_by', 'expires_at', 'id', 'next_token_id', 'revoked_at', 'rotated_at']);
    expect(JSON.stringify(r)).not.toMatch(/den_|token_hash/);
  });

  it('a pruned parent shows as truncated: the oldest row left was self-minted', () => {
    const a = mint('karo', 'gorn');
    const b = rotate(a, 'karo');
    const c = rotate(b, 'karo');
    sqlite.prepare('DELETE FROM beast_tokens WHERE id = ?').run(a);
    const r = getTokenChain(c, 'karo')!;
    expect(r.chain.map(l => l.id)).toEqual([b, c]);
    expect(r.root_issued_by).toBeNull();
    expect(r.truncated).toBe(true);
  });

  it('stays on the caller: another beast linked into the chain is not followed', () => {
    const k = mint('karo', 'gorn');
    const x = mint('rax', 'gorn');
    // Corrupt link: rax's row claims karo's head as its successor.
    sqlite.prepare('UPDATE beast_tokens SET next_token_id = ? WHERE id = ?').run(k, x);
    const r = getTokenChain(k, 'karo')!;
    expect(r.chain.map(l => l.id)).toEqual([k]);
  });

  it('a head that belongs to someone else returns null', () => {
    const k = mint('karo', 'gorn');
    expect(getTokenChain(k, 'rax')).toBeNull();
  });

  it('a link cycle terminates', () => {
    const a = mint('karo', 'gorn');
    const b = rotate(a, 'karo');
    sqlite.prepare('UPDATE beast_tokens SET next_token_id = ? WHERE id = ?').run(a, b);
    const r = getTokenChain(b, 'karo')!;
    expect(r.chain.length).toBe(2);
  });
});

describe('GET /api/auth/chain', () => {
  // Mirror the production gate: bearer middleware sets authMethod, actor, tokenId.
  // routes.ts imports server.ts, so the handler is mirrored here and pinned to
  // the source by the last test.
  const app = new Hono();
  app.use('*', async (c, next) => {
    const h = c.req.header('x-test-ctx');
    if (h) for (const [k, v] of Object.entries(JSON.parse(h))) c.set(k as any, v);
    await next();
  });
  // Same body as routes.ts (kept in step by the source check below).
  app.get('/api/auth/chain', (c) => {
    const authMethod = (c.get as any)('authMethod');
    const beast = (c.get as any)('actor') as string;
    const tokenId = (c.get as any)('tokenId') as number;
    if (authMethod !== 'token' || !beast || !tokenId) return c.json({ error: 'Bearer-token Beast identity required' }, 403);
    const result = getTokenChain(tokenId, beast);
    if (!result) return c.json({ error: 'Token not found' }, 404);
    return c.json(result);
  });
  const req = (ctx?: Record<string, unknown>) =>
    Promise.resolve(app.request('/api/auth/chain', { headers: ctx ? { 'x-test-ctx': JSON.stringify(ctx) } : {} }));

  it('no bearer (owner session or local bypass): 403', async () => {
    expect((await req()).status).toBe(403);
    expect((await req({ authMethod: 'session', actor: 'gorn' })).status).toBe(403);
  });
  it('bearer: own chain', async () => {
    const a = mint('karo', 'gorn');
    const b = rotate(a, 'karo');
    const res = await req({ authMethod: 'token', actor: 'karo', tokenId: b });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).chain.map((l: any) => l.id)).toEqual([a, b]);
  });
  it('the handler in routes.ts is the one tested here', async () => {
    const src = await Bun.file(new URL('../routes.ts', import.meta.url)).text();
    expect(src).toContain("app.get('/api/auth/chain'");
    expect(src).toContain("if (authMethod !== 'token' || !beast || !tokenId)");
    expect(src).toContain('const result = getTokenChain(tokenId, beast);');
  });
});
