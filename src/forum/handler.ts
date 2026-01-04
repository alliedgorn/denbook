/**
 * Oracle Forum Handler
 *
 * DB-first threaded discussions with Oracle.
 * - Create threads, add messages
 * - Oracle auto-responds from knowledge base
 * - Logs unanswered questions for later
 */

import { db } from '../server/db.js';
import { handleConsult } from '../server/handlers.js';
import { getProjectContext } from '../server/context.js';
import type {
  ForumThread,
  ForumMessage,
  ThreadStatus,
  MessageRole,
  OracleThreadInput,
  OracleThreadOutput,
} from './types.js';

/**
 * Get project context from environment (ghq path detection)
 */
function getProjectContext_(): string | undefined {
  const projectCtx = getProjectContext(process.cwd());
  return projectCtx && 'repo' in projectCtx ? projectCtx.repo : undefined;
}

// ============================================================================
// Thread Operations
// ============================================================================

/**
 * Create a new thread
 */
export function createThread(
  title: string,
  createdBy: string = 'user',
  project?: string
): ForumThread {
  const now = Date.now();

  const result = db.prepare(`
    INSERT INTO forum_threads (title, created_by, status, project, created_at, updated_at)
    VALUES (?, ?, 'active', ?, ?, ?)
  `).run(title, createdBy, project || null, now, now);

  return {
    id: result.lastInsertRowid as number,
    title,
    createdBy,
    status: 'active',
    project,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Get thread by ID
 */
export function getThread(threadId: number): ForumThread | null {
  const row = db.prepare(`
    SELECT * FROM forum_threads WHERE id = ?
  `).get(threadId) as any;

  if (!row) return null;

  return {
    id: row.id,
    title: row.title,
    createdBy: row.created_by,
    status: row.status,
    issueUrl: row.issue_url,
    issueNumber: row.issue_number,
    project: row.project,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    syncedAt: row.synced_at,
  };
}

/**
 * Update thread status
 */
export function updateThreadStatus(threadId: number, status: ThreadStatus): void {
  db.prepare(`
    UPDATE forum_threads SET status = ?, updated_at = ? WHERE id = ?
  `).run(status, Date.now(), threadId);
}

/**
 * List threads with optional filters
 */
export function listThreads(options: {
  status?: ThreadStatus;
  project?: string;
  limit?: number;
  offset?: number;
} = {}): { threads: ForumThread[]; total: number } {
  const { status, project, limit = 20, offset = 0 } = options;

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

  const countRow = db.prepare(`
    SELECT COUNT(*) as total FROM forum_threads WHERE ${whereClause}
  `).get(...params) as { total: number };

  const rows = db.prepare(`
    SELECT * FROM forum_threads
    WHERE ${whereClause}
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as any[];

  return {
    threads: rows.map(row => ({
      id: row.id,
      title: row.title,
      createdBy: row.created_by,
      status: row.status,
      issueUrl: row.issue_url,
      issueNumber: row.issue_number,
      project: row.project,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      syncedAt: row.synced_at,
    })),
    total: countRow.total,
  };
}

// ============================================================================
// Message Operations
// ============================================================================

/**
 * Add a message to a thread
 */
export function addMessage(
  threadId: number,
  role: MessageRole,
  content: string,
  options: {
    author?: string;
    principlesFound?: number;
    patternsFound?: number;
    searchQuery?: string;
  } = {}
): ForumMessage {
  const now = Date.now();

  const result = db.prepare(`
    INSERT INTO forum_messages
    (thread_id, role, content, author, principles_found, patterns_found, search_query, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    threadId,
    role,
    content,
    options.author || null,
    options.principlesFound || null,
    options.patternsFound || null,
    options.searchQuery || null,
    now
  );

  // Update thread timestamp
  db.prepare(`
    UPDATE forum_threads SET updated_at = ? WHERE id = ?
  `).run(now, threadId);

  return {
    id: result.lastInsertRowid as number,
    threadId,
    role,
    content,
    author: options.author,
    principlesFound: options.principlesFound,
    patternsFound: options.patternsFound,
    searchQuery: options.searchQuery,
    createdAt: now,
  };
}

/**
 * Get messages for a thread
 */
export function getMessages(threadId: number): ForumMessage[] {
  const rows = db.prepare(`
    SELECT * FROM forum_messages WHERE thread_id = ? ORDER BY created_at ASC
  `).all(threadId) as any[];

  return rows.map(row => ({
    id: row.id,
    threadId: row.thread_id,
    role: row.role,
    content: row.content,
    author: row.author,
    principlesFound: row.principles_found,
    patternsFound: row.patterns_found,
    searchQuery: row.search_query,
    commentId: row.comment_id,
    createdAt: row.created_at,
  }));
}

// ============================================================================
// Oracle Auto-Response
// ============================================================================

/**
 * Generate Oracle response for a question
 * Uses existing handleConsult logic
 */
export async function generateOracleResponse(
  question: string,
  context?: string
): Promise<{
  response: string;
  principlesFound: number;
  patternsFound: number;
} | null> {
  try {
    const result = await handleConsult(question, context);

    if (result.principles.length === 0 && result.patterns.length === 0) {
      // No relevant knowledge found
      return null;
    }

    return {
      response: result.guidance,
      principlesFound: result.principles.length,
      patternsFound: result.patterns.length,
    };
  } catch (error) {
    console.error('Oracle response failed:', error);
    return null;
  }
}

// ============================================================================
// Main Thread API (MCP Tool Interface)
// ============================================================================

/**
 * Main entry point: Send message to thread, Oracle auto-responds
 */
export async function handleThreadMessage(
  input: OracleThreadInput
): Promise<OracleThreadOutput> {
  const { message, threadId, title, role = 'human', model } = input;

  // Get project context
  const project = getProjectContext_();

  // Determine author based on role and model
  // - role='human' (HTTP) -> author='user'
  // - role='claude' (MCP) -> author='opus'/'sonnet'/'claude' + project
  let author: string;
  if (role === 'human') {
    author = 'user';
  } else {
    // Use model name if provided (opus, sonnet), else 'claude'
    author = model || 'claude';
  }

  // Add project context if available
  if (project) {
    author = `${author}@${project}`;
  }

  let thread: ForumThread;

  // Create or get thread
  if (threadId) {
    const existing = getThread(threadId);
    if (!existing) {
      throw new Error(`Thread ${threadId} not found`);
    }
    thread = existing;
  } else {
    // New thread - use title or first 50 chars of message
    const threadTitle = title || message.slice(0, 50) + (message.length > 50 ? '...' : '');
    thread = createThread(threadTitle, author, project);
  }

  // Add the user's message
  const userMessage = addMessage(thread.id, role, message, {
    author,
  });

  // Try to generate Oracle response (for any question)
  let oracleResponse: OracleThreadOutput['oracleResponse'];

  if (role === 'human' || role === 'claude') {
    const response = await generateOracleResponse(message);

    if (response) {
      // Oracle has an answer
      addMessage(thread.id, 'oracle', response.response, {
        author: 'oracle',
        principlesFound: response.principlesFound,
        patternsFound: response.patternsFound,
        searchQuery: message,
      });

      oracleResponse = {
        content: response.response,
        principlesFound: response.principlesFound,
        patternsFound: response.patternsFound,
      };

      updateThreadStatus(thread.id, 'answered');
    } else {
      // No answer - mark as pending for later
      updateThreadStatus(thread.id, 'pending');
    }
  }

  // Get updated thread status
  const updatedThread = getThread(thread.id)!;

  return {
    threadId: thread.id,
    messageId: userMessage.id,
    oracleResponse,
    status: updatedThread.status as ThreadStatus,
    issueUrl: updatedThread.issueUrl,
  };
}

/**
 * Get full thread with all messages
 */
export function getFullThread(threadId: number): {
  thread: ForumThread;
  messages: ForumMessage[];
} | null {
  const thread = getThread(threadId);
  if (!thread) return null;

  const messages = getMessages(threadId);
  return { thread, messages };
}
