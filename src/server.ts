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

const PORT = process.env.ORACLE_PORT || 37778;
const REPO_ROOT = process.env.ORACLE_REPO_ROOT || '/Users/nat/Code/github.com/laris-co/Nat-s-Agents';
const DB_PATH = path.join(REPO_ROOT, 'ψ/lab/oracle-v2/oracle.db');
const UI_PATH = path.join(REPO_ROOT, 'ψ/lab/oracle-v2/src/ui.html');
const ARTHUR_UI_PATH = path.join(REPO_ROOT, 'ψ/lab/oracle-jarvis/index.html');

// Initialize database
const db = new Database(DB_PATH);

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
 * Search Oracle knowledge base with pagination
 */
function handleSearch(query: string, type: string = 'all', limit: number = 10, offset: number = 0): SearchResponse {
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
            'POST /learn - Add new pattern/learning'
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
