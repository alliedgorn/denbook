import { defineConfig } from 'drizzle-kit';
import path from 'path';

// Default to the main oracle.db location
const REPO_ROOT = process.env.ORACLE_REPO_ROOT || '/Users/nat/Code/github.com/laris-co/Nat-s-Agents';
const DB_PATH = path.join(REPO_ROOT, 'ψ/lab/oracle-v2/oracle.db');

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: DB_PATH,
  },
  // Exclude FTS5 internal tables (managed by SQLite, not Drizzle)
  tablesFilter: [
    'oracle_documents',
    'indexing_status',
    'search_log',
    'consult_log',
    'learn_log',
    'document_access',
  ],
});
