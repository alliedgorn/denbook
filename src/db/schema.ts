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

// Note: FTS5 virtual table (oracle_fts) is managed via raw SQL
// since Drizzle doesn't natively support FTS5
