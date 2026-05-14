import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';

const ALLOWED_RISK_CREATORS = ['gorn', 'bertus', 'talon'];

interface RiskHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  wsBroadcast: (event: string, data: any) => void;
}

export function registerRiskRoutes(app: OpenAPIHono, sqlite: Database, helpers: RiskHelpers) {
  const { hasSessionAuth, requireBeastIdentity, wsBroadcast } = helpers;

  // GET /api/risks — list risks
  app.get('/api/risks', (c) => {
    const status = c.req.query('status');
    const category = c.req.query('category');
    const severity = c.req.query('severity');
    const likelihood = c.req.query('likelihood');
    const owner = c.req.query('owner');
    const risk_type = c.req.query('risk_type');
    const includeDeleted = c.req.query('deleted') === 'true';

    let query = 'SELECT * FROM risks WHERE 1=1';
    const params: any[] = [];

    if (!includeDeleted) {
      query += ' AND deleted_at IS NULL';
    }
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (category) { query += ' AND category = ?'; params.push(category); }
    if (severity) { query += ' AND severity = ?'; params.push(severity); }
    if (likelihood) { query += ' AND likelihood = ?'; params.push(likelihood); }
    if (owner) { query += ' AND owner = ?'; params.push(owner); }
    if (risk_type) { query += ' AND risk_type = ?'; params.push(risk_type); }

    query += ' ORDER BY risk_score DESC, updated_at DESC';

    const risks = sqlite.prepare(query).all(...params);
    return c.json({ risks });
  });

  // GET /api/risks/summary — dashboard summary
  app.get('/api/risks/summary', (c) => {
    const base = 'FROM risks WHERE deleted_at IS NULL';
    const total = (sqlite.prepare(`SELECT COUNT(*) as c ${base}`).get() as any).c;

    const bySeverity: any = {};
    for (const s of ['critical', 'high', 'medium', 'low', 'info']) {
      bySeverity[s] = (sqlite.prepare(`SELECT COUNT(*) as c ${base} AND severity = ?`).get(s) as any).c;
    }

    const byStatus: any = {};
    for (const s of ['open', 'mitigating', 'accepted', 'mitigated', 'closed']) {
      byStatus[s] = (sqlite.prepare(`SELECT COUNT(*) as c ${base} AND status = ?`).get(s) as any).c;
    }

    const byCategory: any = {};
    const catRows = sqlite.prepare(`SELECT category, COUNT(*) as c ${base} GROUP BY category`).all() as any[];
    for (const r of catRows) byCategory[r.category] = r.c;

    const staleCount = (sqlite.prepare(
      `SELECT COUNT(*) as c ${base} AND status IN ('open','mitigating') AND (reviewed_at IS NULL OR reviewed_at < datetime('now', '-7 days'))`
    ).get() as any).c;

    // Matrix data: count of risks per severity × likelihood
    const matrixRows = sqlite.prepare(
      `SELECT severity, likelihood, COUNT(*) as count ${base} AND status NOT IN ('closed','mitigated') GROUP BY severity, likelihood`
    ).all() as any[];

    return c.json({ total, by_severity: bySeverity, by_status: byStatus, by_category: byCategory, stale_count: staleCount, matrix: matrixRows });
  });

  // GET /api/risks/stale — risks not reviewed in >7 days
  app.get('/api/risks/stale', (c) => {
    const risks = sqlite.prepare(
      "SELECT * FROM risks WHERE deleted_at IS NULL AND status IN ('open','mitigating') AND (reviewed_at IS NULL OR reviewed_at < datetime('now', '-7 days')) ORDER BY risk_score DESC"
    ).all();
    return c.json({ risks });
  });

  // GET /api/risks/:id — single risk
  app.get('/api/risks/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const risk = sqlite.prepare('SELECT * FROM risks WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!risk) return c.json({ error: 'Risk not found' }, 404);
    return c.json(risk);
  });

  // POST /api/risks — create risk (Gorn, Bertus, Talon)
  app.post('/api/risks', async (c) => {
    try {
      const data = await c.req.json();
      if (!data.title?.trim()) return c.json({ error: 'title required' }, 400);

      // T#788 — derive requester from auth-layer (T#718 pattern), reject body-asserted mismatch.
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.created_by && data.created_by.toLowerCase() !== caller) {
        return c.json({ error: 'Sender impersonation blocked. body.created_by must match authenticated caller or be omitted.' }, 403);
      }
      const requester = caller;
      if (!ALLOWED_RISK_CREATORS.includes(requester)) {
        return c.json({ error: `Only ${ALLOWED_RISK_CREATORS.join(', ')} can create risks` }, 403);
      }

      const validSeverity = ['critical', 'high', 'medium', 'low', 'info'];
      const validLikelihood = ['almost_certain', 'likely', 'possible', 'unlikely', 'rare'];
      const validStatus = ['open', 'mitigating', 'accepted', 'mitigated', 'closed'];
      const validSourceType = ['scan', 'audit', 'thread', 'directive', 'external'];
      const validRiskType = ['vulnerability', 'threat', 'operational', 'compliance', 'project'];

      const now = new Date().toISOString();
      const result = sqlite.prepare(
        `INSERT INTO risks (title, description, category, severity, likelihood, impact_notes, status, mitigation, owner, source, source_type, risk_type, thread_id, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        data.title.trim(),
        data.description || null,
        data.category || 'security',
        validSeverity.includes(data.severity) ? data.severity : 'medium',
        validLikelihood.includes(data.likelihood) ? data.likelihood : 'possible',
        data.impact_notes || null,
        validStatus.includes(data.status) ? data.status : 'open',
        data.mitigation || null,
        data.owner || null,
        data.source || null,
        validSourceType.includes(data.source_type) ? data.source_type : 'scan',
        validRiskType.includes(data.risk_type) ? data.risk_type : 'threat',
        data.thread_id ?? null,
        requester,
        now, now
      );

      const risk = sqlite.prepare('SELECT * FROM risks WHERE id = ?').get((result as any).lastInsertRowid) as any;
      wsBroadcast('risk_update', { action: 'create', id: risk.id });
      return c.json(risk, 201);
    } catch (e: any) {
      return c.json({ error: e?.message || 'Invalid request' }, 400);
    }
  });

  // PATCH /api/risks/:id — update risk
  app.patch('/api/risks/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM risks WHERE id = ? AND deleted_at IS NULL').get(id) as any;
    if (!existing) return c.json({ error: 'Risk not found' }, 404);

    // T#788 — derive requester from auth-layer.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    const requester = caller;

    try {
      const data = await c.req.json();

      // Gorn-only fields
      const gornOnly = ['status', 'severity', 'likelihood'];
      for (const field of gornOnly) {
        if (field in data && requester !== 'gorn') {
          return c.json({ error: `Only Gorn can change ${field}` }, 403);
        }
      }

      const allowed = ['title', 'description', 'category', 'severity', 'likelihood', 'impact_notes', 'status', 'mitigation', 'owner', 'source', 'source_type', 'risk_type', 'thread_id', 'reviewed_at'];
      const updates: string[] = [];
      const values: any[] = [];

      for (const field of allowed) {
        if (field in data) {
          updates.push(`${field} = ?`);
          values.push(data[field]);
        }
      }
      if (updates.length === 0) return c.json({ error: 'No valid fields to update' }, 400);

      // Auto-set closed_at when status changes to closed
      if (data.status === 'closed' && existing.status !== 'closed') {
        updates.push('closed_at = ?');
        values.push(new Date().toISOString());
      } else if (data.status && data.status !== 'closed' && existing.closed_at) {
        updates.push('closed_at = ?');
        values.push(null);
      }

      updates.push('updated_at = ?');
      values.push(new Date().toISOString());
      values.push(id);

      sqlite.prepare(`UPDATE risks SET ${updates.join(', ')} WHERE id = ?`).run(...values);
      const risk = sqlite.prepare('SELECT * FROM risks WHERE id = ?').get(id) as any;
      wsBroadcast('risk_update', { action: 'update', id: risk?.id });
      return c.json(risk);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });

  // DELETE /api/risks/:id — soft delete (Gorn only)
  app.delete('/api/risks/:id', async (c) => {
    if (!hasSessionAuth(c)) return c.json({ error: 'Gorn-only' }, 403);
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM risks WHERE id = ? AND deleted_at IS NULL').get(id) as any;
    if (!existing) return c.json({ error: 'Risk not found' }, 404);

    const now = new Date().toISOString();
    sqlite.prepare('UPDATE risks SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, id);
    wsBroadcast('risk_update', { action: 'delete', id: (existing as any).id });
    return c.json({ deleted: true, id });
  });

  // --- Risk Comments (T#323) ---

  // GET /api/risks/:id/comments — list comments for a risk
  app.get('/api/risks/:id/comments', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const risk = sqlite.prepare('SELECT id FROM risks WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!risk) return c.json({ error: 'Risk not found' }, 404);
    const comments = sqlite.prepare('SELECT * FROM risk_comments WHERE risk_id = ? ORDER BY created_at ASC').all(id);
    return c.json({ comments });
  });

  // POST /api/risks/:id/comments — add comment
  app.post('/api/risks/:id/comments', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const risk = sqlite.prepare('SELECT id FROM risks WHERE id = ? AND deleted_at IS NULL').get(id);
    if (!risk) return c.json({ error: 'Risk not found' }, 404);

    try {
      const data = await c.req.json();
      // T#788 — derive author from auth-layer, reject body-asserted mismatch.
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.author && data.author.toLowerCase() !== caller) {
        return c.json({ error: 'Sender impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
      }
      const author = caller;
      if (!data.content?.trim()) return c.json({ error: 'content required' }, 400);

      const contentText = data.content.trim();
      const result = sqlite.prepare(
        'INSERT INTO risk_comments (risk_id, author, content) VALUES (?, ?, ?)'
      ).run(id, author, contentText);

      const comment = sqlite.prepare('SELECT * FROM risk_comments WHERE id = ?').get((result as any).lastInsertRowid);
      wsBroadcast('risk_update', { action: 'comment', risk_id: id });

      // Notify risk owner + previous commenters
      try {
        const riskData = sqlite.prepare('SELECT title, owner FROM risks WHERE id = ?').get(id) as any;
        if (riskData) {
          const { parseMentions, notifyMentioned } = await import('../forum/mentions.ts');
          const toNotify = new Set<string>();
          // Risk owner
          if (riskData.owner && riskData.owner.toLowerCase() !== author) toNotify.add(riskData.owner.toLowerCase());
          // Previous commenters
          const prevCommenters = sqlite.prepare(
            'SELECT DISTINCT author FROM risk_comments WHERE risk_id = ? AND author != ?'
          ).all(id, author) as any[];
          for (const pc of prevCommenters) toNotify.add(pc.author.toLowerCase());
          // @mentions in comment content
          const mentions = parseMentions(contentText, 0);
          for (const m of mentions) toNotify.add(m.toLowerCase());
          toNotify.delete(author);
          toNotify.delete('gorn'); toNotify.delete('human'); toNotify.delete('user');
          if (toNotify.size > 0) {
            notifyMentioned(
              [...toNotify],
              0,
              `Risk #${id}: ${riskData.title || 'Untitled'}`,
              author,
              `New comment on risk #${id}: ${contentText.slice(0, 100)}`,
              { type: 'Risk comment', label: `risk #${id}`, hint: `View at /risk and expand risk #${id} to see comments.` }
            );
          }
        }
      } catch { /* notification failure is non-critical */ }

      return c.json(comment, 201);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });
}
