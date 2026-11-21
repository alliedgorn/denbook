// T#859 / T#857 / T#846: the client-IP helper is the only place that reads
// forwarding headers. These tests pin the rules (client-ip.ts header comment)
// and the last block fails if any route goes back to reading them inline.
import { describe, it, expect } from 'bun:test';
import { Hono } from 'hono';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { clientIp, clientIpFrom, isLocalFrom, isLocalRequest, isLoopback } from '../client-ip.ts';

const H = (h: Record<string, string>) => (n: string) => h[n.toLowerCase()] ?? null;
// The address Caddy writes into X-Forwarded-For for an outside caller.
const EDGE = '203.0.113.7';

describe('isLoopback', () => {
  it('accepts 127/8, ::1 and v4-mapped loopback', () => {
    for (const a of ['127.0.0.1', '127.1.2.3', '::1', '::ffff:127.0.0.1', 'localhost']) expect(isLoopback(a)).toBe(true);
  });
  it('rejects private ranges and junk', () => {
    for (const a of ['10.0.0.1', '192.168.1.1', '172.16.0.1', '::ffff:10.0.0.1', '127.0.0.1.evil', '', undefined]) expect(isLoopback(a as any)).toBe(false);
  });
});

describe('clientIpFrom', () => {
  it('direct local call: the peer', () => {
    expect(clientIpFrom(H({}), '127.0.0.1')).toBe('127.0.0.1');
  });
  it('through the proxy: the RIGHTMOST X-Forwarded-For entry, the one the proxy wrote', () => {
    expect(clientIpFrom(H({ 'x-forwarded-for': EDGE }), '127.0.0.1')).toBe(EDGE);
    expect(clientIpFrom(H({ 'x-forwarded-for': `1.1.1.1, 2.2.2.2, ${EDGE}` }), '127.0.0.1')).toBe(EDGE);
  });
  it('T#859: rotating the client-controlled parts does not change the key', () => {
    const keys = new Set([
      clientIpFrom(H({ 'x-forwarded-for': EDGE }), '127.0.0.1'),
      clientIpFrom(H({ 'x-forwarded-for': `9.9.9.1, ${EDGE}`, 'x-real-ip': '9.9.9.2' }), '127.0.0.1'),
      clientIpFrom(H({ 'x-forwarded-for': `9.9.9.3, ${EDGE}`, 'x-real-ip': '127.0.0.1' }), '127.0.0.1'),
    ]);
    expect([...keys]).toEqual([EDGE]);
  });
  it('X-Real-IP is never read', () => {
    expect(clientIpFrom(H({ 'x-real-ip': '9.9.9.9' }), '127.0.0.1')).toBe('127.0.0.1');
  });
  it('a non-loopback peer is the answer, whatever the headers say', () => {
    expect(clientIpFrom(H({ 'x-forwarded-for': '127.0.0.1' }), '198.51.100.4')).toBe('198.51.100.4');
  });
  it('unknown peer with no headers: the fallback', () => {
    expect(clientIpFrom(H({}), undefined, 'local')).toBe('local');
  });
});

describe('isLocalFrom', () => {
  it('loopback peer, no forwarding header: local', () => {
    expect(isLocalFrom(H({}), '127.0.0.1')).toBe(true);
    expect(isLocalFrom(H({}), '::1')).toBe(true);
  });
  it('T#846: anything forwarded is remote, even when it claims loopback', () => {
    for (const h of [
      { 'x-forwarded-for': '127.0.0.1' },
      { 'x-forwarded-for': '127.0.0.1, 127.0.0.1' },
      { 'x-real-ip': '127.0.0.1' },
      { forwarded: 'for=127.0.0.1' },
      { 'x-forwarded-host': 'denbook.online' },
      { 'x-forwarded-proto': 'https' },
      { 'x-forwarded-for': '192.168.1.5' },
    ]) expect(isLocalFrom(H(h), '127.0.0.1')).toBe(false);
  });
  it('a non-loopback peer is never local, including private ranges', () => {
    for (const p of ['192.168.1.5', '10.0.0.2', '172.20.0.1', '198.51.100.4']) expect(isLocalFrom(H({}), p)).toBe(false);
  });
});

describe('Hono wrappers read the socket peer from env.ip', () => {
  const app = new Hono();
  app.get('/ip', c => c.json({ ip: clientIp(c), local: isLocalRequest(c) }));
  const get = (headers: Record<string, string>, ip?: string) =>
    Promise.resolve(app.request('/ip', { headers }, ip ? { ip } : undefined)).then(r => r.json() as Promise<{ ip: string; local: boolean }>);

  it('direct local', async () => {
    expect(await get({}, '127.0.0.1')).toEqual({ ip: '127.0.0.1', local: true });
  });
  it('edge call with spoofed loopback headers', async () => {
    expect(await get({ 'x-forwarded-for': `127.0.0.1, ${EDGE}`, 'x-real-ip': '127.0.0.1' }, '127.0.0.1')).toEqual({ ip: EDGE, local: false });
  });
  it('no socket (in-process): headers still make it remote', async () => {
    expect(await get({ 'x-forwarded-for': '127.0.0.1' })).toEqual({ ip: '127.0.0.1', local: false });
  });
});

describe('no route reads forwarding headers inline (regression guard)', () => {
  it('only client-ip.ts names x-real-ip or x-forwarded-for', () => {
    const root = path.join(import.meta.dir, '..', '..');
    const hits: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = path.join(d, f);
        if (statSync(p).isDirectory()) { if (f !== '__tests__' && f !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(f) || /\.test\.tsx?$/.test(f) || p.endsWith(path.join('server', 'client-ip.ts'))) continue;
        readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
          if (/['"`]x-(real-ip|forwarded-for)['"`]/i.test(line)) hits.push(`${path.relative(root, p)}:${i + 1}`);
        });
      }
    };
    walk(root);
    expect(hits).toEqual([]);
  });
});
