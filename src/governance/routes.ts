import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';

interface GovernanceHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  addMessage: (threadId: number, role: string, message: string, options?: any) => any;
  sendDm: (from: string, to: string, message: string) => Promise<any>;
  withRetry: <T>(fn: () => T | Promise<T>, maxRetries?: number, delayMs?: number) => Promise<T>;
  wsBroadcast: (event: string, data: any) => void;
}

function decorateRule(rule: any) {
  if (!rule) return rule;
  if (rule.type === 'decree' && rule.approval_status === 'pending') {
    return { ...rule, status: 'pending' };
  }
  if (rule.type === 'decree' && rule.approval_status === 'rejected') {
    return { ...rule, status: 'rejected' };
  }
  if (rule.type === 'decree' && rule.status === 'active' && (rule.approval_status === 'approved' || rule.approval_status === null)) {
    const enforcementLevel = (rule.enforcement || 'must').toLowerCase();
    const keyword = enforcementLevel === 'should' ? 'IMPORTANT: SHOULD' : 'IMPORTANT: MUST';
    return { ...rule, enforcement_text: `${keyword} — ${rule.title}` };
  }
  return rule;
}

export function registerGovernanceRoutes(app: OpenAPIHono, sqlite: Database, helpers: GovernanceHelpers) {
  const { hasSessionAuth, requireBeastIdentity, addMessage, sendDm, withRetry, wsBroadcast } = helpers;

  // GET /api/rules — list rules
  app.get('/api/rules', (c) => {
    const type = c.req.query('type');
    const status = c.req.query('status') || 'active';
    const scope = c.req.query('scope');
    const includePending = c.req.query('include_pending') === 'true';
    let query = 'SELECT * FROM rules WHERE status = ?';
    const params: any[] = [status];
    if (!includePending) { query += " AND (approval_status IS NULL OR approval_status = 'approved')"; }
    if (type) { query += ' AND type = ?'; params.push(type); }
    if (scope) { query += ' AND scope = ?'; params.push(scope); }
    query += " ORDER BY CASE type WHEN 'decree' THEN 0 WHEN 'norm' THEN 1 END, created_at DESC";
    const rules = (sqlite.prepare(query).all(...params) as any[]).map(decorateRule);
    return c.json({ rules, total: rules.length });
  });

  // GET /api/rules/decrees — active approved decrees only
  app.get('/api/rules/decrees', (c) => {
    const rules = (sqlite.prepare("SELECT * FROM rules WHERE type = 'decree' AND status = 'active' AND (approval_status IS NULL OR approval_status = 'approved') ORDER BY created_at DESC").all() as any[]).map(decorateRule);
    return c.json({ rules, total: rules.length });
  });

  // GET /api/rules/pending — pending decrees awaiting Gorn approval
  app.get('/api/rules/pending', (c) => {
    const rules = (sqlite.prepare("SELECT * FROM rules WHERE type = 'decree' AND status = 'active' AND approval_status = 'pending' ORDER BY created_at DESC").all() as any[]).map(decorateRule);
    return c.json({ rules, total: rules.length });
  });

  // POST /api/rules/:id/approve — Gorn approves a decree
  app.post('/api/rules/:id/approve', async (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Only Gorn can approve decrees' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
    if (!rule) return c.json({ error: 'Rule not found' }, 404);
    if (rule.type !== 'decree') return c.json({ error: 'Only decrees need approval' }, 400);
    if (rule.approval_status !== 'pending') return c.json({ error: 'Only pending decrees can be approved' }, 400);
    const now = new Date().toISOString();
    sqlite.prepare('UPDATE rules SET approval_status = ?, approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?')
      .run('approved', 'gorn', now, now, id);
    const author = rule.author?.toLowerCase();
    if (author && author !== 'gorn') {
      const msg = `Decree #${id} "${rule.title}" has been **approved** by Gorn.`;
      if (rule.source_thread_id) {
        try { addMessage(rule.source_thread_id, 'claude', msg, { author: 'system' }); } catch { /* non-critical */ }
      }
      try { await withRetry(() => sendDm('system', author, msg)); } catch { /* non-critical */ }
      wsBroadcast('decree_approved', { id, title: rule.title, author });
    }
    return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
  });

  // POST /api/rules/:id/reject — Gorn rejects a decree
  app.post('/api/rules/:id/reject', async (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Only Gorn can reject decrees' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
    if (!rule) return c.json({ error: 'Rule not found' }, 404);
    if (rule.type !== 'decree') return c.json({ error: 'Only decrees can be rejected' }, 400);
    if (rule.approval_status !== 'pending') return c.json({ error: 'Only pending decrees can be rejected' }, 400);
    try {
      const data = await c.req.json();
      const reason = data.reason || '';
      const now = new Date().toISOString();
      sqlite.prepare('UPDATE rules SET approval_status = ?, rejection_reason = ?, updated_at = ? WHERE id = ?')
        .run('rejected', reason, now, id);
      const author = rule.author?.toLowerCase();
      if (author && author !== 'gorn') {
        const msg = `Decree #${id} "${rule.title}" has been **rejected** by Gorn.${reason ? ` Reason: ${reason}` : ''}`;
        if (rule.source_thread_id) {
          try { addMessage(rule.source_thread_id, 'claude', msg, { author: 'system' }); } catch { /* non-critical */ }
        }
        try { await withRetry(() => sendDm('system', author, msg)); } catch { /* non-critical */ }
        wsBroadcast('decree_rejected', { id, title: rule.title, author, reason });
      }
      return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // GET /api/rules/markdown — all active rules as plain markdown (T#426)
  app.get('/api/rules/markdown', (c) => {
    const rules = (sqlite.prepare("SELECT * FROM rules WHERE status = 'active' AND (approval_status IS NULL OR approval_status = 'approved') ORDER BY CASE type WHEN 'decree' THEN 0 WHEN 'norm' THEN 1 END, created_at DESC").all() as any[]).map(decorateRule);
    const decrees = rules.filter(r => r.type === 'decree');
    const norms = rules.filter(r => r.type === 'norm');
    let md = '';
    if (decrees.length) {
      md += '## Decrees\n\n';
      for (const d of decrees) md += `### ${d.enforcement_text || d.title}\n${d.content}\n\n`;
    }
    if (norms.length) {
      md += '## Norms\n\n';
      for (const n of norms) md += `### SHOULD — ${n.title}\n${n.content}\n\n`;
    }
    if (!rules.length) md = 'No active rules';
    return c.text(md.trim());
  });

  // GET /api/rules/norms — active norms only
  app.get('/api/rules/norms', (c) => {
    const rules = sqlite.prepare("SELECT * FROM rules WHERE type = 'norm' AND status = 'active' ORDER BY created_at DESC").all();
    return c.json({ rules, total: (rules as any[]).length });
  });

  // GET /api/rules/:id — single rule
  app.get('/api/rules/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id);
    if (!rule) return c.json({ error: 'Rule not found' }, 404);
    return c.json(decorateRule(rule));
  });

  // POST /api/rules — create rule
  app.post('/api/rules', async (c) => {
    try {
      const data = await c.req.json();
      const { type, title, content, scope, source_thread_id } = data;
      if (!type || !title || !content) return c.json({ error: 'type, title, content required' }, 400);
      if (!['decree', 'norm'].includes(type)) return c.json({ error: 'type must be decree or norm' }, 400);
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.author && data.author.toLowerCase() !== caller) {
        return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
      }
      const author = caller;
      if (type === 'decree' && !['leonard', 'gorn'].includes(author)) {
        return c.json({ error: 'Only Leonard and Gorn can create decrees' }, 403);
      }
      const enforcement = type === 'decree' ? 'mandatory' : 'recommended';
      const approvalStatus = type === 'decree' && author !== 'gorn' ? 'pending' : (type === 'decree' ? 'approved' : null);
      const approvedBy = type === 'decree' && author === 'gorn' ? 'gorn' : null;
      const approvedAt = type === 'decree' && author === 'gorn' ? new Date().toISOString() : null;
      const now = new Date().toISOString();
      const result = sqlite.prepare(
        'INSERT INTO rules (type, title, content, author, enforcement, scope, source_thread_id, approval_status, approved_by, approved_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(type, title, content, author, enforcement, scope || 'all', source_thread_id || null, approvalStatus, approvedBy, approvedAt, now, now);
      const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get((result as any).lastInsertRowid);
      return c.json(decorateRule(rule), 201);
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // PATCH /api/rules/:id — update rule
  app.patch('/api/rules/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
    if (!rule) return c.json({ error: 'Rule not found' }, 404);
    try {
      const data = await c.req.json();
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      const claimed = (data.author || data.beast || c.req.query('as') || '').toLowerCase();
      if (claimed && claimed !== caller) {
        return c.json({ error: 'Identity spoof blocked. body.author/beast or ?as= must match authenticated caller or be omitted.' }, 403);
      }
      const requester = caller;
      if (rule.type === 'decree' && !['leonard', 'gorn'].includes(requester)) {
        return c.json({ error: 'Only Leonard and Gorn can edit decrees' }, 403);
      }
      if (rule.type === 'norm' && requester !== rule.author && requester !== 'leonard' && requester !== 'gorn') {
        return c.json({ error: 'Only the author or Leonard can edit norms' }, 403);
      }
      const updates: string[] = [];
      const values: any[] = [];
      if (data.title) { updates.push('title = ?'); values.push(data.title); }
      if (data.content) { updates.push('content = ?'); values.push(data.content); }
      if (data.scope) { updates.push('scope = ?'); values.push(data.scope); }
      if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
      updates.push('updated_at = ?'); values.push(new Date().toISOString());
      values.push(id);
      sqlite.prepare(`UPDATE rules SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // PATCH /api/rules/:id/archive — archive rule
  app.patch('/api/rules/:id/archive', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const rule = sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id) as any;
    if (!rule) return c.json({ error: 'Rule not found' }, 404);
    if (rule.status === 'archived') return c.json({ error: 'Already archived' }, 400);
    try {
      const data = await c.req.json();
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      const claimed = (data.author || data.beast || c.req.query('as') || '').toLowerCase();
      if (claimed && claimed !== caller) {
        return c.json({ error: 'Identity spoof blocked. body.author/beast or ?as= must match authenticated caller or be omitted.' }, 403);
      }
      const requester = caller;
      if (rule.type === 'decree' && !['leonard', 'gorn'].includes(requester)) {
        return c.json({ error: 'Only Leonard and Gorn can archive decrees' }, 403);
      }
      if (rule.type === 'norm' && requester !== rule.author && requester !== 'leonard' && requester !== 'gorn') {
        return c.json({ error: 'Only the author or Leonard can archive norms' }, 403);
      }
      const now = new Date().toISOString();
      sqlite.prepare('UPDATE rules SET status = ?, archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ?')
        .run('archived', now, requester, now, id);
      return c.json(decorateRule(sqlite.prepare('SELECT * FROM rules WHERE id = ?').get(id)));
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });
}
