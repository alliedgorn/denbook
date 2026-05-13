import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Database } from 'bun:sqlite';
import { searchIndexUpsert, searchIndexDelete } from '../search/routes.ts';

// ============================================================================
// Board routes — projects + tasks + task_comments + board summary
// (Phase 1.9 of Library #102 — mechanical extraction, no logic changes)
// ============================================================================

interface BoardHelpers {
  hasSessionAuth: (c: Context) => boolean;
  requireBeastIdentity: (c: Context) => string | null;
  isTrustedRequest: (c: Context) => boolean;
  wsBroadcast: (event: string, data: any) => void;
}

export function registerBoardRoutes(app: OpenAPIHono, sqliteDb: Database, helpers: BoardHelpers): void {
  const { hasSessionAuth, requireBeastIdentity, isTrustedRequest, wsBroadcast } = helpers;
  // Shadow sqlite for the verbatim block below
  const sqlite: Database = sqliteDb;


  // ============================================================================
  // PM Board — Projects + Tasks + Task Comments
  // ============================================================================

  // Create projects table
  try {
    sqlite.prepare(`CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`).run();
  } catch { /* already exists */ }

  // Create tasks table
  try {
    sqlite.prepare(`CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES projects(id),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority TEXT NOT NULL DEFAULT 'medium',
      assigned_to TEXT,
      created_by TEXT NOT NULL,
      thread_id INTEGER,
      due_date TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`).run();
    // v2: add type column
    try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN type TEXT DEFAULT 'task'`).run(); } catch { /* exists */ }
    // Backfill existing tasks with no type
    sqlite.prepare(`UPDATE tasks SET type = 'task' WHERE type IS NULL`).run();
    // v3: SDD enforcement columns (T#317)
    try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN approval_required INTEGER NOT NULL DEFAULT 0`).run(); } catch { /* exists */ }
    try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN spec_id INTEGER`).run(); } catch { /* exists */ }
    // v4: reviewer field for in_review workflow (T#418)
    try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN reviewer TEXT`).run(); } catch { /* exists */ }
    // v5: risk_level for QA triage (T#617)
    try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN risk_level TEXT DEFAULT 'medium'`).run(); } catch { /* exists */ }
    sqlite.prepare(`UPDATE tasks SET risk_level = 'medium' WHERE risk_level IS NULL`).run();
    // v6: parent_task_id for subtasks (Spec #56)
    try { sqlite.prepare(`ALTER TABLE tasks ADD COLUMN parent_task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL`).run(); } catch { /* exists */ }
    try { sqlite.prepare(`CREATE INDEX idx_tasks_parent_task_id ON tasks(parent_task_id) WHERE parent_task_id IS NOT NULL`).run(); } catch { /* exists */ }
  } catch { /* already exists */ }

  const VALID_TASK_TYPES = ['bug', 'feature', 'improvement', 'chore', 'task'];
  const VALID_RISK_LEVELS = ['high', 'medium', 'low'];

  function validateParentTaskId(parentTaskId: number, selfId?: number): string | null {
    const parent = sqlite.prepare('SELECT id, parent_task_id FROM tasks WHERE id = ? AND status != ?').get(parentTaskId, 'deleted') as any;
    if (!parent) return 'Parent task not found';
    if (parent.parent_task_id) return 'Cannot nest deeper than 2 levels — parent task is already a subtask';
    if (selfId !== undefined && parentTaskId === selfId) return 'Task cannot be its own parent';
    if (selfId !== undefined) {
      const children = sqlite.prepare('SELECT id FROM tasks WHERE parent_task_id = ? AND status != ?').all(selfId, 'deleted') as any[];
      if (children.length > 0) return 'Cannot make a parent task into a subtask — it already has subtasks';
    }
    return null;
  }

  function getSubtasksSummary(taskId: number): { count: number; done: number; in_progress: number; todo: number; blocked: number; in_review: number; backlog: number; cancelled: number } {
    const rows = sqlite.prepare('SELECT status, COUNT(*) as cnt FROM tasks WHERE parent_task_id = ? AND status != ? GROUP BY status').all(taskId, 'deleted') as any[];
    const summary = { count: 0, done: 0, in_progress: 0, todo: 0, blocked: 0, in_review: 0, backlog: 0, cancelled: 0 };
    for (const r of rows) {
      const s = r.status as keyof typeof summary;
      if (s in summary && s !== 'count') (summary as any)[s] = r.cnt;
      summary.count += r.cnt;
    }
    return summary;
  }

  // SDD enforcement: check if task can transition to in_progress or done
  function checkApprovalGate(task: any): string | null {
    if (!task.approval_required) return null;
    if (!task.spec_id) return "Gorn's spec approval required before starting. Submit a spec via /spec submit and wait for approval at /specs.";
    const spec = sqlite.prepare('SELECT status FROM spec_reviews WHERE id = ?').get(task.spec_id) as any;
    if (!spec || spec.status !== 'approved') return "Spec not yet approved. Wait for Gorn's approval at /specs before starting.";
    return null;
  }

  // Create task_comments table
  try {
    sqlite.prepare(`CREATE TABLE IF NOT EXISTS task_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL REFERENCES tasks(id),
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`).run();
  } catch { /* already exists */ }

  // --- Projects CRUD ---

  // GET /api/projects — list projects
  app.get('/api/projects', (c) => {
    const status = c.req.query('status');
    let rows;
    if (status) {
      rows = sqlite.prepare(
        'SELECT * FROM projects WHERE status = ? ORDER BY created_at DESC'
      ).all(status) as any[];
    } else {
      rows = sqlite.prepare(
        "SELECT * FROM projects ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 END, created_at DESC"
      ).all() as any[];
    }
    return c.json({ projects: rows });
  });

  // POST /api/projects — create project
  app.post('/api/projects', async (c) => {
    const data = await c.req.json();
    const { name, description, created_by } = data;
    if (!name || !created_by) return c.json({ error: 'name and created_by required' }, 400);
    const now = new Date().toISOString();
    const result = sqlite.prepare(
      'INSERT INTO projects (name, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(name, description || '', created_by, now, now);
    const project = sqlite.prepare('SELECT * FROM projects WHERE id = ?').get((result as any).lastInsertRowid);
    wsBroadcast('project_created', { id: (project as any).id });
    return c.json(project, 201);
  });

  // GET /api/projects/:id — get project with task counts
  app.get('/api/projects/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const project = sqlite.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    if (!project) return c.json({ error: 'Project not found' }, 404);
    const taskCounts = sqlite.prepare(
      'SELECT status, COUNT(*) as count FROM tasks WHERE project_id = ? GROUP BY status'
    ).all(id) as any[];
    return c.json({ ...project, task_counts: Object.fromEntries(taskCounts.map(r => [r.status, r.count])) });
  });

  // PATCH /api/projects/:id — update project
  app.patch('/api/projects/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const data = await c.req.json();
    const updates: string[] = [];
    const params: any[] = [];
    for (const field of ['name', 'description', 'status']) {
      if (data[field] !== undefined) { updates.push(`${field} = ?`); params.push(data[field]); }
    }
    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
    updates.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);
    sqlite.prepare(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const project = sqlite.prepare('SELECT * FROM projects WHERE id = ?').get(id);
    return c.json(project);
  });

  // DELETE /api/projects/:id — delete project (Gorn or Pip)
  app.delete('/api/projects/:id', (c) => {
    const requester = (c.req.query('as') || (hasSessionAuth(c) ? 'gorn' : '')).toLowerCase();
    if (requester !== 'gorn' && requester !== 'pip') {
      return c.json({ error: 'Only Gorn or Pip can delete projects' }, 403);
    }
    const id = parseInt(c.req.param('id'), 10);
    if (isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);
    const existing = sqlite.prepare('SELECT id FROM projects WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Project not found' }, 404);
    // Unlink tasks (set project_id to null) rather than deleting them
    sqlite.prepare('UPDATE tasks SET project_id = NULL WHERE project_id = ?').run(id);
    sqlite.prepare('DELETE FROM team_projects WHERE project_id = ?').run(id);
    sqlite.prepare('DELETE FROM projects WHERE id = ?').run(id);
    wsBroadcast('project_deleted', { id });
    return c.json({ deleted: true, id });
  });

  // --- Tasks CRUD ---

  // GET /api/tasks — list tasks with filters
  app.get('/api/tasks', (c) => {
    const projectId = c.req.query('project_id');
    const status = c.req.query('status');
    const assignedTo = c.req.query('assigned_to') || c.req.query('assignee');
    const priority = c.req.query('priority');
    const limit = Math.min(200, parseInt(c.req.query('limit') || '100', 10));
    const offset = parseInt(c.req.query('offset') || '0', 10);

    let query = 'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE 1=1';
    const params: any[] = [];

    // T#759: exclude soft-deleted tasks by default; ?include_deleted=true for audit/admin
    const includeDeleted = c.req.query('include_deleted') === 'true';
    if (!includeDeleted) { query += " AND t.status != 'deleted'"; }

    if (projectId) { query += ' AND t.project_id = ?'; params.push(parseInt(projectId, 10)); }
    if (status) {
      const statuses = status.split(',').map(s => s.trim()).filter(Boolean);
      if (statuses.length === 1) {
        query += ' AND t.status = ?'; params.push(statuses[0]);
      } else {
        query += ` AND t.status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
      }
    }
    if (assignedTo) { query += ' AND t.assigned_to = ?'; params.push(assignedTo); }
    if (priority) { query += ' AND t.priority = ?'; params.push(priority); }
    const type = c.req.query('type');
    if (type) { query += ' AND t.type = ?'; params.push(type); }
    const riskLevel = c.req.query('risk_level');
    if (riskLevel) { query += ' AND t.risk_level = ?'; params.push(riskLevel); }
    const parentId = c.req.query('parent_id');
    if (parentId === 'null') { query += ' AND t.parent_task_id IS NULL'; }
    else if (parentId) { query += ' AND t.parent_task_id = ?'; params.push(parseInt(parentId, 10)); }

    const countQuery = query.replace('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id', 'SELECT COUNT(*) as total FROM tasks t');
    const total = (sqlite.prepare(countQuery).get(...params) as any)?.total || 0;

    // Done tasks sort by most recently completed; others by priority then created_at
    if (status === 'done') {
      query += ' ORDER BY t.updated_at DESC';
    } else {
      query += ' ORDER BY CASE t.priority WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, t.created_at DESC';
    }
    query += ' LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const tasks = sqlite.prepare(query).all(...params) as any[];
    return c.json({ tasks, total });
  });

  // POST /api/tasks — create task
  app.post('/api/tasks', async (c) => {
    const data = await c.req.json();
    const { title, description, project_id, status, priority, assigned_to, created_by, thread_id, due_date, type, reviewer, risk_level, parent_task_id } = data;
    if (!title || !created_by) return c.json({ error: 'title and created_by required' }, 400);
    if (!project_id) return c.json({ error: 'project_id required — every task must belong to a project' }, 400);
    if (!assigned_to) return c.json({ error: 'assigned_to required — every task must have an assignee' }, 400);
    if (!reviewer) return c.json({ error: 'reviewer required — every task must have a reviewer for the in_review workflow' }, 400);
    if (parent_task_id != null) {
      const parsed = Number(parent_task_id);
      if (!Number.isInteger(parsed) || parsed <= 0) return c.json({ error: 'parent_task_id must be a positive integer' }, 400);
      const parentErr = validateParentTaskId(parsed);
      if (parentErr) return c.json({ error: parentErr }, 400);
    }

    const validStatuses = ['todo', 'backlog', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
    const validPriorities = ['critical', 'high', 'medium', 'low'];
    const taskStatus = validStatuses.includes(status) ? status : 'todo';
    const taskPriority = validPriorities.includes(priority) ? priority : 'medium';
    if (type && !VALID_TASK_TYPES.includes(type)) return c.json({ error: `Invalid type. Valid: ${VALID_TASK_TYPES.join(', ')}` }, 400);
    const taskType = type || 'task';
    if (risk_level && !VALID_RISK_LEVELS.includes(risk_level)) return c.json({ error: `Invalid risk_level. Valid: ${VALID_RISK_LEVELS.join(', ')}` }, 400);
    const taskRiskLevel = VALID_RISK_LEVELS.includes(risk_level) ? risk_level : 'medium';

    const now = new Date().toISOString();
    const approvalRequired = data.approval_required ? 1 : 0;
    const parentId = parent_task_id != null ? parseInt(String(parent_task_id), 10) : null;
    const result = sqlite.prepare(
      'INSERT INTO tasks (project_id, title, description, status, priority, assigned_to, created_by, thread_id, due_date, type, approval_required, reviewer, risk_level, parent_task_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).run(project_id || null, title, description || '', taskStatus, taskPriority, assigned_to || null, created_by, thread_id || null, due_date || null, taskType, approvalRequired, reviewer, taskRiskLevel, parentId, now, now);

    const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get((result as any).lastInsertRowid) as any;
    searchIndexUpsert('task', task.id, task.title, task.description || '', task.assigned_to || '', now, `/board?task=${task.id}`);
    wsBroadcast('task_created', { id: task.id });

    // Notify assignee + @mentioned beasts in description (T#378)
    try {
      const { parseMentions, notifyMentioned } = await import('../forum/mentions.ts');
      const toNotify = new Set<string>();

      // Add assignee
      if (task.assigned_to) toNotify.add(task.assigned_to.toLowerCase());

      // Parse @mentions from description
      if (task.description) {
        for (const name of parseMentions(task.description)) toNotify.add(name);
      }

      // Remove the creator (don't notify yourself)
      toNotify.delete(created_by.toLowerCase());

      if (toNotify.size > 0) {
        notifyMentioned(
          [...toNotify],
          0, // no thread
          task.title,
          created_by,
          `New task T#${task.id}: ${task.title}${task.assigned_to ? ` (assigned to @${task.assigned_to})` : ''}`,
          { type: 'PM Board', label: `task #${task.id}`, hint: `Use /board task ${task.id} to view.` },
        );
      }
    } catch { /* notification failure is non-critical */ }

    return c.json(task, 201);
  });

  // GET /api/tasks/:id — get task with comments
  app.get('/api/tasks/:id', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const task = sqlite.prepare(
      'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?'
    ).get(id) as any;
    if (!task) return c.json({ error: 'Task not found' }, 404);
    const comments = sqlite.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC').all(id) as any[];
    const subtasks = getSubtasksSummary(id);
    return c.json({ ...task, comments, subtasks: subtasks.count > 0 ? subtasks : undefined });
  });

  // PATCH /api/tasks/:id — update task
  app.patch('/api/tasks/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const existing = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
    if (!existing) return c.json({ error: 'Task not found' }, 404);

    const data = await c.req.json();

    const validStatuses = ['todo', 'backlog', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
    const validPriorities = ['critical', 'high', 'medium', 'low'];
    if (data.status && !validStatuses.includes(data.status)) return c.json({ error: `Invalid status. Valid: ${validStatuses.join(', ')}` }, 400);
    if (data.priority && !validPriorities.includes(data.priority)) return c.json({ error: `Invalid priority. Valid: ${validPriorities.join(', ')}` }, 400);
    if (data.type && !VALID_TASK_TYPES.includes(data.type)) return c.json({ error: `Invalid type. Valid: ${VALID_TASK_TYPES.join(', ')}` }, 400);
    if (data.risk_level && !VALID_RISK_LEVELS.includes(data.risk_level)) return c.json({ error: `Invalid risk_level. Valid: ${VALID_RISK_LEVELS.join(', ')}` }, 400);

    // Terminal status enforcement (T#529) — Done and Cancelled are final
    const terminalStatuses = ['done', 'cancelled'];
    if (data.status && terminalStatuses.includes((existing as any).status)) {
      return c.json({ error: `Cannot change status: task is ${(existing as any).status}. Done and Cancelled are terminal statuses.` }, 400);
    }

    // SDD enforcement: block forward transitions if approval_required and no approved spec
    if (data.status && ['in_progress', 'in_review', 'done'].includes(data.status)) {
      const gateError = checkApprovalGate(existing);
      if (gateError) return c.json({ error: gateError }, 400);
    }

    // Require reviewer when moving to in_review
    if (data.status === 'in_review') {
      const reviewer = data.reviewer || existing.reviewer;
      if (!reviewer) return c.json({ error: 'Reviewer required when moving to in_review. Set reviewer field.' }, 400);
    }

    if (data.parent_task_id !== undefined) {
      if (data.parent_task_id === null) {
        // Promote to top-level — allowed
      } else {
        const parsed = Number(data.parent_task_id);
        if (!Number.isInteger(parsed) || parsed <= 0) return c.json({ error: 'parent_task_id must be a positive integer' }, 400);
        const parentErr = validateParentTaskId(parsed, id);
        if (parentErr) return c.json({ error: parentErr }, 400);
      }
    }

    // Spec #56 E2: block parent project-change while children exist
    if (data.project_id !== undefined && data.project_id !== (existing as any).project_id) {
      const children = sqlite.prepare('SELECT COUNT(*) as cnt FROM tasks WHERE parent_task_id = ? AND status != ?').get(id, 'deleted') as any;
      if (children.cnt > 0) {
        return c.json({ error: 'Cannot change project on a parent task with subtasks — reparent subtasks first' }, 400);
      }
    }

    const updates: string[] = [];
    const params: any[] = [];
    for (const field of ['title', 'description', 'status', 'priority', 'assigned_to', 'project_id', 'thread_id', 'due_date', 'type', 'approval_required', 'spec_id', 'reviewer', 'risk_level', 'parent_task_id']) {
      if (data[field] !== undefined) { updates.push(`${field} = ?`); params.push(data[field]); }
    }
    if (updates.length === 0) return c.json({ error: 'No fields to update' }, 400);
    updates.push('updated_at = ?'); params.push(new Date().toISOString());
    params.push(id);

    sqlite.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    const task = sqlite.prepare('SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?').get(id) as any;
    if (task) searchIndexUpsert('task', id, task.title, task.description || '', task.assigned_to || '', task.created_at);
    wsBroadcast('task_updated', { id: task?.id });

    // Notify reviewer when task moves to in_review (T#439)
    if (data.status === 'in_review' && task?.reviewer) {
      try {
        const { notifyMentioned } = await import('../forum/mentions.ts');
        const updatedBy = data.updated_by || task.assigned_to || 'system';
        notifyMentioned([task.reviewer], 0, `T#${id}: ${task.title}`, updatedBy, `Task moved to in_review — you are the reviewer.`, {
          type: 'PM Board', label: `T#${id}`, hint: `Review at https://denbook.online/board?task=${id}`,
        });
      } catch { /* notification failure is non-critical */ }
    }

    return c.json(task);
  });

  // DELETE /api/tasks/:id — soft delete (set status to 'deleted') + orphan subtasks (Bertus C4)
  app.delete('/api/tasks/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const now = new Date().toISOString();
    sqlite.transaction(() => {
      sqlite.prepare('UPDATE tasks SET parent_task_id = NULL, updated_at = ? WHERE parent_task_id = ?').run(now, id);
      sqlite.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?').run('deleted', now, id);
    })();
    searchIndexDelete('task', id);
    return c.json({ success: true, id });
  });

  // GET /api/tasks/:id/subtree — parent + all direct subtasks in one call (Spec #56)
  app.get('/api/tasks/:id/subtree', (c) => {
    const id = parseInt(c.req.param('id'), 10);
    const parent = sqlite.prepare(
      'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.id = ?'
    ).get(id) as any;
    if (!parent) return c.json({ error: 'Task not found' }, 404);
    const subtasks = sqlite.prepare(
      'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.parent_task_id = ? AND t.status != ? ORDER BY t.created_at ASC'
    ).all(id, 'deleted') as any[];
    const summary = getSubtasksSummary(id);
    return c.json({ parent: { ...parent, subtasks: summary.count > 0 ? summary : undefined }, subtasks });
  });

  // POST /api/tasks/bulk-status — bulk status update (for PM)
  app.post('/api/tasks/bulk-status', async (c) => {
    const data = await c.req.json();
    const { task_ids, status } = data;
    if (!Array.isArray(task_ids) || !status) return c.json({ error: 'task_ids and status required' }, 400);

    const validStatuses = ['todo', 'backlog', 'in_progress', 'in_review', 'done', 'blocked', 'cancelled'];
    if (!validStatuses.includes(status)) return c.json({ error: 'Invalid status' }, 400);

    // SDD enforcement for bulk status
    if (['in_progress', 'in_review', 'done'].includes(status)) {
      const blocked: { id: number; error: string }[] = [];
      for (const id of task_ids) {
        const task = sqlite.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
        if (task) {
          const gateError = checkApprovalGate(task);
          if (gateError) blocked.push({ id, error: gateError });
        }
      }
      if (blocked.length > 0) return c.json({ error: 'Some tasks blocked by SDD approval gate', blocked }, 400);
    }

    const now = new Date().toISOString();
    const stmt = sqlite.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?');
    for (const id of task_ids) {
      stmt.run(status, now, id);
    }
    wsBroadcast('tasks_bulk_updated', { task_ids });
    return c.json({ success: true, updated: task_ids.length });
  });

  // --- Task Comments ---

  // GET /api/tasks/:id/comments
  app.get('/api/tasks/:id/comments', (c) => {
    const taskId = parseInt(c.req.param('id'), 10);
    const comments = sqlite.prepare('SELECT * FROM task_comments WHERE task_id = ? ORDER BY created_at ASC').all(taskId) as any[];
    return c.json({ comments });
  });

  // POST /api/tasks/:id/comments
  app.post('/api/tasks/:id/comments', async (c) => {
    const taskId = parseInt(c.req.param('id'), 10);
    const data = await c.req.json();
    const { author, content } = data;
    if (!author || !content) return c.json({ error: 'author and content required' }, 400);

    const now = new Date().toISOString();
    const result = sqlite.prepare(
      'INSERT INTO task_comments (task_id, author, content, created_at) VALUES (?, ?, ?, ?)'
    ).run(taskId, author, content, now);
    const comment = sqlite.prepare('SELECT * FROM task_comments WHERE id = ?').get((result as any).lastInsertRowid);

    // Notify task assignee, creator, and @mentioned beasts about the new comment
    try {
      const task = sqlite.prepare('SELECT assigned_to, created_by, reviewer, title FROM tasks WHERE id = ?').get(taskId) as any;
      if (task) {
        const { parseMentions, notifyMentioned } = await import('../forum/mentions.ts');
        const commenter = author.split('@')[0].toLowerCase();
        const toNotify = new Set<string>();
        // Notify assignee, creator, and reviewer (T#575)
        if (task.assigned_to && task.assigned_to !== commenter) toNotify.add(task.assigned_to.toLowerCase());
        if (task.created_by && task.created_by !== commenter) toNotify.add(task.created_by.toLowerCase());
        if (task.reviewer && task.reviewer !== commenter) toNotify.add(task.reviewer.toLowerCase());
        // Parse @mentions from comment content
        const mentions = parseMentions(content, 0);
        for (const m of mentions) toNotify.add(m.toLowerCase());
        toNotify.delete(commenter);
        toNotify.delete('gorn'); toNotify.delete('human'); toNotify.delete('user');
        if (toNotify.size > 0) {
          notifyMentioned(
            [...toNotify],
            0,
            `Task #${taskId}: ${task.title || 'Untitled'}`,
            commenter,
            `New comment on task #${taskId}: ${content.slice(0, 100)}`,
            {
              type: 'PM Board',
              label: `task #${taskId}`,
              hint: `Use /board task ${taskId} to view. Use /board comment ${taskId} <message> to reply.`,
            }
          );
        }
      }
    } catch { /* notification failure is non-critical */ }

    wsBroadcast('task_comment_added', { task_id: taskId, comment_id: (result as any).lastInsertRowid });
    return c.json(comment, 201);
  });

  // --- Board summary endpoint (for Kanban view) ---

  // GET /api/board — grouped by status with project filter
  app.get('/api/board', (c) => {
    const projectId = c.req.query('project_id');
    const assignedTo = c.req.query('assigned_to') || c.req.query('assignee');

    let query = 'SELECT t.*, p.name as project_name FROM tasks t LEFT JOIN projects p ON t.project_id = p.id WHERE t.status != \'deleted\'';
    const params: any[] = [];

    // Spec #56 Phase 3: board default is top-level only (parent_id IS NULL)
    const showSubtasks = c.req.query('show_subtasks');
    if (showSubtasks !== 'true') { query += ' AND t.parent_task_id IS NULL'; }

    if (projectId) { query += ' AND t.project_id = ?'; params.push(parseInt(projectId, 10)); }
    if (assignedTo) { query += ' AND t.assigned_to = ?'; params.push(assignedTo); }

    query += ' ORDER BY CASE t.priority WHEN \'critical\' THEN 0 WHEN \'high\' THEN 1 WHEN \'medium\' THEN 2 WHEN \'low\' THEN 3 END, t.created_at DESC';

    const tasks = sqlite.prepare(query).all(...params) as any[];

    // Enrich parent tasks with subtask summaries (Spec #56 Phase 2 — single aggregate query)
    const subtaskRows = sqlite.prepare(
      `SELECT parent_task_id, status, COUNT(*) as cnt FROM tasks WHERE parent_task_id IS NOT NULL AND status != 'deleted' GROUP BY parent_task_id, status`
    ).all() as { parent_task_id: number; status: string; cnt: number }[];
    const subtaskMap: Record<number, any> = {};
    for (const r of subtaskRows) {
      if (!subtaskMap[r.parent_task_id]) subtaskMap[r.parent_task_id] = { count: 0, done: 0, in_progress: 0, todo: 0, blocked: 0, in_review: 0, backlog: 0, cancelled: 0 };
      const s = subtaskMap[r.parent_task_id];
      if (r.status in s && r.status !== 'count') s[r.status] = r.cnt;
      s.count += r.cnt;
    }
    for (const task of tasks) {
      if (subtaskMap[task.id]) task.subtasks = subtaskMap[task.id];
    }

    const columns: Record<string, any[]> = {
      backlog: [], todo: [], in_progress: [], in_review: [], done: [], blocked: [], cancelled: [],
    };
    for (const task of tasks) {
      if (columns[task.status]) columns[task.status].push(task);
    }
    // Done column: sort by updated_at DESC (most recently completed first)
    columns.done.sort((a: any, b: any) => (b.updated_at || '').localeCompare(a.updated_at || ''));

    const projectStatus = c.req.query('status');
    let projectQuery = "SELECT * FROM projects";
    const projectParams: any[] = [];
    if (projectStatus) {
      projectQuery += " WHERE status = ?";
      projectParams.push(projectStatus);
    }
    projectQuery += " ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'paused' THEN 1 WHEN 'completed' THEN 2 END, name";
    const projects = sqlite.prepare(projectQuery).all(...projectParams) as any[];

    return c.json({ columns, projects, total: tasks.length });
  });

}
