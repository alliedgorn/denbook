import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';

const ALLOWED_PROWL_CREATORS = ['gorn', 'sable', 'zaghnal', 'leonard', 'karo'];
const ALLOWED_PROWL_MANAGERS = ['gorn', 'sable', 'karo'];

interface ProwlHelpers {
  hasSessionAuth: (c: Context) => boolean;
  isTrustedRequest: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  wsBroadcast: (event: string, data: any) => void;
  enqueueNotification: (beast: string, message: string) => void;
}

export function registerProwlRoutes(app: OpenAPIHono, sqlite: Database, helpers: ProwlHelpers) {
  const { hasSessionAuth, isTrustedRequest, requireBeastIdentity, wsBroadcast, enqueueNotification } = helpers;

  // GET /api/prowl — list tasks with filters
  app.get('/api/prowl', (c) => {
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session,
    // then restrict to gorn + ALLOWED_PROWL_MANAGERS (mirrors the write-side allowlist).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && !ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can view Prowl tasks` }, 403);
    }
    const status = c.req.query('status') || 'pending';
    const priority = c.req.query('priority');
    const category = c.req.query('category');
    const due = c.req.query('due');

    let query = 'SELECT * FROM prowl_tasks WHERE 1=1';
    const params: any[] = [];

    if (status !== 'all') {
      query += ' AND status = ?';
      params.push(status);
    }
    if (priority) {
      query += ' AND priority = ?';
      params.push(priority);
    }
    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }
    if (due === 'overdue') {
      query += " AND due_date < datetime('now', 'localtime') AND status = 'pending'";
    } else if (due === 'today') {
      query += " AND date(due_date) = date('now', 'localtime')";
    } else if (due === 'week') {
      query += " AND date(due_date) BETWEEN date('now', 'localtime') AND date('now', 'localtime', '+7 days')";
    }

    query += ' ORDER BY CASE priority WHEN \'high\' THEN 0 WHEN \'medium\' THEN 1 WHEN \'low\' THEN 2 END, created_at DESC';

    const rawTasks = sqlite.prepare(query).all(...params) as any[];

    const tasks = rawTasks.map(t => {
      const checklist = sqlite.prepare('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY sort_order, id').all(t.id);
      return { ...t, checklist };
    });

    const counts = {
      pending: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE status = 'pending'").get() as any).c,
      done: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE status = 'done'").get() as any).c,
      overdue: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE due_date < datetime('now', 'localtime') AND status = 'pending'").get() as any).c,
      high: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'high' AND status = 'pending'").get() as any).c,
      medium: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'medium' AND status = 'pending'").get() as any).c,
      low: (sqlite.prepare("SELECT COUNT(*) as c FROM prowl_tasks WHERE priority = 'low' AND status = 'pending'").get() as any).c,
    };

    const categories = (sqlite.prepare("SELECT DISTINCT category FROM prowl_tasks WHERE category IS NOT NULL ORDER BY category").all() as any[]).map(r => r.category);

    return c.json({ tasks, counts, categories });
  });

  // GET /api/prowl/categories — unique categories with counts
  app.get('/api/prowl/categories', (c) => {
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session,
    // then restrict to gorn + ALLOWED_PROWL_MANAGERS.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && !ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can view Prowl tasks` }, 403);
    }
    const rows = sqlite.prepare("SELECT category, COUNT(*) as count FROM prowl_tasks WHERE category IS NOT NULL GROUP BY category ORDER BY count DESC").all();
    return c.json({ categories: rows });
  });

  // POST /api/prowl — create task
  app.post('/api/prowl', async (c) => {
    // T#788 — derive requester from auth-layer (T#718 pattern), reject body-asserted mismatch.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    try {
      const data = await c.req.json();
      if (!data.title?.trim()) return c.json({ error: 'title required' }, 400);

      if (data.created_by && data.created_by.toLowerCase() !== caller) {
        return c.json({ error: 'Sender impersonation blocked. body.created_by must match authenticated caller or be omitted.' }, 403);
      }
      const requester = caller;
      if (!ALLOWED_PROWL_CREATORS.includes(requester)) {
        return c.json({ error: `Only ${ALLOWED_PROWL_CREATORS.join(', ')} can create Prowl tasks` }, 403);
      }

      const priority = ['high', 'medium', 'low'].includes(data.priority) ? data.priority : 'medium';
      const now = new Date().toISOString();

      const validReminders = [null, '1m', '5m', '15m', '30m', '1h', '1d'];
      const remindBefore = validReminders.includes(data.remind_before) ? data.remind_before : null;

      const result = sqlite.prepare(
        'INSERT INTO prowl_tasks (title, priority, category, due_date, status, notes, source, source_id, created_by, remind_before, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(
        data.title.trim(),
        priority,
        data.category || 'general',
        data.due_date || null,
        'pending',
        data.notes || null,
        data.source || 'manual',
        data.source_id ?? null,
        requester,
        remindBefore,
        now,
        now
      );

      const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get((result as any).lastInsertRowid);
      wsBroadcast('prowl_update', { action: 'create' });
      return c.json(task, 201);
    } catch (e: any) {
      return c.json({ error: e?.message || 'Invalid request' }, 400);
    }
  });

  // PATCH /api/prowl/:id — update task fields (T#619: Gorn, Sable, or Karo)
  app.patch('/api/prowl/:id', async (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can update Prowl tasks` }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    try {
      const data = await c.req.json();
      if ('status' in data) return c.json({ error: 'Use PATCH /api/prowl/:id/status to change status' }, 400);

      const allowed = ['title', 'priority', 'category', 'due_date', 'notes', 'remind_before'];
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of allowed) {
        if (field in data) {
          updates.push(`${field} = ?`);
          values.push(data[field]);
        }
      }
      if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);

      updates.push("updated_at = ?");
      values.push(new Date().toISOString());
      values.push(id);

      sqlite.prepare(`UPDATE prowl_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id);
      wsBroadcast('prowl_update', { action: 'update' });
      return c.json(task);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });

  // PATCH /api/prowl/:id/status — change status (T#619: Gorn, Sable, or Karo)
  app.patch('/api/prowl/:id/status', async (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can change Prowl task status` }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    try {
      const data = await c.req.json();
      const newStatus = data.status;
      if (!['pending', 'done'].includes(newStatus)) return c.json({ error: 'status must be pending or done' }, 400);

      const now = new Date().toISOString();
      const completedAt = newStatus === 'done' ? now : null;

      sqlite.prepare('UPDATE prowl_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
        .run(newStatus, completedAt, now, id);
      const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id);
      wsBroadcast('prowl_update', { action: 'status' });
      return c.json(task);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });

  // POST /api/prowl/:id/toggle — quick toggle pending ↔ done (T#619: Gorn, Sable, or Karo)
  app.post('/api/prowl/:id/toggle', async (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can toggle Prowl tasks` }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    const now = new Date().toISOString();
    const newStatus = existing.status === 'pending' ? 'done' : 'pending';
    const completedAt = newStatus === 'done' ? now : null;

    sqlite.prepare('UPDATE prowl_tasks SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?')
      .run(newStatus, completedAt, now, id);
    const task = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id);
    wsBroadcast('prowl_update', { action: 'toggle' });
    return c.json(task);
  });

  // DELETE /api/prowl/:id — delete task (T#619: Gorn, Sable, or Karo)
  app.delete('/api/prowl/:id', async (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can delete Prowl tasks` }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const existing = sqlite.prepare('SELECT * FROM prowl_tasks WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    sqlite.prepare('DELETE FROM prowl_tasks WHERE id = ?').run(id);
    wsBroadcast('prowl_update', { action: 'delete' });
    return c.json({ deleted: true, id });
  });

  // --- Prowl Checklist Items (T#628) ---

  // GET /api/prowl/:id/checklist — list checklist items for a task
  app.get('/api/prowl/:id/checklist', (c) => {
    // T#795 P1 — close localhost-trust read-bypass. Require bearer-token or owner session,
    // then restrict to gorn + ALLOWED_PROWL_MANAGERS.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && !ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can view Prowl tasks` }, 403);
    }
    const taskId = parseInt(c.req.param('id'), 10);
    if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);
    const task = sqlite.prepare('SELECT id FROM prowl_tasks WHERE id = ?').get(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const items = sqlite.prepare('SELECT * FROM checklist_items WHERE task_id = ? ORDER BY sort_order, id').all(taskId);
    return c.json({ items });
  });

  // POST /api/prowl/:id/checklist — add checklist item
  app.post('/api/prowl/:id/checklist', async (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
    }
    const taskId = parseInt(c.req.param('id'), 10);
    if (isNaN(taskId)) return c.json({ error: 'Invalid ID' }, 400);
    const task = sqlite.prepare('SELECT id FROM prowl_tasks WHERE id = ?').get(taskId);
    if (!task) return c.json({ error: 'Task not found' }, 404);
    try {
      const data = await c.req.json();
      if (!data.text?.trim()) return c.json({ error: 'text required' }, 400);
      const now = new Date().toISOString();
      const maxOrder = (sqlite.prepare('SELECT MAX(sort_order) as m FROM checklist_items WHERE task_id = ?').get(taskId) as any)?.m || 0;
      const result = sqlite.prepare(
        'INSERT INTO checklist_items (task_id, text, checked, sort_order, created_at, updated_at) VALUES (?, ?, 0, ?, ?, ?)'
      ).run(taskId, data.text.trim(), maxOrder + 1, now, now);
      const item = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ?').get((result as any).lastInsertRowid);
      wsBroadcast('prowl_update', { action: 'checklist' });
      return c.json(item, 201);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });

  // PATCH /api/prowl/:id/checklist/:itemId — update checklist item (text, checked, sort_order)
  app.patch('/api/prowl/:id/checklist/:itemId', async (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
    }
    const taskId = parseInt(c.req.param('id'), 10);
    const itemId = parseInt(c.req.param('itemId'), 10);
    if (isNaN(taskId) || isNaN(itemId)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ? AND task_id = ?').get(itemId, taskId);
    if (!existing) return c.json({ error: 'Checklist item not found' }, 404);
    try {
      const data = await c.req.json();
      const allowed = ['text', 'checked', 'sort_order'];
      const updates: string[] = [];
      const values: any[] = [];
      for (const field of allowed) {
        if (field in data) {
          updates.push(`${field} = ?`);
          values.push(field === 'checked' ? (data[field] ? 1 : 0) : data[field]);
        }
      }
      if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);
      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(itemId);
      sqlite.prepare(`UPDATE checklist_items SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const item = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ?').get(itemId);
      wsBroadcast('prowl_update', { action: 'checklist' });
      return c.json(item);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });

  // POST /api/prowl/:id/checklist/:itemId/toggle — quick toggle checked
  app.post('/api/prowl/:id/checklist/:itemId/toggle', (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
    }
    const taskId = parseInt(c.req.param('id'), 10);
    const itemId = parseInt(c.req.param('itemId'), 10);
    if (isNaN(taskId) || isNaN(itemId)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ? AND task_id = ?').get(itemId, taskId) as any;
    if (!existing) return c.json({ error: 'Checklist item not found' }, 404);
    const now = new Date().toISOString();
    const newChecked = existing.checked ? 0 : 1;
    sqlite.prepare('UPDATE checklist_items SET checked = ?, updated_at = ? WHERE id = ?').run(newChecked, now, itemId);
    const item = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ?').get(itemId);
    wsBroadcast('prowl_update', { action: 'checklist' });
    return c.json(item);
  });

  // DELETE /api/prowl/:id/checklist/:itemId — delete checklist item
  app.delete('/api/prowl/:id/checklist/:itemId', (c) => {
    // T#788 — derive caller from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (!ALLOWED_PROWL_MANAGERS.includes(caller)) {
      return c.json({ error: `Only ${ALLOWED_PROWL_MANAGERS.join(', ')} can modify Prowl checklists` }, 403);
    }
    const taskId = parseInt(c.req.param('id'), 10);
    const itemId = parseInt(c.req.param('itemId'), 10);
    if (isNaN(taskId) || isNaN(itemId)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM checklist_items WHERE id = ? AND task_id = ?').get(itemId, taskId);
    if (!existing) return c.json({ error: 'Checklist item not found' }, 404);
    sqlite.prepare('DELETE FROM checklist_items WHERE id = ?').run(itemId);
    wsBroadcast('prowl_update', { action: 'checklist' });
    return c.json({ deleted: true, id: itemId });
  });

  // POST /api/prowl/notify-test — test notification pipeline (Gorn-only)
  app.post('/api/prowl/notify-test', (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
    const sessionName = 'Sable';
    const hasSession = Bun.spawnSync(['tmux', 'has-session', '-t', sessionName]);
    if (hasSession.exitCode !== 0) {
      return c.json({ error: 'Sable tmux session not found' }, 503);
    }
    const notification = '[Prowl] TEST: This is a test notification — if Sable receives this and sends Telegram, the pipeline works';
    enqueueNotification('sable', notification);
    return c.json({ success: true, message: 'Test notification sent to Sable' });
  });
}
