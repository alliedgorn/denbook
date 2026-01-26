# Handoff: Indexer Backup + Merge

**Date**: 2026-01-26 08:50 GMT+7
**Context**: ~60%

## What We Did

- Fixed Bug #4 (DocDetail truncation) - pushed
- Added backup before indexer clear (Nothing is Deleted)
- Added JSON + CSV export for DuckDB compatibility
- Fixed schema to include `project` column
- Restored oracle.db from Time Machine backup (9,082 docs)
- Re-indexed Nat-s-Agents to oracle-new.db (10,736 docs)
- **Merged both** → 10,876 docs (best of both worlds)
  - Kept MCP learnings from restored
  - Added new files from fresh index

## Key Numbers

| Type | Count |
|------|-------|
| retro | 5,464 |
| learning | 5,015 |
| principle | 397 |
| **Total** | **10,876** |

## Commits Pushed

- `bf5ac9a` - fix: backup database before clearing
- `097fa96` - feat: add CSV export for DuckDB
- `ee6378e` - fix: add project column to schema

## Pending

- [ ] Untracked files in repo (docs, learnings, resonance)
- [ ] MCP needs restart (disk I/O error on stale connection)

## Next Session

- [ ] Restart Claude Code to fix MCP
- [ ] Test oracle_search via MCP
- [ ] Commit untracked files if needed
- [ ] Consider adding `--append` flag to indexer CLI

## Key Files

- `~/.oracle-v2/oracle.db` - merged db (10,876 docs)
- `~/.oracle-v2/oracle-new.db` - fresh index (can delete)
- `src/indexer.ts` - backup + CSV export added
