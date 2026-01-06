/**
 * Oracle Decision Handler
 *
 * CRUD operations for structured decision tracking.
 * Following the same patterns as forum/handler.ts
 */

import { db } from '../server/db.js';
import { getProjectContext } from '../server/context.js';
import type {
  Decision,
  DecisionStatus,
  DecisionOption,
  CreateDecisionInput,
  UpdateDecisionInput,
  ListDecisionsInput,
  ListDecisionsOutput,
} from './types.js';
import { isValidTransition } from './types.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get project context from environment (ghq path detection)
 */
function getProjectContext_(): string | undefined {
  const projectCtx = getProjectContext(process.cwd());
  return projectCtx && 'repo' in projectCtx ? projectCtx.repo : undefined;
}

/**
 * Parse a row from the database into a Decision object
 */
function parseDecisionRow(row: any): Decision {
  return {
    id: row.id,
    title: row.title,
    status: row.status as DecisionStatus,
    context: row.context,
    options: row.options ? JSON.parse(row.options) : null,
    decision: row.decision,
    rationale: row.rationale,
    project: row.project,
    tags: row.tags ? JSON.parse(row.tags) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}

// ============================================================================
// CRUD Operations
// ============================================================================

/**
 * Create a new decision
 */
export function createDecision(input: CreateDecisionInput): Decision {
  const now = Date.now();
  const project = input.project || getProjectContext_();

  const result = db.prepare(`
    INSERT INTO decisions (title, context, options, project, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.title,
    input.context || null,
    input.options ? JSON.stringify(input.options) : null,
    project || null,
    input.tags ? JSON.stringify(input.tags) : null,
    now,
    now
  );

  return {
    id: result.lastInsertRowid as number,
    title: input.title,
    status: 'pending',
    context: input.context || null,
    options: input.options || null,
    decision: null,
    rationale: null,
    project: project || null,
    tags: input.tags || null,
    createdAt: now,
    updatedAt: now,
    decidedAt: null,
    decidedBy: null,
  };
}

/**
 * Get decision by ID
 */
export function getDecision(id: number): Decision | null {
  const row = db.prepare(`
    SELECT * FROM decisions WHERE id = ?
  `).get(id) as any;

  if (!row) return null;
  return parseDecisionRow(row);
}

/**
 * Update a decision
 */
export function updateDecision(input: UpdateDecisionInput): Decision | null {
  const existing = getDecision(input.id);
  if (!existing) return null;

  const now = Date.now();
  const updates: string[] = ['updated_at = ?'];
  const params: any[] = [now];

  if (input.title !== undefined) {
    updates.push('title = ?');
    params.push(input.title);
  }
  if (input.context !== undefined) {
    updates.push('context = ?');
    params.push(input.context);
  }
  if (input.options !== undefined) {
    updates.push('options = ?');
    params.push(JSON.stringify(input.options));
  }
  if (input.decision !== undefined) {
    updates.push('decision = ?');
    params.push(input.decision);
  }
  if (input.rationale !== undefined) {
    updates.push('rationale = ?');
    params.push(input.rationale);
  }
  if (input.tags !== undefined) {
    updates.push('tags = ?');
    params.push(JSON.stringify(input.tags));
  }
  if (input.status !== undefined) {
    // Validate transition
    if (!isValidTransition(existing.status, input.status)) {
      throw new Error(
        `Invalid status transition: ${existing.status} → ${input.status}`
      );
    }
    updates.push('status = ?');
    params.push(input.status);

    // Set decidedAt when transitioning to 'decided'
    if (input.status === 'decided' && existing.status !== 'decided') {
      updates.push('decided_at = ?');
      params.push(now);
      if (input.decidedBy) {
        updates.push('decided_by = ?');
        params.push(input.decidedBy);
      }
    }
  }

  params.push(input.id);

  db.prepare(`
    UPDATE decisions SET ${updates.join(', ')} WHERE id = ?
  `).run(...params);

  return getDecision(input.id);
}

/**
 * Transition decision status with validation
 */
export function transitionStatus(
  id: number,
  newStatus: DecisionStatus,
  decidedBy?: string
): Decision | null {
  const existing = getDecision(id);
  if (!existing) return null;

  if (!isValidTransition(existing.status, newStatus)) {
    throw new Error(
      `Invalid status transition: ${existing.status} → ${newStatus}`
    );
  }

  const now = Date.now();
  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const params: any[] = [newStatus, now];

  // Set decidedAt when transitioning to 'decided'
  if (newStatus === 'decided' && existing.status !== 'decided') {
    updates.push('decided_at = ?');
    params.push(now);
    if (decidedBy) {
      updates.push('decided_by = ?');
      params.push(decidedBy);
    }
  }

  params.push(id);

  db.prepare(`
    UPDATE decisions SET ${updates.join(', ')} WHERE id = ?
  `).run(...params);

  return getDecision(id);
}

/**
 * List decisions with optional filters
 */
export function listDecisions(
  options: ListDecisionsInput = {}
): ListDecisionsOutput {
  const { status, project, tags, limit = 20, offset = 0 } = options;

  let whereClause = '1=1';
  const params: any[] = [];

  if (status) {
    whereClause += ' AND status = ?';
    params.push(status);
  }
  if (project) {
    whereClause += ' AND project = ?';
    params.push(project);
  }
  if (tags && tags.length > 0) {
    // Match any of the provided tags (using LIKE for JSON array)
    const tagConditions = tags.map(() => "tags LIKE ?").join(' OR ');
    whereClause += ` AND (${tagConditions})`;
    tags.forEach(tag => params.push(`%"${tag}"%`));
  }

  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM decisions WHERE ${whereClause}
  `).get(...params) as { total: number };

  const rows = db.prepare(`
    SELECT * FROM decisions
    WHERE ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  return {
    decisions: rows.map(parseDecisionRow),
    total: countRow.total,
  };
}

/**
 * Delete a decision (soft delete by setting status to closed)
 */
export function deleteDecision(id: number): boolean {
  const existing = getDecision(id);
  if (!existing) return false;

  db.prepare(`
    UPDATE decisions SET status = 'closed', updated_at = ? WHERE id = ?
  `).run(Date.now(), id);

  return true;
}

/**
 * Get decisions by status counts (for dashboard)
 */
export function getDecisionCounts(): Record<DecisionStatus, number> {
  const rows = db.prepare(`
    SELECT status, COUNT(*) as count FROM decisions GROUP BY status
  `).all() as { status: DecisionStatus; count: number }[];

  const counts: Record<DecisionStatus, number> = {
    pending: 0,
    parked: 0,
    researching: 0,
    decided: 0,
    implemented: 0,
    closed: 0,
  };

  for (const row of rows) {
    counts[row.status] = row.count;
  }

  return counts;
}
