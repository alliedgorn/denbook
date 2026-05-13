import path from 'path';
import fs from 'fs';
import { MeiliSearch } from 'meilisearch';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';

// ============================================================================
// Module-level search infrastructure state
// ============================================================================

const MEILI_HOST = process.env.MEILI_HOST || 'http://127.0.0.1:7700';
const MEILI_MASTER_KEY = process.env.MEILI_MASTER_KEY || '';
let meili: MeiliSearch | null = null;
let meiliAvailable = false;
let sqlite: Database | null = null;

const VALID_SOURCE_TYPES = ['forum', 'library', 'task', 'spec', 'shelf'];

// URL generator for search results
const searchUrlMap: Record<string, (id: number) => string> = {
  forum: () => '#', // forum needs thread_id, handled specially
  library: (id) => `/library?doc=${id}`,
  spec: (id) => `/specs?spec=${id}`,
  risk: () => `/risk`,
  task: (id) => `/board?task=${id}`,
  shelf: () => `/library`,
};

function searchUrlFor(sourceType: string, sourceId: number, extraUrl?: string): string {
  if (extraUrl) return extraUrl;
  return (searchUrlMap[sourceType] || (() => '#'))(sourceId);
}

// ============================================================================
// Meilisearch init + backfill
// ============================================================================

async function initMeilisearch(): Promise<void> {
  if (!MEILI_MASTER_KEY) { console.log('[MEILI] No master key configured, skipping'); return; }
  try {
    meili = new MeiliSearch({ host: MEILI_HOST, apiKey: MEILI_MASTER_KEY });
    const health = await meili.health();
    if (health.status === 'available') {
      meiliAvailable = true;
      console.log('[MEILI] Connected to Meilisearch');

      // Create/update index settings
      const index = meili.index('denbook');
      try { await meili.createIndex('denbook', { primaryKey: 'search_id' }); } catch { /* exists */ }
      await index.updateSettings({
        searchableAttributes: ['title', 'content', 'author'],
        filterableAttributes: ['source_type', 'author'],
        sortableAttributes: ['created_at'],
        typoTolerance: { enabled: true, minWordSizeForTypos: { oneTypo: 4, twoTypos: 8 } },
      });
      console.log('[MEILI] Index settings configured');
    }
  } catch (e) {
    console.log(`[MEILI] Not available: ${e}`);
    meili = null;
    meiliAvailable = false;
  }
}

// Backfill Meilisearch
export async function backfillMeilisearch(): Promise<void> {
  if (!meili || !meiliAvailable || !sqlite) return;
  console.log('[MEILI] Backfilling...');
  const index = meili.index('denbook');
  const docs: any[] = [];
  const repoBase = path.join(import.meta.dirname || __dirname, '..');

  // Library
  const libRows = sqlite.prepare('SELECT id, title, content, author, created_at FROM library').all() as any[];
  for (const r of libRows) docs.push({ search_id: `library_${r.id}`, title: r.title, content: r.content, source_type: 'library', source_id: r.id, author: r.author, created_at: new Date(r.created_at).toISOString(), url: `/library?doc=${r.id}` });

  // Forum
  const forumRows = sqlite.prepare('SELECT m.id, t.title, m.content, m.author, m.created_at, m.thread_id FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id').all() as any[];
  for (const r of forumRows) docs.push({ search_id: `forum_${r.id}`, title: r.title, content: r.content, source_type: 'forum', source_id: r.id, author: r.author, created_at: r.created_at, url: `/forum?thread=${r.thread_id}` });

  // Tasks
  const taskRows = sqlite.prepare('SELECT id, title, description, assigned_to, created_at FROM tasks').all() as any[];
  for (const r of taskRows) docs.push({ search_id: `task_${r.id}`, title: r.title, content: r.description || '', source_type: 'task', source_id: r.id, author: r.assigned_to || '', created_at: r.created_at, url: `/board?task=${r.id}` });

  // Specs (file content)
  const specRows = sqlite.prepare('SELECT id, title, author, file_path, created_at FROM spec_reviews').all() as any[];
  for (const r of specRows) {
    const fp = path.join(repoBase, r.file_path);
    const content = fs.existsSync(fp) ? fs.readFileSync(fp, 'utf-8') : r.title;
    docs.push({ search_id: `spec_${r.id}`, title: r.title, content, source_type: 'spec', source_id: r.id, author: r.author, created_at: r.created_at, url: `/specs?spec=${r.id}` });
  }

  // Risks
  const riskRows = sqlite.prepare('SELECT id, title, description, created_by, created_at FROM risks').all() as any[];
  for (const r of riskRows) docs.push({ search_id: `risk_${r.id}`, title: r.title, content: r.description || '', source_type: 'risk', source_id: r.id, author: r.created_by, created_at: r.created_at, url: '/risk' });

  // Shelves (T#351)
  const shelfRows = sqlite.prepare('SELECT id, name, description, icon, color, created_by, created_at FROM library_shelves').all() as any[];
  for (const r of shelfRows) docs.push({ search_id: `shelf_${r.id}`, title: r.name, content: r.description || '', source_type: 'shelf', source_id: r.id, author: r.created_by, created_at: r.created_at, url: `/library` });

  if (docs.length > 0) {
    const task = await index.addDocuments(docs);
    console.log(`[MEILI] Backfill queued: ${docs.length} docs (task: ${task.taskUid})`);
  }
}

// Index specs by reading their markdown files
function indexSpecFiles(): void {
  if (!sqlite) return;
  const specs = sqlite.prepare('SELECT id, title, author, file_path, repo, created_at FROM spec_reviews').all() as any[];
  const repoBase = path.join(import.meta.dirname || __dirname, '..');
  for (const spec of specs) {
    try {
      const filePath = path.join(repoBase, spec.file_path);
      const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : spec.title;
      searchIndexUpsert('spec', spec.id, spec.title, content, spec.author, spec.created_at);
    } catch { /* skip */ }
  }
}

// ============================================================================
// Search index helpers (cross-domain, exported)
// ============================================================================

// Helper: index a document
export function searchIndexUpsert(sourceType: string, sourceId: number, title: string, content: string, author: string, createdAt: string, url?: string): void {
  if (!sqlite) return;
  const resolvedUrl = searchUrlFor(sourceType, sourceId, url);
  // FTS5 (sync)
  try {
    sqlite.prepare('DELETE FROM search_index WHERE source_type = ? AND source_id = ?').run(sourceType, String(sourceId));
    sqlite.prepare('INSERT INTO search_index(title, content, source_type, source_id, author, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(title, content, sourceType, String(sourceId), author, createdAt);
  } catch { /* ignore indexing errors */ }
  // Meilisearch (async, fire-and-forget)
  if (meili && meiliAvailable) {
    meili.index('denbook').addDocuments([{
      search_id: `${sourceType}_${sourceId}`, title, content, source_type: sourceType,
      source_id: sourceId, author, created_at: createdAt, url: resolvedUrl,
    }]).catch(() => {});
  }
}

export function searchIndexDelete(sourceType: string, sourceId: number): void {
  if (!sqlite) return;
  try { sqlite.prepare('DELETE FROM search_index WHERE source_type = ? AND source_id = ?').run(sourceType, String(sourceId)); } catch { /* ignore */ }
  if (meili && meiliAvailable) {
    meili.index('denbook').deleteDocument(`${sourceType}_${sourceId}`).catch(() => {});
  }
}

// Sanitize FTS5 query — prevent column targeting
function sanitizeFtsQuery(raw: string): string {
  const terms = raw.match(/"[^"]*"|[^\s]+/g) || [];
  return terms.map(t => t.startsWith('"') ? t : `"${t.replace(/"/g, '')}"`).join(' ');
}

// FTS5 search (used as fallback)
function fts5Search(q: string, type: string | undefined, limit: number, offset: number) {
  if (!sqlite) return { results: [], total: 0, query: q, engine: 'fts5' as const };
  const sanitized = sanitizeFtsQuery(q);
  if (!sanitized) return { results: [], total: 0, query: q, engine: 'fts5' as const };

  let where = 'search_index MATCH ?';
  const params: any[] = [sanitized];
  if (type && VALID_SOURCE_TYPES.includes(type)) { where += ' AND source_type = ?'; params.push(type); }

  const total = (sqlite.prepare(`SELECT COUNT(*) as c FROM search_index WHERE ${where}`).get(...params) as any)?.c || 0;
  const rows = sqlite.prepare(
    `SELECT source_type, source_id, title, snippet(search_index, 1, '<mark>', '</mark>', '...', 40) as snippet, author, rank, created_at
     FROM search_index WHERE ${where} ORDER BY rank LIMIT ? OFFSET ?`
  ).all(...params, limit, offset) as any[];

  const urlMap: Record<string, (id: string) => string> = {
    library: (id) => `/library?doc=${id}`,
    spec: (id) => `/specs?spec=${id}`, risk: () => `/risk`, task: (id) => `/board?task=${id}`,
    shelf: () => `/library`,
  };

  // Forum source_id is message ID — look up thread_id for URL
  function forumUrl(messageId: string): string {
    if (!sqlite) return '#';
    const row = sqlite.prepare('SELECT thread_id FROM forum_messages WHERE id = ?').get(parseInt(messageId, 10)) as any;
    return row ? `/forum?thread=${row.thread_id}` : '#';
  }

  // Deduplicate by URL — keep first (best-ranked) result per URL
  const seen = new Set<string>();
  const deduped = rows.reduce((acc: any[], r: any) => {
    const url = r.source_type === 'forum' ? forumUrl(r.source_id) : (urlMap[r.source_type] || (() => '#'))(r.source_id);
    if (url !== '#' && seen.has(url)) return acc;
    if (url !== '#') seen.add(url);
    acc.push({
      source_type: r.source_type, source_id: r.source_id, title: r.title,
      snippet: r.snippet, author: r.author, url,
    });
    return acc;
  }, []);

  return {
    results: deduped,
    total: deduped.length, query: q, engine: 'fts5' as const,
  };
}

// ============================================================================
// initSearch — server startup entry: meili + FTS5 table + backfill check
// ============================================================================

export function initSearch(sqliteDb: Database): void {
  sqlite = sqliteDb;

  // Create FTS5 virtual table (synchronous — must complete before any search hits)
  try {
    sqlite.prepare(`CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      title, content, source_type, source_id UNINDEXED, author, created_at UNINDEXED,
      tokenize = 'porter unicode61'
    )`).run();
  } catch { /* already exists */ }

  // Backfill if FTS5 index is empty (synchronous)
  const searchCount = (sqlite.prepare('SELECT COUNT(*) as c FROM search_index').get() as any)?.c || 0;
  if (searchCount === 0) {
    console.log('[SEARCH] Backfilling FTS5 search index...');
    const backfillStmts = [
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT title, content, 'library', id, author, created_at FROM library`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT t.title, m.content, 'forum', m.id, m.author, m.created_at
       FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT title, COALESCE(description,''), 'risk', id, created_by, created_at FROM risks`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT title, COALESCE(description,''), 'task', id, COALESCE(assigned_to,''), created_at FROM tasks`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT name, COALESCE(description,''), 'shelf', id, created_by, created_at FROM library_shelves`,
    ];
    for (const stmt of backfillStmts) {
      try { sqlite.prepare(stmt).run(); } catch (e) { console.log(`[SEARCH] Backfill warning: ${e}`); }
    }
    indexSpecFiles();
    const total = (sqlite.prepare('SELECT COUNT(*) as c FROM search_index').get() as any)?.c || 0;
    console.log(`[SEARCH] Backfill complete: ${total} documents indexed.`);
  }

  // Init Meilisearch (async, fire-and-forget — matches original initMeilisearch().then(...) shape)
  initMeilisearch().then(() => {
    if (meiliAvailable && meili) {
      meili.index('denbook').getStats().then(stats => {
        if (stats.numberOfDocuments === 0) backfillMeilisearch();
        else console.log(`[MEILI] Index has ${stats.numberOfDocuments} docs, skipping backfill`);
      }).catch(() => backfillMeilisearch());
    }
  }).catch(() => {});
}

// ============================================================================
// Routes
// ============================================================================

interface SearchHelpers {
  hasSessionAuth: (c: Context) => boolean;
  isLocalNetwork: (c: Context) => boolean;
  isTrustedRequest: (c: Context) => boolean;
  handleSearch: (q: string, type: string, limit: number, offset: number, mode: 'hybrid' | 'fts' | 'vector', project?: string, cwd?: string, model?: string) => Promise<any>;
}

export function registerSearchRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: SearchHelpers): void {
  const { hasSessionAuth, isLocalNetwork, isTrustedRequest, handleSearch } = helpers;
  // sqlite is already captured via initSearch; sqliteDb param matches DI pattern

  // GET /api/search/legacy — Legacy vector search (kept for backwards compat)
  app.get('/api/search/legacy', async (c) => {
    const q = c.req.query('q');
    if (!q) {
      return c.json({ error: 'Missing query parameter: q' }, 400);
    }
    const type = c.req.query('type') || 'all';
    const limit = parseInt(c.req.query('limit') || '10');
    const offset = parseInt(c.req.query('offset') || '0');
    const mode = (c.req.query('mode') || 'hybrid') as 'hybrid' | 'fts' | 'vector';
    const project = c.req.query('project');
    const cwd = c.req.query('cwd');
    const model = c.req.query('model');

    const result = await handleSearch(q, type, limit, offset, mode, project, cwd, model);
    return c.json({ ...result, query: q });
  });

  // GET /api/search — global search (Meilisearch with FTS5 fallback)
  app.get('/api/search', async (c) => {
    // Search requires owner session or local Beast request (T#605)
    const role = (c.get as any)('role');
    if (role === 'guest') {
      return c.json({ error: 'Search is not available in guest mode' }, 403);
    }
    const hasSession = hasSessionAuth(c);
    const isLocalBeast = isLocalNetwork(c) && c.req.query('as');
    if (!hasSession && !isLocalBeast) {
      return c.json({ error: 'Authentication required' }, 401);
    }
    const requester = c.req.query('as') || 'gorn';

    let q = c.req.query('q')?.trim();
    if (!q) return c.json({ results: [], total: 0, query: '' });

    // Direct ID lookup shortcuts: T:360, F:298, S:16, L:36 (colon prefix, mobile-friendly)
    // Also supports legacy: T#360, "thread 344", "task 123", "spec 16", "library 36"
    const taskMatch = q.match(/^(?:t[:#]?|task)\s*[:#]?(\d+)$/i);
    if (taskMatch) {
      const id = parseInt(taskMatch[1], 10);
      const task = sqliteDb.prepare('SELECT id, title, assigned_to FROM tasks WHERE id = ?').get(id) as any;
      if (task) return c.json({ results: [{ source_type: 'task', source_id: task.id, title: task.title, snippet: '', author: task.assigned_to || '', url: `/board?task=${task.id}` }], total: 1, query: q, engine: 'id_lookup' });
    }
    const threadMatch = q.match(/^(?:f[:#]?|thread)\s*[:#]?(\d+)$/i);
    if (threadMatch) {
      const id = parseInt(threadMatch[1], 10);
      const thread = sqliteDb.prepare('SELECT id, title FROM forum_threads WHERE id = ?').get(id) as any;
      if (thread) return c.json({ results: [{ source_type: 'forum', source_id: thread.id, title: thread.title, snippet: '', author: '', url: `/forum?thread=${thread.id}` }], total: 1, query: q, engine: 'id_lookup' });
    }
    const specMatch = q.match(/^(?:s[:#]?|spec)\s*[:#]?(\d+)$/i);
    if (specMatch) {
      const id = parseInt(specMatch[1], 10);
      const spec = sqliteDb.prepare('SELECT id, title FROM spec_reviews WHERE id = ?').get(id) as any;
      if (spec) return c.json({ results: [{ source_type: 'spec', source_id: spec.id, title: spec.title, snippet: '', author: '', url: `/specs?spec=${spec.id}` }], total: 1, query: q, engine: 'id_lookup' });
    }
    const libMatch = q.match(/^(?:l[:#]?|library)\s*[:#]?(\d+)$/i);
    if (libMatch) {
      const id = parseInt(libMatch[1], 10);
      const entry = sqliteDb.prepare('SELECT id, title FROM library WHERE id = ?').get(id) as any;
      if (entry) return c.json({ results: [{ source_type: 'library', source_id: entry.id, title: entry.title, snippet: '', author: '', url: `/library?doc=${entry.id}` }], total: 1, query: q, engine: 'id_lookup' });
    }

    let type = c.req.query('type') || undefined;
    const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));

    // Type aliases: "thread" → "forum", "post" → "forum", "entry" → "library", etc.
    const TYPE_ALIASES: Record<string, string> = {
      thread: 'forum', post: 'forum', message: 'forum', f: 'forum',
      entry: 'library', doc: 'library', document: 'library', l: 'library',
      issue: 'task', ticket: 'task', t: 'task',
      specification: 'spec', s: 'spec',
      r: 'risk',
    };

    // Type-prefix syntax: "forum:websocket" or "type:forum websocket" (T#351/T#352)
    const prefixMatch = q.match(/^(\w+):\s*(.+)$/);
    if (prefixMatch) {
      const prefix = prefixMatch[1].toLowerCase();
      const rest = prefixMatch[2].trim();
      if (prefix === 'type') {
        // "type:forum test" or "type:thread test" — split on first space
        const spaceIdx = rest.indexOf(' ');
        if (spaceIdx > 0) {
          const typeName = rest.slice(0, spaceIdx).toLowerCase();
          const resolved = TYPE_ALIASES[typeName] || typeName;
          if (VALID_SOURCE_TYPES.includes(resolved)) {
            type = resolved;
            q = rest.slice(spaceIdx + 1).trim();
          }
        } else {
          // "type:forum" with no query — resolve type, search for everything
          const resolved = TYPE_ALIASES[rest.toLowerCase()] || rest.toLowerCase();
          if (VALID_SOURCE_TYPES.includes(resolved)) {
            type = resolved;
            q = '*';
          }
        }
      } else {
        // Direct prefix: "forum:websocket", "thread:websocket"
        const resolved = TYPE_ALIASES[prefix] || prefix;
        if (VALID_SOURCE_TYPES.includes(resolved)) {
          type = resolved;
          q = rest;
        }
      }
    }

    // Try Meilisearch first
    if (meili && meiliAvailable) {
      try {
        const filter = type && VALID_SOURCE_TYPES.includes(type) ? `source_type = "${type}"` : undefined;
        const results = await meili.index('denbook').search(q, {
          limit, offset, filter: filter || undefined,
          attributesToHighlight: ['title', 'content'],
          attributesToCrop: ['content'],
          cropLength: 50,
        });
        // Deduplicate by URL — keep first (best-ranked) result per URL
        const seen = new Set<string>();
        const deduped = (results.hits || []).reduce((acc: any[], h: any) => {
          const url = h.url || '#';
          if (url !== '#' && seen.has(url)) return acc;
          if (url !== '#') seen.add(url);
          acc.push({
            source_type: h.source_type, source_id: h.source_id, title: h.title,
            snippet: h._formatted?.content || h.content?.slice(0, 200) || '',
            author: h.author, url,
          });
          return acc;
        }, []);
        return c.json({
          results: deduped,
          total: deduped.length,
          query: q,
          engine: 'meilisearch',
          processingTimeMs: results.processingTimeMs,
        });
      } catch {
        // Fall through to FTS5
      }
    }

    // FTS5 fallback
    return c.json(fts5Search(q, type, limit, offset));
  });

  // POST /api/search/reindex — full rebuild (Gorn or trusted local)
  app.post('/api/search/reindex', async (c) => {
    if (!hasSessionAuth(c) && !isTrustedRequest(c)) return c.json({ error: 'Gorn-only' }, 403);

    // FTS5 rebuild
    sqliteDb.prepare('DELETE FROM search_index').run();
    const stmts = [
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT title, content, 'library', id, author, created_at FROM library`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT t.title, m.content, 'forum', m.id, m.author, m.created_at
       FROM forum_messages m JOIN forum_threads t ON m.thread_id = t.id`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT title, COALESCE(description,''), 'risk', id, created_by, created_at FROM risks`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT title, COALESCE(description,''), 'task', id, COALESCE(assigned_to,''), created_at FROM tasks`,
      `INSERT INTO search_index(title, content, source_type, source_id, author, created_at)
       SELECT name, COALESCE(description,''), 'shelf', id, created_by, created_at FROM library_shelves`,
    ];
    for (const stmt of stmts) {
      try { sqliteDb.prepare(stmt).run(); } catch { /* skip */ }
    }
    indexSpecFiles();
    const indexed: Record<string, number> = {};
    const rows = sqliteDb.prepare('SELECT source_type, COUNT(*) as c FROM search_index GROUP BY source_type').all() as any[];
    for (const r of rows) indexed[r.source_type] = r.c;
    const fts5Total = Object.values(indexed).reduce((a, b) => a + b, 0);

    // Meilisearch rebuild
    let meiliTotal = 0;
    if (meili && meiliAvailable) {
      try {
        await meili.index('denbook').deleteAllDocuments();
        await backfillMeilisearch();
        const stats = await meili.index('denbook').getStats();
        meiliTotal = stats.numberOfDocuments;
      } catch { /* skip */ }
    }

    return c.json({ reindexed: true, total: fts5Total, indexed, meili: meiliAvailable ? { total: meiliTotal } : null });
  });

  // GET /api/search/status — integrity check
  app.get('/api/search/status', async (c) => {
    const indexed: Record<string, number> = {};
    const source: Record<string, number> = {};

    const indexedRows = sqliteDb.prepare('SELECT source_type, COUNT(*) as c FROM search_index GROUP BY source_type').all() as any[];
    for (const r of indexedRows) indexed[r.source_type] = r.c;

    source.library = (sqliteDb.prepare('SELECT COUNT(*) as c FROM library').get() as any)?.c || 0;
    source.forum = (sqliteDb.prepare('SELECT COUNT(*) as c FROM forum_messages').get() as any)?.c || 0;
    source.spec = (sqliteDb.prepare('SELECT COUNT(*) as c FROM spec_reviews').get() as any)?.c || 0;
    source.risk = (sqliteDb.prepare('SELECT COUNT(*) as c FROM risks').get() as any)?.c || 0;
    source.task = (sqliteDb.prepare('SELECT COUNT(*) as c FROM tasks').get() as any)?.c || 0;
    source.shelf = (sqliteDb.prepare('SELECT COUNT(*) as c FROM library_shelves').get() as any)?.c || 0;

    const drift = Object.keys(source).some(k => (indexed[k] || 0) !== source[k]);

    let meiliStatus: any = { status: 'unavailable' };
    if (meili && meiliAvailable) {
      try {
        const stats = await meili.index('denbook').getStats();
        meiliStatus = { status: 'available', indexed: stats.numberOfDocuments };
      } catch { meiliStatus = { status: 'error' }; }
    }

    return c.json({
      indexed, source, drift,
      total_indexed: Object.values(indexed).reduce((a, b) => a + b, 0),
      engine: meiliAvailable ? 'meilisearch' : 'fts5',
      meilisearch: meiliStatus,
    });
  });
}
