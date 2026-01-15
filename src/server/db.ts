/**
 * Oracle v2 Database Configuration
 */

import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

// ES Module compatibility for __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
export const PORT = process.env.ORACLE_PORT || 47778;
export const HOME_DIR = process.env.HOME || process.env.USERPROFILE || '/tmp';
export const ORACLE_DATA_DIR = process.env.ORACLE_DATA_DIR || path.join(HOME_DIR, '.oracle-v2');
export const DB_PATH = process.env.ORACLE_DB_PATH || path.join(ORACLE_DATA_DIR, 'oracle.db');
export const UI_PATH = path.join(__dirname, '..', 'ui.html');
export const DASHBOARD_PATH = path.join(__dirname, '..', 'dashboard.html');
export const ARTHUR_UI_PATH = path.join(__dirname, '..', 'arthur.html');

// REPO_ROOT for features that need knowledge base context
// Defaults to ~/.oracle-v2 for bunx installs, or set via ORACLE_REPO_ROOT
export const REPO_ROOT = process.env.ORACLE_REPO_ROOT || ORACLE_DATA_DIR;

// Ensure data directory exists (for fresh installs via bunx)
if (!fs.existsSync(ORACLE_DATA_DIR)) {
  fs.mkdirSync(ORACLE_DATA_DIR, { recursive: true });
}

// Initialize database connection
export const db = new Database(DB_PATH);

/**
 * Initialize logging tables
 */
export function initLoggingTables() {
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

  // Consult log
  db.exec(`
    CREATE TABLE IF NOT EXISTS consult_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      decision TEXT NOT NULL,
      context TEXT,
      principles_found INTEGER,
      patterns_found INTEGER,
      guidance TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consult_created ON consult_log(created_at)`);

  // Add project column to logging tables (migration)
  // SQLite doesn't have IF NOT EXISTS for columns, so use try/catch
  const tables = ['search_log', 'learn_log', 'document_access', 'consult_log'];
  for (const table of tables) {
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN project TEXT`);
    } catch {
      // Column already exists, ignore
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_search_project ON search_log(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_learn_project ON learn_log(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_access_project ON document_access(project)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_consult_project ON consult_log(project)`);
}

/**
 * Close database connection
 */
export function closeDb() {
  db.close();
}
