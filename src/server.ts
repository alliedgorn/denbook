/**
 * Oracle v2 HTTP Server
 *
 * Web viewer for Oracle knowledge base.
 * Exposes same functionality as MCP but via HTTP.
 *
 * Endpoints:
 * - GET /health          - Health check
 * - GET /search?q=...    - Search Oracle knowledge
 * - GET /list            - Browse all documents (no query needed)
 * - GET /consult?q=...   - Get guidance on decision
 * - GET /reflect         - Random wisdom
 * - GET /stats           - Database statistics
 * - GET /graph           - Knowledge graph data
 * - POST /learn          - Add new pattern/learning
 */

import http from 'http';
import url from 'url';
import fs from 'fs';
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

// ES Module compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.ORACLE_PORT || 37778;
const REPO_ROOT = process.env.ORACLE_REPO_ROOT || '/Users/nat/Code/github.com/laris-co/Nat-s-Agents';
const DB_PATH = path.join(REPO_ROOT, 'ψ/lab/oracle-v2/oracle.db');
const UI_PATH = path.join(REPO_ROOT, 'ψ/lab/oracle-v2/src/ui.html');
const ARTHUR_UI_PATH = path.join(REPO_ROOT, 'ψ/lab/oracle-jarvis/index.html');
const DASHBOARD_PATH = path.join(__dirname, 'dashboard.html');

// Initialize database
const db = new Database(DB_PATH);

// Initialize logging tables
function initLoggingTables() {
  // Search query log
  db.exec(`
    CREATE TABLE IF NOT EXISTS search_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      query TEXT NOT NULL,
      type TEXT,
      mode TEXT,
      results_count INTEGER,
      search_time_ms INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_search_created ON search_log(created_at)`);

  // Learning log
  db.exec(`
    CREATE TABLE IF NOT EXISTS learn_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      pattern_preview TEXT,
      source TEXT,
      concepts TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learn_created ON learn_log(created_at)`);

  // Document access log
  db.exec(`
    CREATE TABLE IF NOT EXISTS document_access (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id TEXT NOT NULL,
      access_type TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_doc ON document_access(document_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_created ON document_access(created_at)`);
}

// Initialize tables on startup
try {
  initLoggingTables();
} catch (e) {
  console.error('Failed to initialize logging tables:', e);
}

interface SearchResult {
  id: string;
  type: string;
  content: string;
  source_file: string;
  concepts: string[];
}

interface SearchResponse {
  results: SearchResult[];
  total: number;
  offset: number;
  limit: number;
}

/**
 * Log search query
 */
function logSearch(query: string, type: string, mode: string, resultsCount: number, searchTimeMs: number) {
  try {
    db.prepare(`
      INSERT INTO search_log (query, type, mode, results_count, search_time_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(query, type, mode, resultsCount, searchTimeMs, Date.now());
  } catch (e) {
    console.error('Failed to log search:', e);
  }
}

/**
 * Log document access
 */
function logDocumentAccess(documentId: string, accessType: string) {
  try {
    db.prepare(`
      INSERT INTO document_access (document_id, access_type, created_at)
      VALUES (?, ?, ?)
    `).run(documentId, accessType, Date.now());
  } catch (e) {
    console.error('Failed to log access:', e);
  }
}

/**
 * Log learning addition
 */
function logLearning(documentId: string, patternPreview: string, source: string, concepts: string[]) {
  try {
    db.prepare(`
      INSERT INTO learn_log (document_id, pattern_preview, source, concepts, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(documentId, patternPreview.substring(0, 100), source || 'Oracle Learn', JSON.stringify(concepts), Date.now());
  } catch (e) {
    console.error('Failed to log learning:', e);
  }
}

/**
 * Search Oracle knowledge base with pagination
 */
function handleSearch(query: string, type: string = 'all', limit: number = 10, offset: number = 0): SearchResponse {
  const startTime = Date.now();
  // Remove FTS5 special characters: ? * + - ( ) ^ ~ " ' : (colon is column prefix)
  const safeQuery = query.replace(/[?*+\-()^~"':]/g, ' ').replace(/\s+/g, ' ').trim();

  let countStmt;
  let stmt;

  if (type === 'all') {
    // Get total count
    countStmt = db.prepare(`
      SELECT COUNT(*) as total
      FROM oracle_fts f
      JOIN oracle_documents d ON f.id = d.id
      WHERE oracle_fts MATCH ?
    `);
    const { total } = countStmt.get(safeQuery) as { total: number };

    // Get paginated results
    stmt = db.prepare(`
      SELECT f.id, f.content, d.type, d.source_file, d.concepts
      FROM oracle_fts f
      JOIN oracle_documents d ON f.id = d.id
      WHERE oracle_fts MATCH ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `);
    const results = stmt.all(safeQuery, limit, offset).map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content.substring(0, 500),
      source_file: row.source_file,
      concepts: JSON.parse(row.concepts || '[]'),
      source: 'fts' as const
    }));

    // Log search and document access
    logSearch(query, type, 'fts', total, Date.now() - startTime);
    results.forEach(r => logDocumentAccess(r.id, 'search'));

    return { results, total, offset, limit };
  } else {
    // Get total count with type filter
    countStmt = db.prepare(`
      SELECT COUNT(*) as total
      FROM oracle_fts f
      JOIN oracle_documents d ON f.id = d.id
      WHERE oracle_fts MATCH ? AND d.type = ?
    `);
    const { total } = countStmt.get(safeQuery, type) as { total: number };

    // Get paginated results
    stmt = db.prepare(`
      SELECT f.id, f.content, d.type, d.source_file, d.concepts
      FROM oracle_fts f
      JOIN oracle_documents d ON f.id = d.id
      WHERE oracle_fts MATCH ? AND d.type = ?
      ORDER BY rank
      LIMIT ? OFFSET ?
    `);
    const results = stmt.all(safeQuery, type, limit, offset).map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content.substring(0, 500),
      source_file: row.source_file,
      concepts: JSON.parse(row.concepts || '[]'),
      source: 'fts' as const
    }));

    // Log search and document access
    logSearch(query, type, 'fts', total, Date.now() - startTime);
    results.forEach(r => logDocumentAccess(r.id, 'search'));

    return { results, total, offset, limit };
  }
}

/**
 * Get guidance on a decision
 */
function handleConsult(decision: string, context: string = '') {
  const query = context ? `${decision} ${context}` : decision;
  // Remove FTS5 special characters: ? * + - ( ) ^ ~ " ' : (colon is column prefix)
  const safeQuery = query.replace(/[?*+\-()^~"':]/g, ' ').replace(/\s+/g, ' ').trim();

  const principleStmt = db.prepare(`
    SELECT f.id, f.content, d.source_file
    FROM oracle_fts f
    JOIN oracle_documents d ON f.id = d.id
    WHERE oracle_fts MATCH ? AND d.type = 'principle'
    ORDER BY rank
    LIMIT 3
  `);
  const principles = principleStmt.all(safeQuery);

  const learningStmt = db.prepare(`
    SELECT f.id, f.content, d.source_file
    FROM oracle_fts f
    JOIN oracle_documents d ON f.id = d.id
    WHERE oracle_fts MATCH ? AND d.type = 'learning'
    ORDER BY rank
    LIMIT 3
  `);
  const patterns = learningStmt.all(safeQuery);

  return {
    decision,
    principles: principles.map((p: any) => ({
      content: p.content.substring(0, 300),
      source: p.source_file
    })),
    patterns: patterns.map((p: any) => ({
      content: p.content.substring(0, 300),
      source: p.source_file
    })),
    guidance: synthesizeGuidance(decision, principles, patterns)
  };
}

/**
 * Get random wisdom
 */
function handleReflect() {
  const randomDoc = db.prepare(`
    SELECT id, type, source_file, concepts FROM oracle_documents
    WHERE type IN ('principle', 'learning')
    ORDER BY RANDOM()
    LIMIT 1
  `).get() as any;

  if (!randomDoc) {
    return { error: 'No documents found' };
  }

  const content = db.prepare(`
    SELECT content FROM oracle_fts WHERE id = ?
  `).get(randomDoc.id) as { content: string };

  return {
    id: randomDoc.id,
    type: randomDoc.type,
    content: content.content,
    source_file: randomDoc.source_file,
    concepts: JSON.parse(randomDoc.concepts || '[]')
  };
}

/**
 * List all documents (browse without search)
 * @param groupByFile - if true, dedupe by source_file (show one entry per file)
 */
function handleList(type: string = 'all', limit: number = 10, offset: number = 0, groupByFile: boolean = true): SearchResponse {
  // Validate
  if (limit < 1 || limit > 100) limit = 10;
  if (offset < 0) offset = 0;

  let countStmt;
  let stmt;

  if (groupByFile) {
    // Group by source_file to avoid duplicate entries from same file
    // Use simple GROUP BY with MAX to pick longest content per file
    if (type === 'all') {
      countStmt = db.prepare('SELECT COUNT(DISTINCT source_file) as total FROM oracle_documents');
      const { total } = countStmt.get() as { total: number };

      stmt = db.prepare(`
        SELECT d.id, d.type, d.source_file, d.concepts, MAX(d.indexed_at) as indexed_at, f.content
        FROM oracle_documents d
        JOIN oracle_fts f ON d.id = f.id
        GROUP BY d.source_file
        ORDER BY indexed_at DESC
        LIMIT ? OFFSET ?
      `);
      const results = stmt.all(limit, offset).map((row: any) => ({
        id: row.id,
        type: row.type,
        content: (row.content || '').substring(0, 500),
        source_file: row.source_file,
        concepts: row.concepts ? JSON.parse(row.concepts) : [],
        indexed_at: row.indexed_at
      }));

      return { results, total, offset, limit };
    } else {
      countStmt = db.prepare('SELECT COUNT(DISTINCT source_file) as total FROM oracle_documents WHERE type = ?');
      const { total } = countStmt.get(type) as { total: number };

      stmt = db.prepare(`
        SELECT d.id, d.type, d.source_file, d.concepts, MAX(d.indexed_at) as indexed_at, f.content
        FROM oracle_documents d
        JOIN oracle_fts f ON d.id = f.id
        WHERE d.type = ?
        GROUP BY d.source_file
        ORDER BY indexed_at DESC
        LIMIT ? OFFSET ?
      `);
      const results = stmt.all(type, limit, offset).map((row: any) => ({
        id: row.id,
        type: row.type,
        content: (row.content || '').substring(0, 500),
        source_file: row.source_file,
        concepts: JSON.parse(row.concepts || '[]'),
        indexed_at: row.indexed_at
      }));

      return { results, total, offset, limit };
    }
  }

  // Original behavior without grouping
  if (type === 'all') {
    countStmt = db.prepare('SELECT COUNT(*) as total FROM oracle_documents');
    const { total } = countStmt.get() as { total: number };

    stmt = db.prepare(`
      SELECT d.id, d.type, d.source_file, d.concepts, d.indexed_at, f.content
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      ORDER BY d.indexed_at DESC
      LIMIT ? OFFSET ?
    `);
    const results = stmt.all(limit, offset).map((row: any) => ({
      id: row.id,
      type: row.type,
      content: (row.content || '').substring(0, 500),
      source_file: row.source_file,
      concepts: row.concepts ? JSON.parse(row.concepts) : [],
      indexed_at: row.indexed_at
    }));

    return { results, total, offset, limit };
  } else {
    countStmt = db.prepare('SELECT COUNT(*) as total FROM oracle_documents WHERE type = ?');
    const { total } = countStmt.get(type) as { total: number };

    stmt = db.prepare(`
      SELECT d.id, d.type, d.source_file, d.concepts, d.indexed_at, f.content
      FROM oracle_documents d
      JOIN oracle_fts f ON d.id = f.id
      WHERE d.type = ?
      ORDER BY d.indexed_at DESC
      LIMIT ? OFFSET ?
    `);
    const results = stmt.all(type, limit, offset).map((row: any) => ({
      id: row.id,
      type: row.type,
      content: row.content.substring(0, 500),
      source_file: row.source_file,
      concepts: JSON.parse(row.concepts || '[]'),
      indexed_at: row.indexed_at
    }));

    return { results, total, offset, limit };
  }
}

/**
 * Get database statistics
 */
function handleStats() {
  const totalDocs = db.prepare('SELECT COUNT(*) as count FROM oracle_documents').get() as { count: number };
  const byType = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM oracle_documents
    GROUP BY type
  `).all() as { type: string; count: number }[];

  // Get last indexed timestamp
  const lastIndexed = db.prepare(`
    SELECT MAX(indexed_at) as last_indexed FROM oracle_documents
  `).get() as { last_indexed: number | null };

  const lastIndexedDate = lastIndexed.last_indexed
    ? new Date(lastIndexed.last_indexed).toISOString()
    : null;

  // Calculate age in hours
  const indexAgeHours = lastIndexed.last_indexed
    ? (Date.now() - lastIndexed.last_indexed) / (1000 * 60 * 60)
    : null;

  // Get indexing status (if table exists)
  let indexingStatus = { is_indexing: false, progress_current: 0, progress_total: 0 };
  try {
    const status = db.prepare(`
      SELECT is_indexing, progress_current, progress_total FROM indexing_status WHERE id = 1
    `).get() as { is_indexing: number; progress_current: number; progress_total: number } | undefined;
    if (status) {
      indexingStatus = {
        is_indexing: status.is_indexing === 1,
        progress_current: status.progress_current,
        progress_total: status.progress_total
      };
    }
  } catch (e) {
    // Table doesn't exist yet, use defaults
  }

  return {
    total: totalDocs.count,
    by_type: byType.reduce((acc, row) => ({ ...acc, [row.type]: row.count }), {}),
    last_indexed: lastIndexedDate,
    index_age_hours: indexAgeHours ? Math.round(indexAgeHours * 10) / 10 : null,
    is_stale: indexAgeHours ? indexAgeHours > 24 : true,
    is_indexing: indexingStatus.is_indexing,
    indexing_progress: indexingStatus.is_indexing ? {
      current: indexingStatus.progress_current,
      total: indexingStatus.progress_total,
      percent: indexingStatus.progress_total > 0
        ? Math.round((indexingStatus.progress_current / indexingStatus.progress_total) * 100)
        : 0
    } : null,
    database: DB_PATH
  };
}

/**
 * Get knowledge graph data
 * Limited to principles + sample learnings to avoid O(n²) explosion
 */
function handleGraph() {
  // Only get principles (always) + sample learnings (limited)
  // This keeps graph manageable: ~163 principles + ~100 learnings = ~263 nodes max
  const principles = db.prepare(`
    SELECT id, type, source_file, concepts
    FROM oracle_documents
    WHERE type = 'principle'
  `).all() as { id: string; type: string; source_file: string; concepts: string }[];

  const learnings = db.prepare(`
    SELECT id, type, source_file, concepts
    FROM oracle_documents
    WHERE type = 'learning'
    ORDER BY RANDOM()
    LIMIT 100
  `).all() as { id: string; type: string; source_file: string; concepts: string }[];

  const docs = [...principles, ...learnings];

  // Build nodes
  const nodes = docs.map(doc => ({
    id: doc.id,
    type: doc.type,
    source_file: doc.source_file,
    concepts: JSON.parse(doc.concepts || '[]')
  }));

  // Build links based on shared concepts
  const links: { source: string; target: string; weight: number }[] = [];
  const processed = new Set<string>();

  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const nodeA = nodes[i];
      const nodeB = nodes[j];
      const key = `${nodeA.id}-${nodeB.id}`;

      if (processed.has(key)) continue;

      // Count shared concepts
      const conceptsA = new Set(nodeA.concepts);
      const sharedCount = nodeB.concepts.filter((c: string) => conceptsA.has(c)).length;

      if (sharedCount > 0) {
        links.push({
          source: nodeA.id,
          target: nodeB.id,
          weight: sharedCount
        });
        processed.add(key);
      }
    }
  }

  return { nodes, links };
}

/**
 * Add new pattern/learning to knowledge base
 */
function handleLearn(pattern: string, source?: string, concepts?: string[]) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD

  // Generate slug from pattern (first 50 chars, alphanumeric + dash)
  const slug = pattern
    .substring(0, 50)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const filename = `${dateStr}_${slug}.md`;
  const filePath = path.join(REPO_ROOT, 'ψ/memory/learnings', filename);

  // Check if file already exists
  if (fs.existsSync(filePath)) {
    throw new Error(`File already exists: ${filename}`);
  }

  // Generate title from pattern
  const title = pattern.split('\n')[0].substring(0, 80);

  // Create frontmatter
  const frontmatter = [
    '---',
    `title: ${title}`,
    concepts && concepts.length > 0 ? `tags: [${concepts.join(', ')}]` : 'tags: []',
    `created: ${dateStr}`,
    `source: ${source || 'Oracle Learn'}`,
    '---',
    '',
    `# ${title}`,
    '',
    pattern,
    '',
    '---',
    '*Added via Oracle Learn*',
    ''
  ].join('\n');

  // Write file
  fs.writeFileSync(filePath, frontmatter, 'utf-8');

  // Re-index the new file
  const content = frontmatter;
  const id = `learning_${dateStr}_${slug}`;
  const conceptsList = concepts || [];

  // Insert into database
  db.prepare(`
    INSERT INTO oracle_documents (id, type, source_file, concepts, created_at, updated_at, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    'learning',
    `ψ/memory/learnings/${filename}`,
    JSON.stringify(conceptsList),
    now.getTime(),
    now.getTime(),
    now.getTime()
  );

  // Insert into FTS
  db.prepare(`
    INSERT INTO oracle_fts (id, content, concepts)
    VALUES (?, ?, ?)
  `).run(
    id,
    content,
    conceptsList.join(' ')
  );

  // Log the learning
  logLearning(id, pattern, source || 'Oracle Learn', conceptsList);

  return {
    success: true,
    file: `ψ/memory/learnings/${filename}`,
    id
  };
}

/**
 * Synthesize guidance from principles and patterns
 */
function synthesizeGuidance(decision: string, principles: any[], patterns: any[]): string {
  let guidance = 'Based on Oracle philosophy:\n\n';

  if (principles.length > 0) {
    guidance += 'Relevant Principles:\n';
    principles.forEach((p: any, i: number) => {
      guidance += `${i + 1}. ${p.content.substring(0, 150)}...\n`;
    });
    guidance += '\n';
  }

  if (patterns.length > 0) {
    guidance += 'Relevant Patterns:\n';
    patterns.forEach((p: any, i: number) => {
      guidance += `${i + 1}. ${p.content.substring(0, 150)}...\n`;
    });
  }

  if (principles.length === 0 && patterns.length === 0) {
    guidance += `No matching principles or patterns for: "${decision}"`;
  } else {
    guidance += '\nRemember: The Oracle Keeps the Human Human.';
  }

  return guidance;
}

// ============================================================================
// Dashboard API Endpoints
// ============================================================================

/**
 * Dashboard summary - aggregated stats for the dashboard
 */
function handleDashboardSummary() {
  // Document counts
  const totalDocs = db.prepare('SELECT COUNT(*) as count FROM oracle_documents').get() as { count: number };
  const byType = db.prepare(`
    SELECT type, COUNT(*) as count
    FROM oracle_documents
    GROUP BY type
  `).all() as { type: string; count: number }[];

  // Concept counts
  const conceptsResult = db.prepare(`
    SELECT concepts FROM oracle_documents WHERE concepts IS NOT NULL AND concepts != '[]'
  `).all() as { concepts: string }[];

  const conceptCounts = new Map<string, number>();
  for (const row of conceptsResult) {
    try {
      const concepts = JSON.parse(row.concepts);
      if (Array.isArray(concepts)) {
        concepts.forEach((c: string) => {
          conceptCounts.set(c, (conceptCounts.get(c) || 0) + 1);
        });
      }
    } catch {}
  }

  const topConcepts = Array.from(conceptCounts.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Activity counts (last 7 days)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  let consultations7d = 0;
  let searches7d = 0;
  let learnings7d = 0;

  try {
    const consultResult = db.prepare(`
      SELECT COUNT(*) as count FROM consult_log WHERE created_at > ?
    `).get(sevenDaysAgo) as { count: number };
    consultations7d = consultResult.count;
  } catch {}

  try {
    const searchResult = db.prepare(`
      SELECT COUNT(*) as count FROM search_log WHERE created_at > ?
    `).get(sevenDaysAgo) as { count: number };
    searches7d = searchResult.count;
  } catch {}

  try {
    const learnResult = db.prepare(`
      SELECT COUNT(*) as count FROM learn_log WHERE created_at > ?
    `).get(sevenDaysAgo) as { count: number };
    learnings7d = learnResult.count;
  } catch {}

  // Health status
  const lastIndexed = db.prepare(`
    SELECT MAX(indexed_at) as last_indexed FROM oracle_documents
  `).get() as { last_indexed: number | null };

  return {
    documents: {
      total: totalDocs.count,
      by_type: byType.reduce((acc, row) => ({ ...acc, [row.type]: row.count }), {})
    },
    concepts: {
      total: conceptCounts.size,
      top: topConcepts
    },
    activity: {
      consultations_7d: consultations7d,
      searches_7d: searches7d,
      learnings_7d: learnings7d
    },
    health: {
      fts_status: totalDocs.count > 0 ? 'healthy' : 'empty',
      last_indexed: lastIndexed.last_indexed
        ? new Date(lastIndexed.last_indexed).toISOString()
        : null
    }
  };
}

/**
 * Dashboard activity - recent consultations, searches, learnings
 */
function handleDashboardActivity(days: number = 7) {
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  // Recent consultations
  let consultations: any[] = [];
  try {
    consultations = db.prepare(`
      SELECT decision, principles_found, patterns_found, created_at
      FROM consult_log
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(since).map((row: any) => ({
      decision: row.decision.substring(0, 100),
      principles_found: row.principles_found,
      patterns_found: row.patterns_found,
      created_at: new Date(row.created_at).toISOString()
    }));
  } catch {}

  // Recent searches
  let searches: any[] = [];
  try {
    searches = db.prepare(`
      SELECT query, type, results_count, search_time_ms, created_at
      FROM search_log
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(since).map((row: any) => ({
      query: row.query.substring(0, 100),
      type: row.type,
      results_count: row.results_count,
      search_time_ms: row.search_time_ms,
      created_at: new Date(row.created_at).toISOString()
    }));
  } catch {}

  // Recent learnings
  let learnings: any[] = [];
  try {
    learnings = db.prepare(`
      SELECT document_id, pattern_preview, source, concepts, created_at
      FROM learn_log
      WHERE created_at > ?
      ORDER BY created_at DESC
      LIMIT 20
    `).all(since).map((row: any) => ({
      document_id: row.document_id,
      pattern_preview: row.pattern_preview,
      source: row.source,
      concepts: JSON.parse(row.concepts || '[]'),
      created_at: new Date(row.created_at).toISOString()
    }));
  } catch {}

  return { consultations, searches, learnings, days };
}

/**
 * Dashboard growth - documents and activity over time
 */
function handleDashboardGrowth(period: string = 'week') {
  const daysMap: Record<string, number> = {
    week: 7,
    month: 30,
    quarter: 90
  };
  const days = daysMap[period] || 7;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;

  // Get daily document counts
  const data: { date: string; documents: number; consultations: number; searches: number }[] = [];

  for (let i = 0; i < days; i++) {
    const dayStart = Date.now() - (days - i) * 24 * 60 * 60 * 1000;
    const dayEnd = dayStart + 24 * 60 * 60 * 1000;
    const date = new Date(dayStart).toISOString().split('T')[0];

    // Documents created that day
    const docsResult = db.prepare(`
      SELECT COUNT(*) as count FROM oracle_documents
      WHERE created_at >= ? AND created_at < ?
    `).get(dayStart, dayEnd) as { count: number };

    // Consultations that day
    let consultCount = 0;
    try {
      const consultResult = db.prepare(`
        SELECT COUNT(*) as count FROM consult_log
        WHERE created_at >= ? AND created_at < ?
      `).get(dayStart, dayEnd) as { count: number };
      consultCount = consultResult.count;
    } catch {}

    // Searches that day
    let searchCount = 0;
    try {
      const searchResult = db.prepare(`
        SELECT COUNT(*) as count FROM search_log
        WHERE created_at >= ? AND created_at < ?
      `).get(dayStart, dayEnd) as { count: number };
      searchCount = searchResult.count;
    } catch {}

    data.push({
      date,
      documents: docsResult.count,
      consultations: consultCount,
      searches: searchCount
    });
  }

  return { period, days, data };
}

/**
 * HTTP request handler
 */
const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url || '', true);
  const pathname = parsedUrl.pathname;
  const query = parsedUrl.query;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Content-Type', 'application/json');

  // Handle OPTIONS preflight
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  try {
    let result: any;

    // POST /learn
    if (pathname === '/learn' && req.method === 'POST') {
      let body = '';
      req.on('data', chunk => { body += chunk.toString(); });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.pattern) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Missing required field: pattern' }));
            return;
          }
          const result = handleLearn(data.pattern, data.source, data.concepts);
          res.end(JSON.stringify(result, null, 2));
        } catch (error) {
          res.statusCode = 500;
          res.end(JSON.stringify({
            error: error instanceof Error ? error.message : 'Unknown error'
          }));
        }
      });
      return;
    }

    switch (pathname) {
      case '/':
        // Serve Arthur chat UI at root (per Spec 050)
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync(ARTHUR_UI_PATH, 'utf-8'));
        return;

      case '/oracle':
        // Serve Oracle Knowledge Base UI
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync(UI_PATH, 'utf-8'));
        return;

      case '/arthur':
        // Serve Arthur chat UI
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync(ARTHUR_UI_PATH, 'utf-8'));
        return;

      case '/dashboard/ui':
        // Serve Dashboard UI
        res.setHeader('Content-Type', 'text/html');
        res.end(fs.readFileSync(DASHBOARD_PATH, 'utf-8'));
        return;

      case '/health':
        result = { status: 'ok', server: 'oracle-v2', port: PORT };
        break;

      case '/search':
        if (!query.q) {
          res.statusCode = 400;
          result = { error: 'Missing query parameter: q' };
        } else {
          const searchResult = handleSearch(
            query.q as string,
            (query.type as string) || 'all',
            parseInt(query.limit as string) || 10,
            parseInt(query.offset as string) || 0
          );
          result = {
            ...searchResult,
            query: query.q
          };
        }
        break;

      case '/consult':
        if (!query.q) {
          res.statusCode = 400;
          result = { error: 'Missing query parameter: q (decision)' };
        } else {
          result = handleConsult(
            query.q as string,
            (query.context as string) || ''
          );
        }
        break;

      case '/reflect':
        result = handleReflect();
        break;

      case '/stats':
        result = handleStats();
        break;

      case '/list':
        result = handleList(
          (query.type as string) || 'all',
          parseInt(query.limit as string) || 10,
          parseInt(query.offset as string) || 0,
          query.group !== 'false'  // default true, pass group=false to disable
        );
        break;

      case '/graph':
        result = handleGraph();
        break;

      // Dashboard endpoints
      case '/dashboard':
      case '/dashboard/summary':
        result = handleDashboardSummary();
        break;

      case '/dashboard/activity':
        result = handleDashboardActivity(
          parseInt(query.days as string) || 7
        );
        break;

      case '/dashboard/growth':
        result = handleDashboardGrowth(
          (query.period as string) || 'week'
        );
        break;

      case '/file':
        // Return full file content
        const filePath = query.path as string;
        if (!filePath) {
          result = { error: 'Missing path parameter' };
        } else {
          try {
            const fullPath = path.join(REPO_ROOT, filePath);

            // Security: resolve symlinks and verify path is within REPO_ROOT
            // This prevents path traversal attacks via symlinks
            let realPath: string;
            try {
              realPath = fs.realpathSync(fullPath);
            } catch {
              // File doesn't exist - use resolved path for bounds check
              realPath = path.resolve(fullPath);
            }

            // Get real REPO_ROOT path (in case it contains symlinks)
            const realRepoRoot = fs.realpathSync(REPO_ROOT);

            if (!realPath.startsWith(realRepoRoot)) {
              result = { error: 'Invalid path: outside repository bounds' };
            } else if (fs.existsSync(fullPath)) {
              const content = fs.readFileSync(fullPath, 'utf-8');
              result = { path: filePath, content };
            } else {
              result = { error: 'File not found' };
            }
          } catch (e: any) {
            result = { error: e.message };
          }
        }
        break;

      default:
        res.statusCode = 404;
        result = {
          error: 'Not found',
          endpoints: [
            'GET /health - Health check',
            'GET /search?q=... - Search Oracle',
            'GET /list - Browse all documents',
            'GET /consult?q=... - Get guidance',
            'GET /reflect - Random wisdom',
            'GET /stats - Database stats',
            'GET /graph - Knowledge graph data',
            'POST /learn - Add new pattern/learning',
            'GET /dashboard - Dashboard summary',
            'GET /dashboard/activity?days=7 - Recent activity',
            'GET /dashboard/growth?period=week - Growth over time'
          ]
        };
    }

    res.end(JSON.stringify(result, null, 2));
  } catch (error) {
    res.statusCode = 500;
    res.end(JSON.stringify({
      error: error instanceof Error ? error.message : 'Unknown error'
    }));
  }
});

// Start server
server.listen(PORT, () => {
  console.log(`
🔮 Oracle v2 HTTP Server running!

   URL: http://localhost:${PORT}

   Endpoints:
   - GET /health          Health check
   - GET /search?q=...    Search Oracle knowledge
   - GET /list            Browse all documents
   - GET /consult?q=...   Get guidance on decision
   - GET /reflect         Random wisdom
   - GET /stats           Database statistics
   - GET /graph           Knowledge graph data
   - POST /learn          Add new pattern/learning

   Examples:
   curl http://localhost:${PORT}/health
   curl http://localhost:${PORT}/search?q=nothing+deleted
   curl http://localhost:${PORT}/list?type=learning&limit=5
   curl http://localhost:${PORT}/consult?q=force+push
   curl http://localhost:${PORT}/reflect
   curl http://localhost:${PORT}/stats
   curl http://localhost:${PORT}/graph
   curl -X POST http://localhost:${PORT}/learn -H "Content-Type: application/json" \\
     -d '{"pattern":"Always verify before destructive operations","concepts":["safety","git"]}'
`);
});

// Cleanup on exit
process.on('SIGINT', () => {
  db.close();
  process.exit(0);
});
