# Drizzle ORM + FTS5 Boundary Pattern

**Date**: 2026-01-30
**Context**: Oracle v2 Drizzle migration
**Confidence**: High

## Key Learning

When migrating a codebase from raw SQL to Drizzle ORM, you will encounter operations that **cannot** be migrated because Drizzle doesn't support SQLite FTS5 virtual tables. The solution is to maintain a clean boundary: use `db` (Drizzle instance) for standard table operations and `sqlite` (raw bun:sqlite connection) for FTS5 operations.

This pattern requires:
1. Exporting both `db` and `sqlite` from your database module
2. Importing both in files that need FTS operations
3. Adding clear comments explaining why certain operations stay raw

## The Pattern

```typescript
// db/index.ts - Export both connections
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema.js';

const sqlite = new Database(DB_PATH);
export const db = drizzle(sqlite, { schema });
export { sqlite };  // For FTS5 operations
```

```typescript
// handlers.ts - Use both as needed
import { eq, desc, sql } from 'drizzle-orm';
import { db, sqlite, oracleDocuments } from '../db/index.js';

// Drizzle for standard operations
const doc = db.select()
  .from(oracleDocuments)
  .where(eq(oracleDocuments.id, id))
  .get();

// Raw SQL for FTS5 MATCH queries (Drizzle doesn't support virtual tables)
const results = sqlite.prepare(`
  SELECT f.id, f.content, d.type
  FROM oracle_fts f
  JOIN oracle_documents d ON f.id = d.id
  WHERE oracle_fts MATCH ?
`).all(query);
```

## Why This Matters

- **Type safety where possible**: 90%+ of queries get Drizzle's type inference
- **Functionality preserved**: FTS5 full-text search continues to work
- **Clear mental model**: Developers know immediately which queries need raw SQL
- **Incremental migration**: Can migrate file-by-file without all-or-nothing commitment
- **Future-proof**: If Drizzle ever supports FTS5, migration path is clear

## Related Patterns

- Use `inArray()` from drizzle-orm for dynamic IN clauses (replaces manual placeholder generation)
- Use `sql<number>\`count(*)\`` for aggregate functions
- Use `sql\`RANDOM()\`` for ORDER BY RANDOM()

## Tags

`drizzle`, `orm`, `sqlite`, `fts5`, `migration`, `typescript`, `pattern`
