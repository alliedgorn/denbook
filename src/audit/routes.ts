import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { SECURITY_RETENTION_DAYS } from '../server/security-logger.ts';

const AUDIT_READ_ALLOWLIST = ['bertus', 'talon'];
// Security events access: Gorn (session) or security team (local trusted + allowlist).
// T#648: ?as= requires isTrustedRequest to mitigate spoofing (Risk #12) — remote ?as= is rejected.
const SECURITY_READ_ALLOWLIST = ['bertus', 'talon'];

interface AuditHelpers {
  hasSessionAuth: (c: Context) => boolean;
  isTrustedRequest: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
}

export function registerAuditRoutes(app: OpenAPIHono, sqlite: Database, helpers: AuditHelpers) {
  const { hasSessionAuth, isTrustedRequest, requireBeastIdentity } = helpers;

  app.get('/api/audit', (c) => {
    // T#808 — requireBeastIdentity cascade replaces ?as= + isTrustedRequest read-bypass.
    // Closes localhost-host attacker pretending bertus/talon via ?as= query param.
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && !AUDIT_READ_ALLOWLIST.includes(caller)) {
      return c.json({ error: 'Audit logs are restricted to Gorn and security team' }, 403);
    }

    const actor = c.req.query('actor');
    const resourceType = c.req.query('resource_type');
    const statusCode = c.req.query('status_code');
    const method = c.req.query('method');
    const requestId = c.req.query('request_id');
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');
    const since = c.req.query('since');

    let query = 'SELECT * FROM audit_log WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as count FROM audit_log WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];

    if (actor) { query += ' AND actor = ?'; countQuery += ' AND actor = ?'; params.push(actor); countParams.push(actor); }
    if (resourceType) { query += ' AND resource_type = ?'; countQuery += ' AND resource_type = ?'; params.push(resourceType); countParams.push(resourceType); }
    if (statusCode) { query += ' AND status_code = ?'; countQuery += ' AND status_code = ?'; params.push(parseInt(statusCode)); countParams.push(parseInt(statusCode)); }
    if (method) { query += ' AND request_method = ?'; countQuery += ' AND request_method = ?'; params.push(method.toUpperCase()); countParams.push(method.toUpperCase()); }
    if (requestId) { query += ' AND request_id = ?'; countQuery += ' AND request_id = ?'; params.push(requestId); countParams.push(requestId); }
    if (since) { query += ' AND datetime(timestamp) >= datetime(?)'; countQuery += ' AND datetime(timestamp) >= datetime(?)'; params.push(since); countParams.push(since); }
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.count || 0;
    const rows = sqlite.prepare(query).all(...params) as any[];
    return c.json({ audit: rows, total, limit, offset });
  });

  // GET /api/audit/stats — summary counts
  app.get('/api/audit/stats', (c) => {
    // T#808 — requireBeastIdentity cascade (replaces ?as= + isTrustedRequest read-bypass).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && !AUDIT_READ_ALLOWLIST.includes(caller)) {
      return c.json({ error: 'Audit stats are restricted to Gorn and security team' }, 403);
    }

    const total = (sqlite.prepare('SELECT COUNT(*) as count FROM audit_log').get() as any)?.count || 0;
    const denied = (sqlite.prepare("SELECT COUNT(*) as count FROM audit_log WHERE status_code = 403").get() as any)?.count || 0;
    const errors = (sqlite.prepare("SELECT COUNT(*) as count FROM audit_log WHERE status_code >= 500").get() as any)?.count || 0;
    const byActor = sqlite.prepare('SELECT actor, COUNT(*) as count FROM audit_log GROUP BY actor ORDER BY count DESC LIMIT 10').all();
    const byResource = sqlite.prepare('SELECT resource_type, COUNT(*) as count FROM audit_log GROUP BY resource_type ORDER BY count DESC LIMIT 10').all();
    const byMethod = sqlite.prepare('SELECT request_method, COUNT(*) as count FROM audit_log GROUP BY request_method ORDER BY count DESC').all();
    return c.json({ total, denied, errors, by_actor: byActor, by_resource: byResource, by_method: byMethod });
  });

  // GET /api/security/events — query security events
  app.get('/api/security/events', (c) => {
    // T#808 — requireBeastIdentity cascade (replaces ?as= + isTrustedRequest read-bypass).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && !SECURITY_READ_ALLOWLIST.includes(caller)) {
      return c.json({ error: 'Security events are restricted to Gorn and security team' }, 403);
    }

    const eventType = c.req.query('event_type');
    const severity = c.req.query('severity');
    const actor = c.req.query('actor');
    const since = c.req.query('since');
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');

    let query = 'SELECT * FROM security_events WHERE 1=1';
    let countQuery = 'SELECT COUNT(*) as count FROM security_events WHERE 1=1';
    const params: any[] = [];
    const countParams: any[] = [];

    if (eventType) { query += ' AND event_type = ?'; countQuery += ' AND event_type = ?'; params.push(eventType); countParams.push(eventType); }
    if (severity) { query += ' AND severity = ?'; countQuery += ' AND severity = ?'; params.push(severity); countParams.push(severity); }
    if (actor) { query += ' AND actor = ?'; countQuery += ' AND actor = ?'; params.push(actor); countParams.push(actor); }
    if (since) {
      const sinceEpoch = Math.floor(new Date(since).getTime() / 1000);
      query += ' AND timestamp >= ?'; countQuery += ' AND timestamp >= ?';
      params.push(sinceEpoch); countParams.push(sinceEpoch);
    }
    query += ' ORDER BY timestamp DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const total = (sqlite.prepare(countQuery).get(...countParams) as any)?.count || 0;
    const rows = sqlite.prepare(query).all(...params) as any[];

    // Parse details JSON for convenience
    const events = rows.map(r => ({
      ...r,
      details: r.details ? JSON.parse(r.details) : null,
      timestamp_iso: new Date(r.timestamp * 1000).toISOString(),
    }));

    return c.json({ events, total, limit, offset });
  });

  // GET /api/security/events/stats — summary counts
  app.get('/api/security/events/stats', (c) => {
    // T#808 — requireBeastIdentity cascade (replaces ?as= + isTrustedRequest read-bypass).
    const caller = requireBeastIdentity(c);
    if (!caller) {
      return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
    }
    if (caller !== 'gorn' && !SECURITY_READ_ALLOWLIST.includes(caller)) {
      return c.json({ error: 'Security event stats are restricted to Gorn and security team' }, 403);
    }

    const total = (sqlite.prepare('SELECT COUNT(*) as count FROM security_events').get() as any)?.count || 0;
    const bySeverity = sqlite.prepare('SELECT severity, COUNT(*) as count FROM security_events GROUP BY severity ORDER BY count DESC').all();
    const byType = sqlite.prepare('SELECT event_type, COUNT(*) as count FROM security_events GROUP BY event_type ORDER BY count DESC').all();
    const byActor = sqlite.prepare('SELECT actor, COUNT(*) as count FROM security_events WHERE actor IS NOT NULL GROUP BY actor ORDER BY count DESC LIMIT 10').all();
    const last24h = (sqlite.prepare('SELECT COUNT(*) as count FROM security_events WHERE timestamp > ?').get(Math.floor(Date.now() / 1000) - 86400) as any)?.count || 0;
    const criticalCount = (sqlite.prepare("SELECT COUNT(*) as count FROM security_events WHERE severity = 'critical'").get() as any)?.count || 0;
    const warningCount = (sqlite.prepare("SELECT COUNT(*) as count FROM security_events WHERE severity = 'warning'").get() as any)?.count || 0;

    return c.json({
      total,
      last_24h: last24h,
      critical: criticalCount,
      warnings: warningCount,
      by_severity: bySeverity,
      by_type: byType,
      by_actor: byActor,
      retention_days: SECURITY_RETENTION_DAYS,
    });
  });
}
