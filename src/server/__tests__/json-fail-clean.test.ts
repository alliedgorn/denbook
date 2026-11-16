/**
 * Unit tests for the malformed-JSON fail-clean middleware (T#954).
 *
 * Exercises the real `jsonFailClean()` via Hono's in-process `app.request()` —
 * no server spin-up. Proves: malformed → clean 400 (not the handler's 500),
 * valid → handler runs AND can still read the body (clone didn't consume the
 * stream), non-JSON / body-less pass through, and coexistence with a preceding
 * audit-style `c.req.raw.clone()` read.
 */

import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import { jsonFailClean } from '../json-fail-clean.ts';

// A handler that mirrors the ~85 real sites: reads c.req.json() inside a
// try/catch that returns 500 for ALL throws (the exact bug pattern).
function buildApp(withAuditClone = false) {
  const app = new Hono();
  if (withAuditClone) {
    // Mimic the audit middleware: clone + read the body for logging BEFORE the
    // guard runs. Must not conflict with the guard's own clone or the handler's read.
    app.use('/api/*', async (c, next) => {
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(c.req.method)) {
        await c.req.raw.clone().json().catch(() => null);
      }
      await next();
    });
  }
  app.use('/api/*', jsonFailClean());
  app.post('/api/thing', async (c) => {
    try {
      const data = await c.req.json();
      return c.json({ ok: true, got: data }, 200);
    } catch {
      return c.json({ error: 'server' }, 500); // the bug pattern: any throw → 500
    }
  });
  app.post('/api/form', async (c) => {
    const body = await c.req.parseBody();
    return c.json({ ok: true, form: Object.keys(body) }, 200);
  });
  app.post('/api/nobody', (c) => c.json({ ok: true }, 200));
  return app;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

describe('jsonFailClean middleware (T#954)', () => {
  test('malformed JSON body → clean 400, not the handler 500', async () => {
    const app = buildApp();
    const res = await app.request('/api/thing', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: '{"broken": ', // truncated → parse error
    });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toBe('Malformed JSON body');
    expect(typeof data.detail).toBe('string'); // parse message echoed back
  });

  test('valid JSON → handler runs AND can still read the body (clone did not consume the stream)', async () => {
    const app = buildApp();
    const res = await app.request('/api/thing', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ hello: 'world' }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.got).toEqual({ hello: 'world' }); // handler's own c.req.json() succeeded
  });

  test('coexists with a preceding audit-style raw clone — both reads succeed, malformed still 400s', async () => {
    const app = buildApp(true);
    const ok = await app.request('/api/thing', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({ a: 1 }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).got).toEqual({ a: 1 });

    const bad = await app.request('/api/thing', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: 'not json at all',
    });
    expect(bad.status).toBe(400);
  });

  test('non-JSON content-type (multipart form) passes straight through', async () => {
    const app = buildApp();
    const form = new FormData();
    form.append('field', 'value');
    const res = await app.request('/api/form', { method: 'POST', body: form });
    expect(res.status).toBe(200);
    expect((await res.json()).form).toContain('field');
  });

  test('body-less POST (no content-length) passes straight through', async () => {
    const app = buildApp();
    const res = await app.request('/api/nobody', { method: 'POST' });
    expect(res.status).toBe(200);
  });

  test('GET is never touched', async () => {
    const app = buildApp();
    app.get('/api/thing', (c) => c.json({ ok: true }, 200));
    const res = await app.request('/api/thing', { method: 'GET' });
    expect(res.status).toBe(200);
  });
});
