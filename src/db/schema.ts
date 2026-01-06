/**
 * Oracle v2 Database Schema (Drizzle ORM)
 *
 * Generated from existing database via drizzle-kit pull,
 * then cleaned up to exclude FTS5 internal tables.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

// Main document index table
export const oracleDocuments = sqliteTable('oracle_documents', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  sourceFile: text('source_file').notNull(),
  concepts: text('concepts').notNull(), // JSON array
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  indexedAt: integer('indexed_at').notNull(),
}, (table) => [
  index('idx_source').on(table.sourceFile),
  index('idx_type').on(table.type),
]);

// Indexing status tracking
export const indexingStatus = sqliteTable('indexing_status', {
  id: integer('id').primaryKey(),
  isIndexing: integer('is_indexing').default(0).notNull(),
  progressCurrent: integer('progress_current').default(0),
  progressTotal: integer('progress_total').default(0),
  startedAt: integer('started_at'),
  completedAt: integer('completed_at'),
  error: text('error'),
});

// Search query logging
export const searchLog = sqliteTable('search_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  query: text('query').notNull(),
  type: text('type'),
  mode: text('mode'),
  resultsCount: integer('results_count'),
  searchTimeMs: integer('search_time_ms'),
  createdAt: integer('created_at').notNull(),
  project: text('project'),
}, (table) => [
  index('idx_search_project').on(table.project),
  index('idx_search_created').on(table.createdAt),
]);

// Consultation logging
export const consultLog = sqliteTable('consult_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  decision: text('decision').notNull(),
  context: text('context'),
  principlesFound: integer('principles_found').notNull(),
  patternsFound: integer('patterns_found').notNull(),
  guidance: text('guidance').notNull(),
  createdAt: integer('created_at').notNull(),
  project: text('project'),
}, (table) => [
  index('idx_consult_project').on(table.project),
  index('idx_consult_created').on(table.createdAt),
]);

// Learning/pattern logging
export const learnLog = sqliteTable('learn_log', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  documentId: text('document_id').notNull(),
  patternPreview: text('pattern_preview'),
  source: text('source'),
  concepts: text('concepts'), // JSON array
  createdAt: integer('created_at').notNull(),
  project: text('project'),
}, (table) => [
  index('idx_learn_project').on(table.project),
  index('idx_learn_created').on(table.createdAt),
]);

// Document access logging
export const documentAccess = sqliteTable('document_access', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  documentId: text('document_id').notNull(),
  accessType: text('access_type'),
  createdAt: integer('created_at').notNull(),
  project: text('project'),
}, (table) => [
  index('idx_access_project').on(table.project),
  index('idx_access_created').on(table.createdAt),
  index('idx_access_doc').on(table.documentId),
]);

// ============================================================================
// Forum Tables (threaded discussions with Oracle)
// ============================================================================

// Forum threads - conversation topics
export const forumThreads = sqliteTable('forum_threads', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  createdBy: text('created_by').default('human'),
  status: text('status').default('active'), // active, answered, pending, closed
  issueUrl: text('issue_url'),              // GitHub mirror URL
  issueNumber: integer('issue_number'),
  project: text('project'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  syncedAt: integer('synced_at'),
}, (table) => [
  index('idx_thread_status').on(table.status),
  index('idx_thread_project').on(table.project),
  index('idx_thread_created').on(table.createdAt),
]);

// Forum messages - individual Q&A in threads
export const forumMessages = sqliteTable('forum_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  threadId: integer('thread_id').notNull().references(() => forumThreads.id),
  role: text('role').notNull(),             // human, oracle, claude
  content: text('content').notNull(),
  author: text('author'),                   // GitHub username or "oracle"
  principlesFound: integer('principles_found'),
  patternsFound: integer('patterns_found'),
  searchQuery: text('search_query'),
  commentId: integer('comment_id'),         // GitHub comment ID if synced
  createdAt: integer('created_at').notNull(),
}, (table) => [
  index('idx_message_thread').on(table.threadId),
  index('idx_message_role').on(table.role),
  index('idx_message_created').on(table.createdAt),
]);

// Note: FTS5 virtual table (oracle_fts) is managed via raw SQL
// since Drizzle doesn't natively support FTS5

// ============================================================================
// Decision Tracking Tables
// ============================================================================

// Decisions - structured decision tracking with lifecycle
export const decisions = sqliteTable('decisions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  status: text('status').default('pending').notNull(), // pending, parked, researching, decided, implemented, closed
  context: text('context'),                            // Why this decision matters
  options: text('options'),                            // JSON: [{label, pros, cons}]
  decision: text('decision'),                          // What was decided
  rationale: text('rationale'),                        // Why this choice
  project: text('project'),                            // ghq path (optional)
  tags: text('tags'),                                  // JSON array
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  decidedAt: integer('decided_at'),                    // When status → decided
  decidedBy: text('decided_by'),                       // user or model name
}, (table) => [
  index('idx_decisions_status').on(table.status),
  index('idx_decisions_project').on(table.project),
  index('idx_decisions_created').on(table.createdAt),
]);
