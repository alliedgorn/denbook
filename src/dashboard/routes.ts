import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';

// ============================================================================
// Dashboard routes — Phase 2.6 of Library #102 (T#784)
// ============================================================================

interface DashboardHelpers {
  hasSessionAuth: (c: Context) => boolean;
  handleDashboardSummary: () => any;
  handleDashboardActivity: (...args: any[]) => any;
  handleDashboardGrowth: (...args: any[]) => any;
  handleStats: (dbPath: string) => any;
  handleReflect: () => any;
  handleList: (...args: any[]) => any;
  handleGraph: (...args: any[]) => any;
  handleMap: (...args: any[]) => any;
  handleMap3d: (...args: any[]) => any;
  handleVectorStats: () => Promise<any>;
  getSetting: (key: string) => string | null;
  DB_PATH: string;
  oracleCache: { data: any; ts: number } | null;
  setOracleCache: (cache: { data: any; ts: number } | null) => void;
}

export function registerDashboardRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: DashboardHelpers): void {
  const sqlite: Database = sqliteDb;
  const { hasSessionAuth, handleDashboardSummary, handleDashboardActivity, handleDashboardGrowth, handleStats, handleReflect, handleList, handleGraph, handleMap, handleMap3d, handleVectorStats, getSetting, DB_PATH } = helpers;
  let oracleCache = helpers.oracleCache;

  app.get('/api/reflect', (c) => {
    return c.json(handleReflect());
  });

  app.get('/api/stats', async (c) => {
    const stats = handleStats(DB_PATH);
    const vaultRepo = getSetting('vault_repo');
    let vectorStats = { vector: { enabled: false, count: 0, collection: 'oracle_knowledge' } };
    try {
      vectorStats = await handleVectorStats();
    } catch { /* vector unavailable */ }
    return c.json({ ...stats, ...vectorStats, vault_repo: vaultRepo });
  });

  app.get('/api/oracles', (c) => {
    const hours = parseInt(c.req.query('hours') || '168'); // default 7 days
    const now = Date.now();
    if (oracleCache && (now - oracleCache.ts) < 60_000) return c.json(oracleCache.data);

    const cutoff = now - hours * 3600_000;
    // Active identities (forum authors, trace sessions, learn sources)
    const identities = sqlite.prepare(`
      SELECT oracle_name, source, max(last_seen) as last_seen, sum(actions) as actions
      FROM (
        SELECT author as oracle_name, 'forum' as source, max(created_at) as last_seen, count(*) as actions
          FROM forum_messages WHERE author IS NOT NULL AND created_at > ?
          GROUP BY author
        UNION ALL
        SELECT COALESCE(session_id, 'unknown') as oracle_name, 'trace' as source, max(created_at) as last_seen, count(*) as actions
          FROM trace_log WHERE created_at > ?
          GROUP BY session_id
        UNION ALL
        SELECT COALESCE(source, project, 'unknown') as oracle_name, 'learn' as source, max(created_at) as last_seen, count(*) as actions
          FROM learn_log WHERE created_at > ?
          GROUP BY COALESCE(source, project)
      )
      WHERE oracle_name IS NOT NULL AND oracle_name != 'unknown'
      GROUP BY oracle_name
      ORDER BY last_seen DESC
    `).all(cutoff, cutoff, cutoff);

    // Projects with indexed knowledge (each project = an Oracle's domain)
    const projects = sqlite.prepare(`
      SELECT project, count(*) as docs,
             count(DISTINCT type) as types,
             max(created_at) as last_indexed
      FROM oracle_documents
      WHERE project IS NOT NULL
      GROUP BY project
      ORDER BY last_indexed DESC
    `).all();

    const result = {
      identities,
      projects,
      total_projects: projects.length,
      total_identities: identities.length,
      window_hours: hours,
      cached_at: new Date().toISOString(),
    };
    oracleCache = { data: result, ts: now };
    return c.json(result);
  });

  app.get('/api/map', async (c) => {
    try {
      const result = await handleMap();
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e.message, documents: [], total: 0 }, 500);
    }
  });

  app.get('/api/map3d', async (c) => {
    try {
      const model = c.req.query('model') || undefined;
      const result = await handleMap3d(model);
      return c.json(result);
    } catch (e: any) {
      return c.json({ error: e.message, documents: [], total: 0 }, 500);
    }
  });

  app.get('/api/list', (c) => {
    const type = c.req.query('type') || 'all';
    const limit = parseInt(c.req.query('limit') || '10');
    const offset = parseInt(c.req.query('offset') || '0');
    const group = c.req.query('group') !== 'false';

    return c.json(handleList(type, limit, offset, group));
  });

  app.get('/api/graph', (c) => {
    const limit = c.req.query('limit') ? parseInt(c.req.query('limit')!, 10) : undefined;
    return c.json(handleGraph(limit));
  });

  app.get('/api/dashboard', (c) => c.json(handleDashboardSummary()));
  app.get('/api/dashboard/summary', (c) => c.json(handleDashboardSummary()));

  app.get('/api/dashboard/activity', (c) => {
    const days = parseInt(c.req.query('days') || '7');
    return c.json(handleDashboardActivity(days));
  });

  app.get('/api/dashboard/growth', (c) => {
    const period = c.req.query('period') || 'week';
    return c.json(handleDashboardGrowth(period));
  });


}
