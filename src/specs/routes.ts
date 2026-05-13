import fs from 'fs';
import path from 'path';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { searchIndexUpsert, searchIndexDelete } from '../search/routes.ts';
import { addMessage } from '../forum/handler.ts';

// ============================================================================
// Specs — Spec Review SDD Workflow (Phase 1.11 of Library #102)
// Mechanical extraction, no logic changes.
// ============================================================================

interface SpecsHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  isTrustedRequest: (c: Context) => boolean;
  wsBroadcast: (event: string, data: any) => void;
}

export function registerSpecsRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: SpecsHelpers): void {
  const { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast } = helpers;
  const sqlite: Database = sqliteDb;

  // ============================================================================
  // Spec Review — SDD Workflow
  // ============================================================================

  // Create spec_reviews table
  try { sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS spec_reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      repo TEXT NOT NULL,
      file_path TEXT NOT NULL,
      task_id TEXT,
      title TEXT NOT NULL,
      author TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      reviewer_feedback TEXT,
      reviewed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(repo, file_path)
    )
  `).run(); } catch { /* exists */ }

  // Migration: add thread_id to spec_reviews (T#413)
  try { sqlite.prepare('ALTER TABLE spec_reviews ADD COLUMN thread_id INTEGER').run(); } catch { /* exists */ }

  // T#425: spec multi-linking junction table (many-to-many for tasks + threads)
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS spec_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id INTEGER NOT NULL REFERENCES spec_reviews(id),
      link_type TEXT NOT NULL CHECK(link_type IN ('task', 'thread')),
      link_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(spec_id, link_type, link_id)
    )
  `).run();
  try { sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_spec_links_spec ON spec_links(spec_id)').run(); } catch { /* exists */ }
  try { sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_spec_links_target ON spec_links(link_type, link_id)').run(); } catch { /* exists */ }

  // Migrate existing spec_reviews task_id/thread_id into spec_links
  try {
    const specsWithLinks = sqlite.prepare("SELECT id, task_id, thread_id FROM spec_reviews WHERE task_id IS NOT NULL OR thread_id IS NOT NULL").all() as any[];
    const insertLink = sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)');
    for (const s of specsWithLinks) {
      if (s.task_id) {
        const taskNum = parseInt(String(s.task_id).replace(/\D/g, ''), 10);
        if (!isNaN(taskNum)) insertLink.run(s.id, 'task', taskNum, new Date().toISOString());
      }
      if (s.thread_id) insertLink.run(s.id, 'thread', s.thread_id, new Date().toISOString());
    }
  } catch { /* migration already done or no data */ }

  const ALLOWED_SPEC_REPOS = ['denbook', 'supply-chain-tool', 'karo', 'zaghnal', 'gnarl', 'bertus', 'flint', 'pip', 'dex', 'talon', 'quill', 'sable', 'nyx', 'vigil', 'rax', 'leonard', 'mara', 'snap', 'beast-blueprint'];

  function resolveSpecPath(repo: string, filePath: string): string | null {
    if (!ALLOWED_SPEC_REPOS.includes(repo)) return null;
    if (!filePath.endsWith('.md')) return null;
    const baseDir = path.resolve(`/home/gorn/workspace/${repo}`);
    const resolved = path.resolve(baseDir, filePath);
    if (!resolved.startsWith(baseDir + '/')) return null;
    const relative = resolved.slice(baseDir.length + 1);
    if (!relative.startsWith('docs/specs/')) return null;
    return resolved;
  }

  // T#754 / Spec #57 Phase 1 — spec_versions table for amendment + version chain
  sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS spec_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id INTEGER NOT NULL REFERENCES spec_reviews(id),
      version TEXT NOT NULL,
      content TEXT NOT NULL,
      stamped_at TEXT NOT NULL,
      stamped_by TEXT NOT NULL,
      change_summary TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(spec_id, version)
    )
  `).run();
  try { sqlite.prepare('CREATE INDEX IF NOT EXISTS idx_spec_versions_spec ON spec_versions(spec_id)').run(); } catch { /* exists */ }

  // Add current_version to spec_reviews (default v1, snapshot tracking pointer)
  try { sqlite.prepare("ALTER TABLE spec_reviews ADD COLUMN current_version TEXT DEFAULT 'v1'").run(); } catch { /* exists */ }

  // Backfill: every existing approved spec gets v1 row in spec_versions if not present.
  // Skips specs whose markdown file is not on disk (consistent with /content endpoint).
  try {
    const approvedSpecs = sqlite.prepare("SELECT id, repo, file_path, reviewed_at, updated_at FROM spec_reviews WHERE status = 'approved'").all() as any[];
    const insertVersion = sqlite.prepare(
      'INSERT OR IGNORE INTO spec_versions (spec_id, version, content, stamped_at, stamped_by, change_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    const nowIso = new Date().toISOString();
    for (const s of approvedSpecs) {
      const resolved = resolveSpecPath(s.repo, s.file_path);
      if (!resolved) continue;
      let content: string;
      try { content = fs.readFileSync(resolved, 'utf-8'); } catch { continue; }
      insertVersion.run(s.id, 'v1', content, s.reviewed_at || s.updated_at, 'gorn', 'v1 (initial approval, backfilled)', nowIso);
    }
  } catch { /* backfill safe to skip on re-run */ }

  // Helper: parse 'vN' to N, return null if not a vN string
  function parseVersionN(version: string): number | null {
    const m = /^v(\d+)$/.exec(version);
    return m ? parseInt(m[1], 10) : null;
  }

  // Helper: get next version label after the highest existing version for a spec
  function nextVersionFor(specId: number): string {
    const rows = sqlite.prepare('SELECT version FROM spec_versions WHERE spec_id = ?').all(specId) as any[];
    let max = 0;
    for (const r of rows) {
      const n = parseVersionN(r.version);
      if (n !== null && n > max) max = n;
    }
    return `v${max + 1}`;
  }

  // GET /api/specs — list all specs
  app.get('/api/specs', (c) => {
    const status = c.req.query('status');
    const repo = c.req.query('repo');
    let query = 'SELECT * FROM spec_reviews WHERE 1=1';
    const params: any[] = [];
    if (status) { query += ' AND status = ?'; params.push(status); }
    if (repo) { query += ' AND repo = ?'; params.push(repo); }
    query += ' ORDER BY CASE status WHEN \'pending\' THEN 0 WHEN \'rejected\' THEN 1 WHEN \'approved\' THEN 2 END, updated_at DESC';
    const specs = sqlite.prepare(query).all(...params) as any[];
    // Attach links to each spec (T#425)
    for (const spec of specs) {
      const links = sqlite.prepare('SELECT link_type, link_id FROM spec_links WHERE spec_id = ?').all(spec.id) as any[];
      spec.linked_tasks = links.filter(l => l.link_type === 'task').map(l => l.link_id);
      spec.linked_threads = links.filter(l => l.link_type === 'thread').map(l => l.link_id);
    }
    return c.json({ specs });
  });

  // GET /api/specs/:id — get spec detail (with linked tasks + threads)
  app.get('/api/specs/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    const resolved = resolveSpecPath(spec.repo, spec.file_path);
    if (resolved) {
      try { spec.content = fs.readFileSync(resolved, 'utf-8'); } catch { spec.content = null; }
    }
    // Attach linked tasks and threads (T#425)
    const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ? ORDER BY link_type, link_id').all(id) as any[];
    spec.linked_tasks = links.filter(l => l.link_type === 'task').map(l => l.link_id);
    spec.linked_threads = links.filter(l => l.link_type === 'thread').map(l => l.link_id);
    return c.json(spec);
  });

  // GET /api/specs/:id/content — raw markdown content from repo (or historical version via ?version=vN)
  app.get('/api/specs/:id/content', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT repo, file_path, current_version FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);

    // T#755 / Spec #57 Phase 2: serve historical version if ?version=vN specified
    const versionParam = c.req.query('version');
    if (versionParam) {
      const row = sqlite.prepare('SELECT * FROM spec_versions WHERE spec_id = ? AND version = ?').get(id, versionParam) as any;
      if (!row) return c.json({ error: `Version ${versionParam} not found for spec #${id}` }, 404);
      return c.json({ content: row.content, version: row.version, stamped_at: row.stamped_at, stamped_by: row.stamped_by, change_summary: row.change_summary, file_path: spec.file_path, repo: spec.repo });
    }

    // Default: serve current on-disk content
    const resolved = resolveSpecPath(spec.repo, spec.file_path);
    if (!resolved) return c.json({ error: 'Invalid spec path' }, 400);
    try {
      const content = fs.readFileSync(resolved, 'utf-8');
      return c.json({ content, file_path: spec.file_path, repo: spec.repo, current_version: spec.current_version || 'v1' });
    } catch {
      return c.json({ error: 'Spec file not found on disk' }, 404);
    }
  });

  // T#755 / Spec #57 Phase 2: GET /api/specs/:id/versions — list all version snapshots
  app.get('/api/specs/:id/versions', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT id, current_version FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    const versions = sqlite.prepare(
      'SELECT version, stamped_at, stamped_by, change_summary, created_at FROM spec_versions WHERE spec_id = ? ORDER BY created_at ASC'
    ).all(id) as any[];
    return c.json({ spec_id: id, current_version: spec.current_version || 'v1', versions });
  });

  // GET /api/specs/:id/history — git log for spec file
  app.get('/api/specs/:id/history', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT repo, file_path FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    const repoDir = path.resolve(`/home/gorn/workspace/${spec.repo}`);
    if (!ALLOWED_SPEC_REPOS.includes(spec.repo)) return c.json({ error: 'Invalid repo' }, 400);
    try {
      const { execSync } = require('child_process');
      const log = execSync(
        `git log --format='{"hash":"%H","short":"%h","date":"%aI","subject":"%s","author":"%an"}' -- "${spec.file_path}"`,
        { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }
      ).trim();
      const versions = log ? log.split('\n').map((line: string) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean) : [];
      return c.json({ versions, file_path: spec.file_path, repo: spec.repo });
    } catch {
      return c.json({ versions: [], file_path: spec.file_path, repo: spec.repo });
    }
  });

  // GET /api/specs/:id/diff — diff between two versions of spec file
  app.get('/api/specs/:id/diff', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT repo, file_path FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    if (!ALLOWED_SPEC_REPOS.includes(spec.repo)) return c.json({ error: 'Invalid repo' }, 400);
    const from = c.req.query('from');
    const to = c.req.query('to') || 'HEAD';
    if (!from) return c.json({ error: 'from query param required (commit hash)' }, 400);
    // Validate hashes are hex only (prevent injection)
    if (!/^[a-f0-9]+$/i.test(from) || !/^[a-f0-9]+$/i.test(to) && to !== 'HEAD') {
      return c.json({ error: 'Invalid commit hash' }, 400);
    }
    const repoDir = path.resolve(`/home/gorn/workspace/${spec.repo}`);
    try {
      const { execSync } = require('child_process');
      const diff = execSync(
        `git diff ${from} ${to} -- "${spec.file_path}"`,
        { cwd: repoDir, encoding: 'utf-8', timeout: 5000 }
      );
      return c.json({ diff, from, to, file_path: spec.file_path, repo: spec.repo });
    } catch {
      return c.json({ diff: '', from, to, file_path: spec.file_path, repo: spec.repo });
    }
  });

  // POST /api/specs — register a spec for review
  app.post('/api/specs', async (c) => {
    try {
      const data = await c.req.json();
      const { repo, file_path, task_id, thread_id, title } = data;
      if (!repo || !file_path || !title) {
        return c.json({ error: 'repo, file_path, title required' }, 400);
      }
      if (!task_id && !thread_id) {
        return c.json({ error: 'At least one of task_id or thread_id is required. Link your spec to a task or forum thread.' }, 400);
      }
      if (!ALLOWED_SPEC_REPOS.includes(repo)) {
        return c.json({ error: `Invalid repo. Allowed: ${ALLOWED_SPEC_REPOS.join(', ')}` }, 400);
      }
      // T#718 — derive author from auth, reject client-asserted mismatch
      const caller = requireBeastIdentity(c);
      if (!caller) {
        return c.json({ error: 'Beast identity required — bearer-token or owner session', requiresAuth: true }, 401);
      }
      if (data.author && data.author.toLowerCase() !== caller) {
        return c.json({ error: 'Author impersonation blocked. body.author must match authenticated caller or be omitted.' }, 403);
      }
      const author = caller;
      const now = new Date().toISOString();
      const result = sqlite.prepare(
        'INSERT INTO spec_reviews (repo, file_path, task_id, thread_id, title, author, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(repo, file_path, task_id || null, thread_id || null, title, author, 'pending', now, now);
      const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get((result as any).lastInsertRowid) as any;
      // Auto-link spec to task if task_id provided
      if (task_id) {
        const taskIdNum = parseInt(String(task_id).replace(/\D/g, ''), 10);
        if (!isNaN(taskIdNum)) {
          sqlite.prepare('UPDATE tasks SET spec_id = ?, updated_at = ? WHERE id = ?').run(spec.id, now, taskIdNum);
          sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)').run(spec.id, 'task', taskIdNum, now);
        }
      }
      // Auto-link spec to thread if thread_id provided (T#425)
      if (thread_id) {
        sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)').run(spec.id, 'thread', parseInt(thread_id), now);
      }
          const specFilePath = path.join(import.meta.dirname || __dirname, '..', spec.file_path);
      const specContent = fs.existsSync(specFilePath) ? fs.readFileSync(specFilePath, 'utf-8') : spec.title;
      searchIndexUpsert('spec', spec.id, spec.title, specContent, spec.author, now);
      wsBroadcast('spec_submitted', { id: spec.id });
      return c.json(spec, 201);
    } catch (e: any) {
      if (e?.message?.includes('UNIQUE')) return c.json({ error: 'Spec already registered for this repo + path' }, 409);
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  // POST /api/specs/:id/review — approve or reject (Gorn only)
  app.post('/api/specs/:id/review', async (c) => {
    if (!hasSessionAuth(c)) {
      return c.json({ error: 'Spec review requires Gorn authentication' }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    if (spec.status !== 'pending' && spec.status !== 'reopened-amendment') {
      return c.json({ error: 'Only pending or reopened-amendment specs can be reviewed' }, 400);
    }
    try {
      const data = await c.req.json();
      const { action, feedback } = data;
      if (!action || !['approve', 'reject'].includes(action)) {
        return c.json({ error: 'action must be approve or reject' }, 400);
      }
      if (action === 'reject' && !feedback?.trim()) {
        return c.json({ error: 'Feedback required when rejecting a spec' }, 400);
      }
      const now = new Date().toISOString();
      const status = action === 'approve' ? 'approved' : 'rejected';
      // T#754 / Spec #57 Phase 1: on approve from reopened-amendment, snapshot the new version
      let newVersion: string | null = null;
      if (action === 'approve' && spec.status === 'reopened-amendment') {
        const resolved = resolveSpecPath(spec.repo, spec.file_path);
        if (!resolved) return c.json({ error: 'Cannot snapshot — invalid spec path' }, 500);
        let content: string;
        try { content = fs.readFileSync(resolved, 'utf-8'); } catch { return c.json({ error: 'Cannot snapshot — spec file not found on disk' }, 500); }
        newVersion = nextVersionFor(id);
        sqlite.prepare(
          'INSERT INTO spec_versions (spec_id, version, content, stamped_at, stamped_by, change_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(id, newVersion, content, now, 'gorn', feedback || null, now);
        sqlite.prepare('UPDATE spec_reviews SET current_version = ? WHERE id = ?').run(newVersion, id);
      }
      sqlite.prepare(
        'UPDATE spec_reviews SET status = ?, reviewer_feedback = ?, reviewed_at = ?, updated_at = ? WHERE id = ?'
      ).run(status, feedback || null, now, now, id);
      const updated = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
      wsBroadcast('spec_reviewed', { id: (updated as any).id, action });
      // Notify spec participants (assignee, creator, author, commenters)
      try {
        const { notifyMentioned } = await import('../forum/mentions.ts');
        const toNotify = new Set<string>();
        if (spec.author) toNotify.add(spec.author.toLowerCase());
        if (spec.task_id) {
          const taskIdNum = parseInt(spec.task_id.replace(/\D/g, ''), 10);
          if (!isNaN(taskIdNum)) {
            const task = sqlite.prepare('SELECT assigned_to, created_by, title FROM tasks WHERE id = ?').get(taskIdNum) as any;
            if (task?.assigned_to) toNotify.add(task.assigned_to.toLowerCase());
            if (task?.created_by) toNotify.add(task.created_by.toLowerCase());
          }
        }
        const specParticipants = sqlite.prepare('SELECT DISTINCT author FROM spec_comments WHERE spec_id = ?').all(id) as any[];
        for (const p of specParticipants) { if (p.author) toNotify.add(p.author.toLowerCase()); }
        toNotify.delete('gorn');
        const commentContent = action === 'approve'
          ? `Spec approved by Gorn.${feedback ? ` ${feedback}` : ''} Implementation unblocked.`
          : `Spec rejected by Gorn: ${feedback}`;
        if (toNotify.size > 0) {
          notifyMentioned([...toNotify], 0, `Spec #${id}: ${spec.title}`, 'gorn', `Spec ${action}d: ${commentContent.slice(0, 100)}`, {
            type: 'Specs', label: `Spec #${id}`, hint: `Use /spec to view spec details.`,
          });
        }
      } catch { /* notification failure is non-critical */ }

      // Auto-post to ALL linked forum threads (per Gorn: threads only, no task comments)
      const linkedThreads = sqlite.prepare("SELECT link_id FROM spec_links WHERE spec_id = ? AND link_type = 'thread'").all(id) as any[];
      // Also include legacy thread_id
      const threadIds = new Set<number>(linkedThreads.map((l: any) => l.link_id));
      if (updated.thread_id) threadIds.add(updated.thread_id);
      for (const threadId of threadIds) {
        try {
          const threadMsg = action === 'approve'
            ? `Spec #${id} **approved** by Gorn.${feedback ? ` ${feedback}` : ''} Implementation unblocked.`
            : `Spec #${id} **rejected** by Gorn: ${feedback}`;
          addMessage(threadId, 'claude', threadMsg, { author: 'system' });
        } catch { /* thread post failure is non-critical */ }
      }

      return c.json(updated);
    } catch {
      return c.json({ error: 'Invalid JSON' }, 400);
    }
  });

  // GET /api/specs/:id/links — list all links for a spec (T#425)
  app.get('/api/specs/:id/links', (c) => {
    const specId = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT id FROM spec_reviews WHERE id = ?').get(specId);
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ? ORDER BY link_type, link_id').all(specId) as any[];
    return c.json({ links, linked_tasks: links.filter(l => l.link_type === 'task').map(l => l.link_id), linked_threads: links.filter(l => l.link_type === 'thread').map(l => l.link_id) });
  });

  // POST /api/specs/:id/link — add a task or thread link (T#425)
  app.post('/api/specs/:id/link', async (c) => {
    const specId = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(specId) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    try {
      const data = await c.req.json();
      const { link_type, link_id } = data;
      if (!link_type || !['task', 'thread'].includes(link_type)) return c.json({ error: 'link_type must be task or thread' }, 400);
      if (!link_id || isNaN(parseInt(link_id))) return c.json({ error: 'link_id required (integer)' }, 400);
      const now = new Date().toISOString();
      sqlite.prepare('INSERT OR IGNORE INTO spec_links (spec_id, link_type, link_id, created_at) VALUES (?, ?, ?, ?)').run(specId, link_type, parseInt(link_id), now);
      // If linking a task, also set spec_id on the task
      if (link_type === 'task') {
        sqlite.prepare('UPDATE tasks SET spec_id = ?, updated_at = ? WHERE id = ? AND (spec_id IS NULL OR spec_id = ?)').run(specId, now, parseInt(link_id), specId);
      }
      const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ?').all(specId) as any[];
      return c.json({ success: true, links });
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // DELETE /api/specs/:id/link — remove a task or thread link (T#425)
  app.delete('/api/specs/:id/link', async (c) => {
    const specId = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(specId) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    try {
      const data = await c.req.json();
      const { link_type, link_id } = data;
      if (!link_type || !link_id) return c.json({ error: 'link_type and link_id required' }, 400);
      sqlite.prepare('DELETE FROM spec_links WHERE spec_id = ? AND link_type = ? AND link_id = ?').run(specId, link_type, parseInt(link_id));
      const links = sqlite.prepare('SELECT * FROM spec_links WHERE spec_id = ?').all(specId) as any[];
      return c.json({ success: true, links });
    } catch { return c.json({ error: 'Invalid request' }, 400); }
  });

  // GET /api/specs/by-task/:taskId — find specs linked to a task (T#425)
  app.get('/api/specs/by-task/:taskId', (c) => {
    const taskId = parseInt(c.req.param('taskId'), 10);
    const specs = sqlite.prepare(
      "SELECT sr.* FROM spec_reviews sr JOIN spec_links sl ON sr.id = sl.spec_id WHERE sl.link_type = 'task' AND sl.link_id = ? ORDER BY sr.updated_at DESC"
    ).all(taskId);
    return c.json({ specs });
  });

  // GET /api/specs/by-thread/:threadId — find specs linked to a thread (T#425)
  app.get('/api/specs/by-thread/:threadId', (c) => {
    const threadId = parseInt(c.req.param('threadId'), 10);
    const specs = sqlite.prepare(
      "SELECT sr.* FROM spec_reviews sr JOIN spec_links sl ON sr.id = sl.spec_id WHERE sl.link_type = 'thread' AND sl.link_id = ? ORDER BY sr.updated_at DESC"
    ).all(threadId);
    return c.json({ specs });
  });

  // POST /api/specs/:id/resubmit — reset rejected/reopened spec to pending (author/assignee only)
  app.post('/api/specs/:id/resubmit', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    if (spec.status === 'approved') return c.json({ error: 'Approved specs cannot be resubmitted directly — POST /api/specs/:id/reopen first to enter reopened-amendment state' }, 400);
    // Require identity — only spec author or task assignee can resubmit
    let requester: string;
    try {
      const data = await c.req.json();
      requester = (data.author || data.beast || '').toLowerCase();
    } catch {
      requester = (c.req.query('as') || '').toLowerCase();
    }
    if (!requester) return c.json({ error: 'Identity required: pass author in body or ?as= param' }, 400);
    const allowed = new Set<string>();
    if (spec.author) allowed.add(spec.author.toLowerCase());
    if (spec.task_id) {
      const taskIdNum = parseInt(String(spec.task_id).replace(/\D/g, ''), 10);
      if (!isNaN(taskIdNum)) {
        const task = sqlite.prepare('SELECT assigned_to FROM tasks WHERE id = ?').get(taskIdNum) as any;
        if (task?.assigned_to) allowed.add(task.assigned_to.toLowerCase());
      }
    }
    if (!allowed.has(requester) && requester !== 'gorn') {
      return c.json({ error: `Only the spec author (${spec.author}) or task assignee can resubmit` }, 403);
    }
    const now = new Date().toISOString();
    // Preserve rejection history as a spec comment before clearing
    if (spec.reviewer_feedback) {
      sqlite.prepare(
        'INSERT INTO spec_comments (spec_id, author, content, created_at) VALUES (?, ?, ?, ?)'
      ).run(id, 'system', `**Previous review (${spec.status})**: ${spec.reviewer_feedback}`, spec.reviewed_at || now);
    }
    sqlite.prepare(
      'UPDATE spec_reviews SET status = ?, reviewer_feedback = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?'
    ).run('pending', now, id);
    const updated = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id);
    wsBroadcast('spec_resubmitted', { id: (updated as any).id });
    return c.json(updated);
  });

  // T#754 / Spec #57 Phase 1 — POST /api/specs/:id/reopen
  // Snapshot current approved content as historical version, transition status to reopened-amendment.
  // Only spec author + sable + gorn may reopen (per spec threat model).
  app.post('/api/specs/:id/reopen', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const spec = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    if (spec.status !== 'approved') {
      return c.json({ error: `Only approved specs can be reopened (current status: ${spec.status})` }, 400);
    }

    let body: any = {};
    try { body = await c.req.json(); } catch { /* allow empty */ }
    const reason = (body.reason || '').trim();
    if (!reason) return c.json({ error: 'reason required to reopen an approved spec' }, 400);

    const requester = (body.author || c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (!requester) return c.json({ error: 'Identity required: pass author in body or ?as= param' }, 400);
    const allowed = new Set<string>(['sable', 'gorn']);
    if (spec.author) allowed.add(spec.author.toLowerCase());
    if (!allowed.has(requester)) {
      return c.json({ error: `Only the spec author (${spec.author}), Sable, or Gorn can reopen approved specs` }, 403);
    }

    const resolved = resolveSpecPath(spec.repo, spec.file_path);
    if (!resolved) return c.json({ error: 'Cannot snapshot — invalid spec path' }, 500);
    let content: string;
    try { content = fs.readFileSync(resolved, 'utf-8'); } catch {
      return c.json({ error: 'Cannot snapshot — spec file not found on disk' }, 500);
    }

    const now = new Date().toISOString();
    // Snapshot the current approved content as the existing current_version (default v1
    // for specs that predate the version chain — backfill should have populated this already
    // but if the file changed since backfill we re-capture the current state).
    const currentVersion: string = spec.current_version || 'v1';
    sqlite.prepare(
      'INSERT OR IGNORE INTO spec_versions (spec_id, version, content, stamped_at, stamped_by, change_summary, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, currentVersion, content, spec.reviewed_at || spec.updated_at, 'gorn', `${currentVersion} (snapshot at reopen)`, now);

    // Transition status; preserve current_version pointer (still points at currentVersion until next stamp).
    sqlite.prepare(
      "UPDATE spec_reviews SET status = 'reopened-amendment', reviewer_feedback = NULL, reviewed_at = NULL, updated_at = ? WHERE id = ?"
    ).run(now, id);

    // Record reopen as a spec comment for audit trail.
    sqlite.prepare(
      'INSERT INTO spec_comments (spec_id, author, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(id, requester, `**Spec reopened for amendment** (snapshot ${currentVersion}). Reason: ${reason}`, now);

    const updated = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id);
    wsBroadcast('spec_reopened', { id: (updated as any).id });
    return c.json(updated);
  });

  // DELETE /api/specs/:id — delete spec (Gorn or Pip)
  app.delete('/api/specs/:id', async (c) => {
    const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (requester !== 'gorn' && requester !== 'pip') {
      return c.json({ error: 'Only Gorn or Pip can delete specs' }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT * FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Spec not found' }, 404);
    sqlite.prepare('DELETE FROM spec_reviews WHERE id = ?').run(id);
    wsBroadcast('spec_deleted', { id: (existing as any).id });
    return c.json({ deleted: true, id });
  });

  // ============================================================================
  // Spec Comments (T#332)
  // ============================================================================

  try { sqlite.prepare(`
    CREATE TABLE IF NOT EXISTS spec_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      spec_id INTEGER NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run(); } catch { /* exists */ }

  // GET /api/specs/:id/comments
  app.get('/api/specs/:id/comments', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const spec = sqlite.prepare('SELECT id FROM spec_reviews WHERE id = ?').get(id);
    if (!spec) return c.json({ error: 'Spec not found' }, 404);
    const limit = Math.min(100, parseInt(c.req.query('limit') || '30', 10));
    const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
    const total = (sqlite.prepare('SELECT COUNT(*) as c FROM spec_comments WHERE spec_id = ?').get(id) as any).c;
    // Return most recent comments: order DESC for pagination, then reverse for display
    const comments = sqlite.prepare('SELECT * FROM spec_comments WHERE spec_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?').all(id, limit, offset) as any[];
    comments.reverse();
    return c.json({ comments, total });
  });

  // GET /api/spec-comments/:commentId — single comment by ID
  app.get('/api/spec-comments/:commentId', (c) => {
    const commentId = parseInt(c.req.param('commentId'), 10);
    if (isNaN(commentId)) return c.json({ error: 'Invalid ID' }, 400);
    const comment = sqlite.prepare('SELECT * FROM spec_comments WHERE id = ?').get(commentId);
    if (!comment) return c.json({ error: 'Comment not found' }, 404);
    return c.json(comment);
  });

  // POST /api/specs/:id/comments
  app.post('/api/specs/:id/comments', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const spec = sqlite.prepare('SELECT id, title, author FROM spec_reviews WHERE id = ?').get(id) as any;
    if (!spec) return c.json({ error: 'Spec not found' }, 404);

    try {
      const data = await c.req.json();
      const author = (c.req.query('as') || data.author || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
      if (!author) return c.json({ error: 'Identity required: pass ?as=beast or author in body' }, 400);
      if (!data.content?.trim()) return c.json({ error: 'content required' }, 400);

      const contentText = data.content.trim();
      const result = sqlite.prepare(
        'INSERT INTO spec_comments (spec_id, author, content) VALUES (?, ?, ?)'
      ).run(id, author, contentText);

      const comment = sqlite.prepare('SELECT * FROM spec_comments WHERE id = ?').get((result as any).lastInsertRowid);
      wsBroadcast('spec_comment', { action: 'comment', spec_id: id, comment_id: (comment as any).id });

      // Notify spec author + previous commenters + @mentions
      try {
        const { parseMentions, notifyMentioned } = await import('../forum/mentions.ts');
        const toNotify = new Set<string>();
        // Spec author
        if (spec.author && spec.author.toLowerCase() !== author) toNotify.add(spec.author.toLowerCase());
        // Previous commenters
        const prevCommenters = sqlite.prepare(
          'SELECT DISTINCT author FROM spec_comments WHERE spec_id = ? AND author != ?'
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
            `Spec #${id}: ${spec.title || 'Untitled'}`,
            author,
            `New comment on spec #${id}: ${contentText.slice(0, 100)}`,
            { type: 'Spec comment', label: `spec #${id}`, hint: `Use /spec ${id} to view. Reply with: curl -X POST http://localhost:47778/api/specs/${id}/comments?as=<you> -H 'Content-Type: application/json' -d '{\"content\":\"your reply\"}'` }
          );
        }
      } catch { /* notification failure is non-critical */ }

      return c.json(comment, 201);
    } catch {
      return c.json({ error: 'Invalid request' }, 400);
    }
  });


}
