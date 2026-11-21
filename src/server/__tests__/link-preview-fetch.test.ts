// T#962 — the link-preview fetch must never run Bun's Brotli decoder on bytes
// a remote server chose (CVE-2026-111497, Bun < 1.4.4).
import { describe, it, expect, afterAll } from 'bun:test';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fetchPreviewHtml } from '../../forum/link-preview-fetch.ts';

const HTML = '<html><head><title>Plain page</title></head></html>';
let lastAcceptEncoding: string | null = null;

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    lastAcceptEncoding = req.headers.get('accept-encoding');
    const mode = new URL(req.url).pathname;
    if (mode === '/br') return new Response(brotliCompressSync(Buffer.from(HTML)), { headers: { 'content-encoding': 'br' } });
    if (mode === '/gzip') return new Response(gzipSync(Buffer.from(HTML)), { headers: { 'content-encoding': 'gzip' } });
    if (mode === '/identity') return new Response(HTML, { headers: { 'content-encoding': 'identity' } });
    return new Response(HTML);
  },
});
const base = `http://127.0.0.1:${server.port}`;
afterAll(() => server.stop(true));

describe('fetchPreviewHtml (T#962)', () => {
  it('asks for identity, never advertises br', async () => {
    await fetchPreviewHtml(`${base}/plain`);
    expect(lastAcceptEncoding).toBe('identity');
  });

  it('returns plain HTML unchanged', async () => {
    expect(await fetchPreviewHtml(`${base}/plain`)).toBe(HTML);
    expect(await fetchPreviewHtml(`${base}/identity`)).toBe(HTML);
  });

  it('refuses a br response the server sends anyway, without decoding it', async () => {
    // Behavioural, not a flag check: what came off the wire must be the exact
    // br bytes the server sent, i.e. the decoder never ran on them.
    const sent = new Uint8Array(brotliCompressSync(Buffer.from(HTML)));
    let raw = new Uint8Array();
    const spy = async (url: string, init: RequestInit & { decompress?: boolean }) => {
      const r = await fetch(url, init);
      raw = new Uint8Array(await r.clone().arrayBuffer());
      return r;
    };
    expect(await fetchPreviewHtml(`${base}/br`, spy)).toBeNull();
    expect(raw).toEqual(sent);
  });

  it('refuses gzip too: nothing compressed is parsed', async () => {
    expect(await fetchPreviewHtml(`${base}/gzip`)).toBeNull();
  });

  it('the route uses the helper, not a bare fetch of the user URL', () => {
    const src = readFileSync(path.join(import.meta.dir, '../../forum/routes.ts'), 'utf8');
    const start = src.indexOf("'/api/forum/link-preview'");
    const block = src.slice(start, src.indexOf('app.get(', start + 10));
    expect(block).toContain('fetchPreviewHtml(url)');
    expect(block).not.toMatch(/\bfetch\(url/);
  });
});
