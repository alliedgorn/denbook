import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { queueListRoute, queueAddRoute, queueUpdateRoute } from '../server/openapi.ts';

interface QueueHelpers {
  isTrustedRequest: (c: Context) => boolean;
}

export function registerQueueRoutes(app: OpenAPIHono, sqlite: Database, helpers: QueueHelpers) {
  const { isTrustedRequest } = helpers;

  // Legacy queue endpoints (backwards compat)
  // GET /api/queue/gorn — list queue items
  app.openapi(queueListRoute, ((c: Context) => {
    const status = c.req.query('status') || 'pending'; // pending, decided, deferred, withdrawn
    const rows = sqlite.prepare(`
      SELECT id, title, status, category, queue_status, queue_tagged_by, queue_tagged_at, queue_summary, created_at,
        (SELECT COUNT(*) FROM forum_messages WHERE thread_id = forum_threads.id) as message_count
      FROM forum_threads
      WHERE category = 'gorn-queue' AND queue_status = ?
      ORDER BY CASE WHEN queue_status = 'deferred' THEN 1 ELSE 0 END, queue_tagged_at ASC
    `).all(status) as any[];

    return c.json({
      items: rows.map(r => ({
        thread_id: r.id,
        title: r.title,
        thread_status: r.status,
        queue_status: r.queue_status,
        tagged_by: r.queue_tagged_by,
        tagged_at: r.queue_tagged_at ? new Date(r.queue_tagged_at).toISOString() : null,
        summary: r.queue_summary,
        message_count: r.message_count,
        created_at: new Date(r.created_at).toISOString(),
      })),
      total: rows.length,
    }, 200);
  }) as any);

  // POST /api/queue/gorn — add thread to queue (any Beast can tag)
  // Cast handler: schema validates body shape, but the JSON-parse try/catch
  // branch still emits a 400 from a non-schema-validation path. Runtime
  // preserves the legacy invalid-JSON message. Auth-derivation migration
  // (tagged_by → bearer-derived) scoped to Spec #60 cat-PR.
  app.openapi(queueAddRoute, (async (c: Context) => {
    try {
      const data = await c.req.json();
      if (!data.thread_id) return c.json({ error: 'thread_id required' }, 400);

      const now = Date.now();
      sqlite.prepare(`
        UPDATE forum_threads
        SET category = 'gorn-queue', queue_status = 'pending', queue_tagged_by = ?, queue_tagged_at = ?, queue_summary = ?
        WHERE id = ?
      `).run(data.tagged_by || 'unknown', now, data.summary || null, data.thread_id);

      return c.json({ success: true, thread_id: data.thread_id, queue_status: 'pending' }, 200);
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  }) as any);

  // PATCH /api/queue/gorn/:threadId — update queue status (Decided/Defer/Withdraw — gorn only from browser)
  app.openapi(queueUpdateRoute, (async (c: Context) => {
    const threadId = parseInt(c.req.param('threadId') ?? '', 10);
    try {
      const data = await c.req.json();
      const allowed = ['decided', 'deferred', 'pending', 'withdrawn'];
      if (!data.status || !allowed.includes(data.status)) {
        return c.json({ error: `Invalid status. Allowed: ${allowed.join(', ')}` }, 400);
      }

      // Browser access restricted to gorn
      if (!isTrustedRequest(c)) {
        const as = data.as?.toLowerCase();
        if (as !== 'gorn') return c.json({ error: 'Only Gorn can update queue items' }, 403);
      }

      sqlite.prepare('UPDATE forum_threads SET queue_status = ? WHERE id = ? AND category = ?')
        .run(data.status, threadId, 'gorn-queue');

      return c.json({ success: true, thread_id: threadId, queue_status: data.status }, 200);
    } catch (e) {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  }) as any);
}
